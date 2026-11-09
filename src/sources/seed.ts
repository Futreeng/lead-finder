/**
 * Seed list: a CSV of firms you found yourself (for example by browsing Google Maps or a bar
 * association's public search by hand). Needs a "Firm" column; "Website", "Phone" and "Address"
 * are optional but the website is what lets the tool check a firm.
 */
import { parseCsv } from "../csv.js";
import type { Candidate } from "../types.js";

export function parseSeed(text: string, label: string): { candidates: Candidate[]; warnings: string[] } {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  if (rows.length === 0) return { candidates: [], warnings: [`${label}: file is empty`] };

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iFirm = col("firm", "firm name", "name", "law firm");
  const iWeb = col("website", "url", "site", "web");
  const iPhone = col("phone", "telephone", "phone number");
  const iAddr = col("address", "location");

  if (iFirm < 0) {
    return { candidates: [], warnings: [`${label}: needs a header row with a "Firm" column`] };
  }
  if (iWeb < 0) warnings.push(`${label}: no "Website" column, so no firm in it can be checked`);

  const candidates: Candidate[] = [];
  rows.slice(1).forEach((r, i) => {
    const firm = (r[iFirm] ?? "").trim();
    if (!firm) {
      warnings.push(`${label}: row ${i + 2} has no firm name, skipped`);
      return;
    }
    const pick = (idx: number) => (idx >= 0 ? (r[idx] ?? "").trim() || undefined : undefined);
    candidates.push({
      firm,
      website: pick(iWeb),
      phone: pick(iPhone),
      address: pick(iAddr),
      source: `seed: ${label}`,
    });
  });
  return { candidates, warnings };
}
