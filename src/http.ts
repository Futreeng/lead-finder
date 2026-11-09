/**
 * A polite, read-only web fetcher.
 * - Checks the off switch before every request.
 * - Reads and obeys each site's robots.txt (RFC 9309) before fetching any page from it.
 * - Waits at least `delayMs` (or the site's Crawl-delay, if longer) between requests to the same site.
 * - Follows redirects itself so robots.txt is checked again on every new site.
 * - Only ever sends GET requests. It never submits forms or sends messages.
 */
import { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "./robots.js";
import { assertNotStopped } from "./killswitch.js";

export type FetchOutcome =
  | { ok: true; url: string; status: number; body: string; contentType: string }
  | { ok: false; url: string; reason: string };

export interface Fetcher {
  get(url: string): Promise<FetchOutcome>;
}

export interface PoliteFetcherOptions {
  userAgent: string;
  agentToken: string;
  delayMs: number;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** Cap on a site's Crawl-delay so one site cannot stall the run for minutes. */
  maxCrawlDelayMs?: number;
  stopCheck?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type RawResponse =
  | { status: number; body: string; contentType: string; location?: string }
  | { error: string };

const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,*/*;q=0.1";
const ROBOTS_ACCEPT = "text/plain,*/*;q=0.1";
const ROBOTS_UNREADABLE = "robots.txt could not be read (server or network error), skipped to be safe";

export class PoliteFetcher implements Fetcher {
  private readonly lastHit = new Map<string, number>();
  private readonly robots = new Map<string, RobotsRules | "unreadable">();
  private readonly crawlDelayMs = new Map<string, number>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Total HTTP requests sent, including robots.txt requests. */
  requestCount = 0;

  constructor(private readonly o: PoliteFetcherOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => Date.now());
  }

  async get(url: string): Promise<FetchOutcome> {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return { ok: false, url, reason: "not a valid web address" };
    }
    const maxRedirects = this.o.maxRedirects ?? 5;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        return { ok: false, url: current.href, reason: `unsupported address type ${current.protocol}` };
      }
      const allowed = await this.robotsAllows(current);
      if (allowed !== true) return { ok: false, url: current.href, reason: allowed };

      const res = await this.request(current, PAGE_ACCEPT);
      if ("error" in res) return { ok: false, url: current.href, reason: res.error };
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return { ok: false, url: current.href, reason: `HTTP ${res.status} redirect with no target` };
        try {
          current = new URL(res.location, current);
        } catch {
          return { ok: false, url: current.href, reason: "redirect to an invalid address" };
        }
        continue;
      }
      if (res.status >= 400) return { ok: false, url: current.href, reason: `HTTP ${res.status}` };
      if (!/html|text\/plain/i.test(res.contentType)) {
        return { ok: false, url: current.href, reason: `not a web page (${res.contentType || "unknown type"})` };
      }
      return { ok: true, url: current.href, status: res.status, body: res.body, contentType: res.contentType };
    }
    return { ok: false, url: current.href, reason: "too many redirects" };
  }

  private async robotsAllows(u: URL): Promise<true | string> {
    let rules = this.robots.get(u.origin);
    if (rules === undefined) {
      rules = await this.loadRobots(u);
      this.robots.set(u.origin, rules);
    }
    if (rules === "unreadable") return ROBOTS_UNREADABLE;
    return isAllowed(u.pathname + u.search, rules) ? true : "blocked by the site's robots.txt";
  }

  private async loadRobots(u: URL): Promise<RobotsRules | "unreadable"> {
    let current = new URL("/robots.txt", u.origin);
    for (let hop = 0; hop <= 5; hop++) {
      const res = await this.request(current, ROBOTS_ACCEPT);
      if ("error" in res) return "unreadable";
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return "unreadable";
        try {
          current = new URL(res.location, current);
        } catch {
          return "unreadable";
        }
        continue;
      }
      // RFC 9309: 5xx means assume everything is disallowed; other 4xx means no rules.
      if (res.status >= 500) return "unreadable";
      if (res.status >= 400) return ALLOW_ALL;
      const rules = parseRobots(res.body, this.o.agentToken);
      if (rules.crawlDelaySec !== undefined) {
        const cap = this.o.maxCrawlDelayMs ?? 30_000;
        this.crawlDelayMs.set(u.host, Math.min(rules.crawlDelaySec * 1000, cap));
      }
      return rules;
    }
    return "unreadable";
  }

  private async request(u: URL, accept: string): Promise<RawResponse> {
    // Off switch: throws StoppedError, which deliberately is NOT caught below.
    (this.o.stopCheck ?? (() => assertNotStopped()))();
    await this.waitTurn(u.host);
    this.requestCount++;
    try {
      const res = await fetch(u, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": this.o.userAgent, accept },
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
      const contentType = res.headers.get("content-type") ?? "";
      const location = res.headers.get("location") ?? undefined;
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return { status: res.status, body: "", contentType, location };
      }
      const body = await readCapped(res, this.o.maxBytes);
      return { status: res.status, body, contentType, location };
    } catch (err) {
      return { error: describeError(err) };
    } finally {
      this.lastHit.set(u.host, this.now());
    }
  }

  private async waitTurn(host: string): Promise<void> {
    const last = this.lastHit.get(host);
    if (last === undefined) return;
    const gap = Math.max(this.o.delayMs, this.crawlDelayMs.get(host) ?? 0);
    const wait = last + gap - this.now();
    if (wait > 0) await this.sleep(wait);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `network error (${cause.code})`;
    if (cause?.message) return `network error (${cause.message})`;
    return `network error (${err.message})`;
  }
  return "network error";
}
