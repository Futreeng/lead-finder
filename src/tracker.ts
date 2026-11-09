import type { Decision, Enriched } from "./types.js";

/** Same columns, same order, as the prospect tracker in the client acquisition training packet. */
export const TRACKER_COLUMNS = [
  "Firm",
  "Contact",
  "Attorneys",
  "Practice area",
  "Website",
  "Status",
  "Last contact",
  "Next step and date",
  "Notes",
] as const;

/** Extra columns added after the tracker columns. */
export const EXTRA_COLUMNS = ["Phone", "Public email", "Source"] as const;

export const PROSPECT_HEADER: string[] = [...TRACKER_COLUMNS, ...EXTRA_COLUMNS];

export const SKIPPED_HEADER = ["Firm", "Website", "Reason", "Source"];

export const REVIEW_NOTE = "Found by lead-finder; a person must review before any contact";

export function toProspectRow(e: Enriched, d: Decision): string[] {
  const notes: string[] = [];
  if (e.attorneyCount === undefined || e.attorneyCountMayIncludeStaff) notes.push(d.reason);
  if (e.attorneyCountNote) notes.push(e.attorneyCountNote);
  if (e.practiceTerms.length === 0) notes.push("Practice area not confirmed on site");
  if (e.address) notes.push(`Address: ${e.address}`);
  notes.push(...e.notes, REVIEW_NOTE);

  return [
    e.firm,
    "",
    e.attorneyCount === undefined ? "" : String(e.attorneyCount),
    e.practiceTerms.join(", "),
    e.website ?? "",
    "Researched",
    "",
    "Human review, then first email",
    notes.join("; "),
    e.phone ?? "",
    e.publicEmail ?? "",
    e.source,
  ];
}

export function toSkippedRow(e: Enriched, d: Decision): string[] {
  return [e.firm, e.website ?? "", d.reason, e.source];
}
