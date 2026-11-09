export const TOOL_NAME = "FutreengLeadFinder";
export const VERSION = "0.1.0";

export interface Settings {
  minAttorneys: number;
  maxAttorneys: number;
  /** Minimum wait between two requests to the same website. */
  delayMs: number;
  timeoutMs: number;
  /** Largest page we will download, in bytes. Bigger pages are cut off. */
  maxBytes: number;
  /** Homepage plus at most this many other pages per firm. */
  maxPagesPerSite: number;
  userAgent: string;
  keywords: string[];
  /** Keep firms even when no practice keyword was found on their site. */
  includeUnmatched: boolean;
}

export const DEFAULT_KEYWORDS = [
  "estate planning",
  "estate plan",
  "estate administration",
  "wills",
  "living will",
  "trusts",
  "living trust",
  "revocable trust",
  "trust administration",
  "probate",
  "elder law",
  "power of attorney",
  "guardianship",
  "medicaid planning",
];

export const MIN_DELAY_MS = 500;

export function defaultSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const customAgent = env.LEAD_FINDER_USER_AGENT?.trim();
  return {
    minAttorneys: 2,
    maxAttorneys: 10,
    delayMs: 2000,
    timeoutMs: 15000,
    maxBytes: 2_000_000,
    maxPagesPerSite: 3,
    userAgent: customAgent || `${TOOL_NAME}/${VERSION} (research only; sends no messages)`,
    keywords: [...DEFAULT_KEYWORDS],
    includeUnmatched: false,
  };
}

/** The product token robots.txt rules are matched against. */
export const AGENT_TOKEN = TOOL_NAME;
