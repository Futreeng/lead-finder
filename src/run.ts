import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { AGENT_TOKEN, MIN_DELAY_MS, defaultSettings, type Settings } from "./config.js";
import { toCsv } from "./csv.js";
import { enrichCandidate } from "./enrich.js";
import { applyExclusions, decide, dedupe, parseExclusions } from "./filter.js";
import { PoliteFetcher, type Fetcher } from "./http.js";
import { StoppedError, assertNotStopped, stopReason, type StopOptions } from "./killswitch.js";
import { DEFAULT_OVERPASS_URL, fetchOsmCandidates, parseNear } from "./sources/osm.js";
import { parseSeed } from "./sources/seed.js";
import { PROSPECT_HEADER, SKIPPED_HEADER, toProspectRow, toSkippedRow } from "./tracker.js";
import type { Candidate } from "./types.js";

export const USAGE = `lead-finder: builds a prospect list of small estate planning law firms for human review.
It only reads public web pages. It never sends emails, fills in forms, or contacts anyone.

Usage:
  node dist/src/cli.js --seed <file.csv> [options]
  node dist/src/cli.js --near <lat,lon> [--radius-km 15] [options]

Sources (use one or both):
  --seed <file.csv>        CSV of firms you found by hand. Needs a "Firm" column; "Website" lets the tool check it.
  --near <lat,lon>         Also look up law offices on OpenStreetMap around this point.
  --radius-km <n>          Radius for --near in km, up to 50. Default 15.

Options:
  --exclude <file>         Skip these firms: a tracker CSV export or a list of websites. Repeatable.
  --limit <n>              Check at most n firms this run.
  --dry-run                Check sites and print results, but write no files.
  --out <folder>           Where to write CSV files. Default: output
  --delay-ms <n>           Wait between requests to the same site. Default 2000, minimum ${MIN_DELAY_MS}.
  --min-attorneys <n>      Default 2.
  --max-attorneys <n>      Default 10.
  --keywords "<a,b,c>"     Practice keywords to look for. Default: estate planning terms.
  --include-unmatched      Keep firms even if no practice keyword is found on their site.
  --help                   Show this help.

Off switch: create a file named STOP in this folder, or set LEAD_FINDER_DISABLED=1.
The tool will not start, and a running job stops before its next web request.`;

export interface RunArgs {
  seed?: string;
  near?: string;
  radiusKm: number;
  exclude: string[];
  limit?: number;
  dryRun: boolean;
  out: string;
  delayMs?: number;
  minAttorneys?: number;
  maxAttorneys?: number;
  keywords?: string[];
  includeUnmatched: boolean;
  help: boolean;
}

export class UsageError extends Error {}

function needValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
  return v;
}

function toInt(v: string, flag: string, min: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag} must be a whole number of at least ${min}; got "${v}"`);
  return n;
}

export function parseArgs(argv: string[]): RunArgs {
  const a: RunArgs = { radiusKm: 15, exclude: [], dryRun: false, out: "output", includeUnmatched: false, help: false };
  const expanded = argv.flatMap((x) => (x.startsWith("--") && x.includes("=") ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : [x]));
  for (let i = 0; i < expanded.length; i++) {
    const flag = expanded[i] ?? "";
    switch (flag) {
      case "--help":
      case "-h":
        a.help = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--include-unmatched":
        a.includeUnmatched = true;
        break;
      case "--seed":
        a.seed = needValue(expanded, i++, flag);
        break;
      case "--near":
        a.near = needValue(expanded, i++, flag);
        break;
      case "--radius-km":
        a.radiusKm = Number(needValue(expanded, i++, flag));
        break;
      case "--exclude":
        a.exclude.push(needValue(expanded, i++, flag));
        break;
      case "--limit":
        a.limit = toInt(needValue(expanded, i++, flag), flag, 1);
        break;
      case "--out":
        a.out = needValue(expanded, i++, flag);
        break;
      case "--delay-ms":
        a.delayMs = toInt(needValue(expanded, i++, flag), flag, MIN_DELAY_MS);
        break;
      case "--min-attorneys":
        a.minAttorneys = toInt(needValue(expanded, i++, flag), flag, 1);
        break;
      case "--max-attorneys":
        a.maxAttorneys = toInt(needValue(expanded, i++, flag), flag, 1);
        break;
      case "--keywords":
        a.keywords = needValue(expanded, i++, flag)
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        if (a.keywords.length === 0) throw new UsageError("--keywords needs at least one keyword");
        break;
      default:
        throw new UsageError(`Unknown option "${flag}". Run with --help to see the options.`);
    }
  }
  if (a.minAttorneys !== undefined && a.maxAttorneys !== undefined && a.minAttorneys > a.maxAttorneys) {
    throw new UsageError("--min-attorneys cannot be larger than --max-attorneys");
  }
  return a;
}

export interface RunDeps {
  log?: (line: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stop?: StopOptions;
  fetcher?: Fetcher;
  now?: () => Date;
}

export interface RunResult {
  exitCode: number;
  kept: string[][];
  skipped: string[][];
  files: string[];
  requests: number;
  stoppedBy?: string;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const stopOpts: StopOptions = deps.stop ?? { env };
  const result: RunResult = { exitCode: 0, kept: [], skipped: [], files: [], requests: 0 };

  let args: RunArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      log(`Error: ${err.message}`);
      result.exitCode = 1;
      return result;
    }
    throw err;
  }
  if (args.help) {
    log(USAGE);
    return result;
  }

  const stopped = stopReason(stopOpts);
  if (stopped) {
    log(`Off switch is on (${stopped}). Nothing was run.`);
    result.exitCode = 2;
    result.stoppedBy = stopped;
    return result;
  }
  if (!args.seed && !args.near) {
    log("Error: give --seed <file.csv>, --near <lat,lon>, or both. Run with --help for details.");
    result.exitCode = 1;
    return result;
  }

  const s: Settings = defaultSettings(env);
  if (args.delayMs !== undefined) s.delayMs = args.delayMs;
  if (args.minAttorneys !== undefined) s.minAttorneys = args.minAttorneys;
  if (args.maxAttorneys !== undefined) s.maxAttorneys = args.maxAttorneys;
  if (args.keywords) s.keywords = args.keywords;
  s.includeUnmatched = args.includeUnmatched;
  if (s.minAttorneys > s.maxAttorneys) {
    log(`Error: minimum attorneys (${s.minAttorneys}) is larger than maximum (${s.maxAttorneys}).`);
    result.exitCode = 1;
    return result;
  }
  const stopCheck = () => assertNotStopped(stopOpts);

  // 1. Gather candidates.
  let candidates: Candidate[] = [];
  if (args.seed) {
    const path = resolve(cwd, args.seed);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      log(`Error: could not read seed file ${path}`);
      result.exitCode = 1;
      return result;
    }
    const seed = parseSeed(text, basename(path));
    seed.warnings.forEach((w) => log(`Warning: ${w}`));
    log(`Seed list: ${seed.candidates.length} firm(s) from ${basename(path)}`);
    candidates.push(...seed.candidates);
  }
  if (args.near) {
    try {
      const near = parseNear(args.near, args.radiusKm);
      const endpoint = env.OVERPASS_URL?.trim() || DEFAULT_OVERPASS_URL;
      log(`OpenStreetMap: looking up law offices within ${near.radiusKm} km of ${near.lat},${near.lon} (one request to ${endpoint})`);
      const osm = await fetchOsmCandidates(near, { endpoint, userAgent: s.userAgent, timeoutMs: 90_000, stopCheck });
      log(`OpenStreetMap: ${osm.length} law office(s) with a name`);
      candidates.push(...osm);
    } catch (err) {
      if (err instanceof StoppedError) {
        log(err.message);
        result.exitCode = 2;
        result.stoppedBy = err.message;
        return result;
      }
      log(`OpenStreetMap lookup failed: ${(err as Error).message}`);
      if (!args.seed) {
        result.exitCode = 1;
        return result;
      }
      log("Continuing with the seed list only.");
    }
  }

  // 2. Remove repeats and excluded firms.
  const { kept: unique, duplicates } = dedupe(candidates);
  if (duplicates > 0) log(`Removed ${duplicates} repeat(s).`);
  const excludedKeys = new Set<string>();
  for (const ex of args.exclude) {
    const path = resolve(cwd, ex);
    try {
      parseExclusions(readFileSync(path, "utf8")).forEach((k) => excludedKeys.add(k));
    } catch {
      log(`Error: could not read exclude file ${path}. Stopping so no excluded firm is checked by mistake.`);
      result.exitCode = 1;
      return result;
    }
  }
  const { kept: toCheckAll, excluded } = applyExclusions(unique, excludedKeys);
  if (excluded.length > 0) log(`Skipped ${excluded.length} firm(s) on the exclude list (already in tracker or opted out).`);
  const toCheck = args.limit !== undefined ? toCheckAll.slice(0, args.limit) : toCheckAll;
  if (toCheck.length < toCheckAll.length) log(`--limit ${args.limit}: checking ${toCheck.length} of ${toCheckAll.length}.`);

  log(
    `Checking ${toCheck.length} firm website(s): up to ${s.maxPagesPerSite} pages each plus robots.txt, ` +
      `at least ${s.delayMs} ms between requests to the same site.`,
  );
  log("To stop at any time: create a file named STOP in this folder.");

  // 3. Check each firm's website.
  const fetcher =
    deps.fetcher ??
    new PoliteFetcher({
      userAgent: s.userAgent,
      agentToken: AGENT_TOKEN,
      delayMs: s.delayMs,
      timeoutMs: s.timeoutMs,
      maxBytes: s.maxBytes,
      stopCheck,
    });

  for (const [i, c] of toCheck.entries()) {
    log(`[${i + 1}/${toCheck.length}] ${c.firm}${c.website ? ` (${c.website})` : ""}`);
    try {
      const e = await enrichCandidate(c, fetcher, s);
      const d = decide(e, s);
      if (d.keep) result.kept.push(toProspectRow(e, d));
      else result.skipped.push(toSkippedRow(e, d));
      log(`    ${d.keep ? "KEEP" : "SKIP"}: ${d.reason}`);
    } catch (err) {
      if (err instanceof StoppedError) {
        result.stoppedBy = err.message;
        log(err.message);
        break;
      }
      throw err;
    }
  }
  if (fetcher instanceof PoliteFetcher) result.requests = fetcher.requestCount;

  // 4. Output.
  if (args.dryRun) {
    log("");
    log("Dry run: no files written.");
    for (const row of result.kept) {
      log(`  KEEP  ${row[0]} | attorneys: ${row[2] || "?"} | ${row[3] || "practice not confirmed"} | ${row[4]}`);
    }
  } else {
    const outDir = resolve(cwd, args.out);
    mkdirSync(outDir, { recursive: true });
    const suffix = `${stamp(deps.now?.() ?? new Date())}${result.stoppedBy ? "-partial" : ""}`;
    const prospects = resolve(outDir, `prospects-${suffix}.csv`);
    const skipped = resolve(outDir, `skipped-${suffix}.csv`);
    writeFileSync(prospects, toCsv([PROSPECT_HEADER, ...result.kept]), "utf8");
    writeFileSync(skipped, toCsv([SKIPPED_HEADER, ...result.skipped]), "utf8");
    result.files.push(prospects, skipped);
    log("");
    log(`Wrote ${prospects}`);
    log(`Wrote ${skipped}`);
  }

  log(
    `Done: ${result.kept.length} kept, ${result.skipped.length} skipped` +
      (result.requests ? `, ${result.requests} web request(s)` : "") +
      (result.stoppedBy ? " (stopped early by the off switch)" : "") +
      ".",
  );
  log("Nothing was sent to anyone. A person must review every row before any outreach.");
  result.exitCode = result.stoppedBy ? 2 : 0;
  return result;
}
