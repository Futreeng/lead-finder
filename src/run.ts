import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { MIN_DELAY_MS, defaultSettings, type Settings } from "./config.js";
import { toCsv } from "./csv.js";
import { parseExclusions } from "./filter.js";
import { findFirms } from "./find.js";
import type { Fetcher } from "./http.js";
import { stopReason, type StopOptions } from "./killswitch.js";
import { parseNear, type Near } from "./sources/osm.js";
import { PROSPECT_HEADER, SKIPPED_HEADER, toProspectRow, toSkippedRow } from "./tracker.js";

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
  // 1. Read every input file before touching the network.
  let seedText: string | undefined;
  let seedLabel: string | undefined;
  if (args.seed) {
    const path = resolve(cwd, args.seed);
    try {
      seedText = readFileSync(path, "utf8");
      seedLabel = basename(path);
    } catch {
      log(`Error: could not read seed file ${path}`);
      result.exitCode = 1;
      return result;
    }
  }
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
  let near: Near | undefined;
  if (args.near) {
    try {
      near = parseNear(args.near, args.radiusKm);
    } catch (err) {
      log(`Error: ${(err as Error).message}`);
      result.exitCode = 1;
      return result;
    }
  }

  // 2. Find, check and decide.
  const found = await findFirms({
    seedText,
    seedLabel,
    near,
    overpassUrl: env.OVERPASS_URL,
    exclude: excludedKeys,
    limit: args.limit,
    settings: s,
    stopOpts,
    fetcher: deps.fetcher,
    log,
  });
  if (found.error) {
    result.exitCode = 1;
    return result;
  }
  result.kept = found.kept.map(({ e, d }) => toProspectRow(e, d));
  result.skipped = found.skipped.map(({ e, d }) => toSkippedRow(e, d));
  result.requests = found.requests;
  result.stoppedBy = found.stoppedBy;
  if (found.stoppedBy && found.kept.length + found.skipped.length === 0) {
    result.exitCode = 2;
    return result;
  }

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
