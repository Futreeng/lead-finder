import type { Settings } from "./config.js";
import { parseCsv } from "./csv.js";
import type { Candidate, Decision, Enriched } from "./types.js";
import { domainOf, firmKey, normalizeWebsite } from "./urls.js";

/** Drops repeat firms (same website domain, or same name when there is no website). Fills gaps from repeats. */
export function dedupe(candidates: Candidate[]): { kept: Candidate[]; duplicates: number } {
  const byKey = new Map<string, Candidate>();
  let duplicates = 0;
  for (const c of candidates) {
    const key = firmKey(c.firm, c.website);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c });
      continue;
    }
    duplicates++;
    existing.phone ||= c.phone;
    existing.address ||= c.address;
    existing.website ||= c.website;
  }
  return { kept: [...byKey.values()], duplicates };
}

/**
 * Reads firms that must be skipped: opted-out firms and firms already in the tracker.
 * Accepts a tracker CSV export (uses its Website and Firm columns) or a plain list with
 * one website or domain per line.
 */
export function parseExclusions(text: string): Set<string> {
  const keys = new Set<string>();
  const rows = parseCsv(text);
  if (rows.length === 0) return keys;
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const iWeb = header.findIndex((h) => ["website", "url", "domain", "site"].includes(h));
  const iFirm = header.findIndex((h) => ["firm", "firm name", "name", "law firm"].includes(h));

  if (iWeb < 0 && iFirm < 0) {
    for (const r of rows) {
      const domain = domainOf(normalizeWebsite(r[0]));
      if (domain) keys.add(domain);
    }
    return keys;
  }
  for (const r of rows.slice(1)) {
    const website = iWeb >= 0 ? r[iWeb] : undefined;
    const firm = iFirm >= 0 ? (r[iFirm] ?? "").trim() : "";
    const domain = domainOf(normalizeWebsite(website));
    if (domain) keys.add(domain);
    if (firm) keys.add(firmKey(firm, undefined));
  }
  return keys;
}

export function applyExclusions(
  candidates: Candidate[],
  excluded: Set<string>,
): { kept: Candidate[]; excluded: Candidate[] } {
  const kept: Candidate[] = [];
  const out: Candidate[] = [];
  for (const c of candidates) {
    const byWebsite = firmKey(c.firm, c.website);
    const byName = firmKey(c.firm, undefined);
    if (excluded.has(byWebsite) || excluded.has(byName)) out.push(c);
    else kept.push(c);
  }
  return { kept, excluded: out };
}

export function decide(e: Enriched, s: Settings): Decision {
  if (!e.checked) {
    return { keep: false, reason: `Website not checked (${e.checkError ?? "unknown reason"}), research by hand` };
  }
  if (e.practiceTerms.length === 0 && !s.includeUnmatched) {
    return { keep: false, reason: "No estate planning keywords found on the pages checked" };
  }
  const n = e.attorneyCount;
  if (n !== undefined && n > s.maxAttorneys) {
    if (e.attorneyCountMayIncludeStaff) {
      return { keep: true, reason: `${n} people listed, may include staff, verify attorney count` };
    }
    return { keep: false, reason: `${n} attorneys detected, above ${s.maxAttorneys}` };
  }
  if (n !== undefined && n < s.minAttorneys) {
    return { keep: false, reason: `${n} attorney detected, below ${s.minAttorneys} (may be a solo practice)` };
  }
  if (n === undefined) return { keep: true, reason: "Attorney count unverified, check by hand" };
  return { keep: true, reason: "Practice and size match" };
}
