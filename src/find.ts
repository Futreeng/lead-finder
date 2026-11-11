/**
 * The firm-finding pipeline shared by the command line tool and the app:
 * gather candidates (seed CSV and/or OpenStreetMap), drop repeats and excluded firms,
 * check each website politely, and decide keep or skip.
 */
import { AGENT_TOKEN, type Settings } from "./config.js";
import { enrichCandidate } from "./enrich.js";
import { applyExclusions, decide, dedupe } from "./filter.js";
import { PoliteFetcher, type Fetcher } from "./http.js";
import { StoppedError, assertNotStopped, type StopOptions } from "./killswitch.js";
import { DEFAULT_OVERPASS_URL, fetchOsmCandidates, type Near } from "./sources/osm.js";
import { parseSeed } from "./sources/seed.js";
import type { Candidate, Decision, Enriched } from "./types.js";

export interface FindOptions {
  seedText?: string;
  seedLabel?: string;
  near?: Near;
  overpassUrl?: string;
  /** Firm keys (domain or "name:...") that must never be checked. */
  exclude: Set<string>;
  limit?: number;
  settings: Settings;
  stopOpts: StopOptions;
  fetcher?: Fetcher;
  log: (line: string) => void;
}

export interface Checked {
  e: Enriched;
  d: Decision;
}

export interface FindResult {
  kept: Checked[];
  skipped: Checked[];
  excluded: Candidate[];
  duplicates: number;
  requests: number;
  stoppedBy?: string;
  /** Set when nothing could be gathered at all (for example the only source failed). */
  error?: string;
}

export async function findFirms(o: FindOptions): Promise<FindResult> {
  const result: FindResult = { kept: [], skipped: [], excluded: [], duplicates: 0, requests: 0 };
  const stopCheck = () => assertNotStopped(o.stopOpts);
  const s = o.settings;

  const candidates: Candidate[] = [];
  if (o.seedText !== undefined) {
    const label = o.seedLabel ?? "seed.csv";
    const seed = parseSeed(o.seedText, label);
    seed.warnings.forEach((w) => o.log(`Warning: ${w}`));
    o.log(`Seed list: ${seed.candidates.length} firm(s) from ${label}`);
    candidates.push(...seed.candidates);
  }
  if (o.near) {
    const endpoint = o.overpassUrl?.trim() || DEFAULT_OVERPASS_URL;
    try {
      o.log(
        `OpenStreetMap: looking up law offices within ${o.near.radiusKm} km of ${o.near.lat},${o.near.lon} (one request to ${endpoint})`,
      );
      const osm = await fetchOsmCandidates(o.near, { endpoint, userAgent: s.userAgent, timeoutMs: 90_000, stopCheck });
      o.log(`OpenStreetMap: ${osm.length} law office(s) with a name`);
      candidates.push(...osm);
    } catch (err) {
      if (err instanceof StoppedError) {
        o.log(err.message);
        result.stoppedBy = err.message;
        return result;
      }
      o.log(`OpenStreetMap lookup failed: ${(err as Error).message}`);
      if (o.seedText === undefined) {
        result.error = `OpenStreetMap lookup failed: ${(err as Error).message}`;
        return result;
      }
      o.log("Continuing with the seed list only.");
    }
  }

  const { kept: unique, duplicates } = dedupe(candidates);
  result.duplicates = duplicates;
  if (duplicates > 0) o.log(`Removed ${duplicates} repeat(s).`);
  const { kept: toCheckAll, excluded } = applyExclusions(unique, o.exclude);
  result.excluded = excluded;
  if (excluded.length > 0) {
    o.log(`Skipped ${excluded.length} firm(s) on the exclude list (already in tracker or opted out).`);
  }
  const toCheck = o.limit !== undefined ? toCheckAll.slice(0, o.limit) : toCheckAll;
  if (toCheck.length < toCheckAll.length) o.log(`--limit ${o.limit}: checking ${toCheck.length} of ${toCheckAll.length}.`);

  o.log(
    `Checking ${toCheck.length} firm website(s): up to ${s.maxPagesPerSite} pages each plus robots.txt, ` +
      `at least ${s.delayMs} ms between requests to the same site.`,
  );
  o.log("To stop at any time: create a file named STOP in this folder.");

  const fetcher =
    o.fetcher ??
    new PoliteFetcher({
      userAgent: s.userAgent,
      agentToken: AGENT_TOKEN,
      delayMs: s.delayMs,
      timeoutMs: s.timeoutMs,
      maxBytes: s.maxBytes,
      stopCheck,
    });

  for (const [i, c] of toCheck.entries()) {
    o.log(`[${i + 1}/${toCheck.length}] ${c.firm}${c.website ? ` (${c.website})` : ""}`);
    try {
      const e = await enrichCandidate(c, fetcher, s);
      const d = decide(e, s);
      (d.keep ? result.kept : result.skipped).push({ e, d });
      o.log(`    ${d.keep ? "KEEP" : "SKIP"}: ${d.reason}`);
    } catch (err) {
      if (err instanceof StoppedError) {
        result.stoppedBy = err.message;
        o.log(err.message);
        break;
      }
      throw err;
    }
  }
  if (fetcher instanceof PoliteFetcher) result.requests = fetcher.requestCount;
  return result;
}
