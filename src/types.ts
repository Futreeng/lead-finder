/** A firm we might want to look at, before its website has been checked. */
export interface Candidate {
  firm: string;
  website?: string;
  phone?: string;
  address?: string;
  /** Where this firm came from, e.g. "seed: seeds/akron.csv" or the OpenStreetMap credit line. */
  source: string;
}

/** A candidate after its public website has been checked. */
export interface Enriched extends Candidate {
  /** Host of the firm's site without "www.", used for de-duplication. */
  domain?: string;
  /** Practice keywords actually found on the pages checked. Empty means none found. */
  practiceTerms: string[];
  /** Attorney count detected from the site. Undefined means it could not be determined. */
  attorneyCount?: number;
  /** How the attorney count was found, so a person can check it. */
  attorneyCountNote?: string;
  /** True when the count came from a "team" or "people" page that may list non-attorney staff. */
  attorneyCountMayIncludeStaff?: boolean;
  /** First email address published on the firm's own site (mailto link), if any. */
  publicEmail?: string;
  /** True when at least the homepage could be read. */
  checked: boolean;
  /** Why the site could not be checked, when checked is false. */
  checkError?: string;
  notes: string[];
}

export interface Decision {
  keep: boolean;
  reason: string;
}
