/**
 * Local web server for the outreach app.
 * - Listens on 127.0.0.1 only, so nothing outside this computer can reach it.
 * - Every /api call needs the random token printed into the page at startup, and the Host
 *   header must be this computer's address; together these stop other websites from using it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { MIN_DELAY_MS, defaultSettings } from "../config.js";
import { parseCsv, toCsv } from "../csv.js";
import { findFirms } from "../find.js";
import type { Fetcher } from "../http.js";
import { PROJECT_ROOT, stopReason, type StopOptions } from "../killswitch.js";
import { parseNear } from "../sources/osm.js";
import { PROSPECT_HEADER } from "../tracker.js";
import { computeMetrics } from "./metrics.js";
import { DRAFT_KINDS, STATUSES, type Data, type Firm } from "./model.js";
import * as P from "./pipeline.js";
import { Store } from "./store.js";
import { reportHtml, reportProblems } from "./templates.js";

export interface AppOptions {
  dataFile: string;
  port?: number;
  publicDir?: string;
  /** Folders checked for a STOP file; the first one is where the off switch button writes it. */
  stopDirs?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Tests only: replace the polite web fetcher and the per-site delay. */
  fetcher?: Fetcher;
  delayMs?: number;
}

export interface SkippedFind {
  firm: string;
  website: string;
  reason: string;
  source: string;
  phone: string;
  address: string;
  added: boolean;
}

export interface SearchJob {
  id: string;
  state: "running" | "done" | "stopped" | "failed";
  startedAt: string;
  finishedAt?: string;
  log: string[];
  added: number;
  alreadyThere: number;
  skipped: SkippedFind[];
  error?: string;
}

export interface RunningApp {
  server: Server;
  token: string;
  url: string;
  store: Store;
  job: () => SearchJob | undefined;
  close: () => Promise<void>;
}

const MAX_BODY = 6 * 1024 * 1024;
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, "Send JSON.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "That is too large (6 MB limit).");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "That was not valid JSON.");
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Turns a tracker export or a lead-finder prospects CSV into firms to add. */
export function parseImport(text: string, label: string): { firms: P.NewFirmInput[]; optedOut: Set<number> } {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iFirm = col("firm", "firm name", "name", "law firm");
  if (iFirm < 0) throw new P.GateError('The CSV needs a header row with a "Firm" column.');
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const iContact = col("contact");
  const iAtt = col("attorneys");
  const iPractice = col("practice area", "practice");
  const iWeb = col("website", "url", "site");
  const iStatus = col("status");
  const iNotes = col("notes");
  const iPhone = col("phone", "telephone");
  const iEmail = col("public email", "email");
  const iSource = col("source");
  const iAddress = col("address");
  const firms: P.NewFirmInput[] = [];
  const optedOut = new Set<number>();
  for (const r of rows.slice(1)) {
    const firm = get(r, iFirm).replace(/^'/, "");
    if (!firm) continue;
    if (get(r, iStatus).toLowerCase() === "opted out") optedOut.add(firms.length);
    firms.push({
      firm,
      contact: get(r, iContact),
      attorneys: get(r, iAtt),
      practiceArea: get(r, iPractice),
      website: get(r, iWeb) || undefined,
      phone: get(r, iPhone) || undefined,
      publicEmail: get(r, iEmail),
      address: get(r, iAddress) || undefined,
      foundNote: get(r, iNotes),
      source: get(r, iSource) || `import: ${label}`,
    });
  }
  return { firms, optedOut };
}

export function exportCsv(d: Data): string {
  const rows = d.firms.map((f) => [
    f.firm,
    f.contact,
    f.attorneys,
    f.practiceArea,
    f.website,
    f.status,
    f.lastContact,
    [f.nextStep, f.nextStepDate].filter(Boolean).join(" by "),
    [f.notes, f.foundNote].filter(Boolean).join(" | "),
    f.phone,
    f.publicEmail,
    f.source,
  ]);
  return toCsv([PROSPECT_HEADER, ...rows]);
}

export async function startApp(o: AppOptions): Promise<RunningApp> {
  const store = new Store(o.dataFile);
  const now = o.now ?? (() => new Date());
  const clock: P.Clock = { now };
  const env = o.env ?? process.env;
  const stopDirs = o.stopDirs ?? [PROJECT_ROOT, process.cwd()];
  const stopOpts: StopOptions = { env, dirs: stopDirs };
  const publicDir = o.publicDir ?? join(PROJECT_ROOT, "public");
  const token = randomBytes(24).toString("hex");
  const indexHtml = readFileSync(join(publicDir, "index.html"), "utf8").replace("{{TOKEN}}", token);
  const statics: Record<string, [string, string]> = {
    "/app.js": [readFileSync(join(publicDir, "app.js"), "utf8"), "text/javascript; charset=utf-8"],
    "/app.css": [readFileSync(join(publicDir, "app.css"), "utf8"), "text/css; charset=utf-8"],
  };
  let job: SearchJob | undefined;

  function state() {
    const d = store.data;
    const { approverPinHash, ...settings } = d.settings;
    const t = P.todayList(d, clock);
    return {
      firms: d.firms,
      settings: { ...settings, pinSet: Boolean(approverPinHash) },
      metrics: computeMetrics(d.events, now()),
      today: {
        due: t.due.map((f) => f.id),
        toApprove: t.toApprove.map((x) => ({ firmId: x.firm.id, draftId: x.draft.id })),
        toSend: t.toSend.map((x) => ({ firmId: x.firm.id, draftId: x.draft.id })),
        reports: t.reports.map((f) => f.id),
        review: t.review,
      },
      reportProblems: Object.fromEntries(d.firms.filter((f) => f.speedCheck).map((f) => [f.id, reportProblems(f.speedCheck)])),
      events: d.events.slice(-3000),
      statuses: STATUSES,
      draftKinds: DRAFT_KINDS,
      offSwitch: stopReason(stopOpts),
      job: job ?? null,
      searches: d.searches.slice(-20),
      minDelayMs: MIN_DELAY_MS,
    };
  }

  function startSearch(body: Record<string, unknown>): SearchJob {
    if (job?.state === "running") throw new P.GateError("A search is already running.", 409);
    const off = stopReason(stopOpts);
    if (off) throw new P.GateError(`The off switch is on (${off}). Delete the STOP file to search again.`, 409);
    const seedText = typeof body.seedCsv === "string" && body.seedCsv.trim() ? body.seedCsv : undefined;
    const seedLabel = typeof body.seedName === "string" && body.seedName ? body.seedName.slice(0, 200) : "pasted list";
    let near;
    if (body.near && typeof body.near === "object") {
      const n = body.near as Record<string, unknown>;
      near = parseNear(`${Number(n.lat)},${Number(n.lon)}`, Number(n.radiusKm));
    }
    if (!seedText && !near) throw new P.GateError("Choose an area to search, a list of firms, or both.");
    const limit = body.limit === undefined || body.limit === "" || body.limit === null ? undefined : Number(body.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new P.GateError("Limit must be a whole number of at least 1.");

    const settings = defaultSettings(env);
    if (o.delayMs !== undefined) settings.delayMs = o.delayMs;
    const j: SearchJob = { id: randomUUID(), state: "running", startedAt: now().toISOString(), log: [], added: 0, alreadyThere: 0, skipped: [] };
    job = j;
    const exclude = P.knownFirmKeys(store.data);
    void (async () => {
      try {
        const found = await findFirms({
          seedText,
          seedLabel,
          near,
          overpassUrl: env.OVERPASS_URL,
          exclude,
          limit,
          settings,
          stopOpts,
          fetcher: o.fetcher,
          log: (l) => {
            j.log.push(l);
            if (j.log.length > 2000) j.log.shift();
          },
        });
        const inputs: P.NewFirmInput[] = found.kept.map(({ e, d }) => ({
          firm: e.firm,
          website: e.website,
          phone: e.phone,
          address: e.address,
          source: e.source,
          attorneys: e.attorneyCount === undefined ? "" : String(e.attorneyCount),
          practiceArea: e.practiceTerms.join(", "),
          publicEmail: e.publicEmail ?? "",
          foundNote: [d.reason, e.attorneyCountNote, ...e.notes].filter(Boolean).join("; "),
        }));
        const res = store.update((d) => P.addFirms(d, clock, inputs, "Needs review"));
        j.added = res.added.length;
        j.alreadyThere = res.alreadyThere + found.excluded.length;
        j.skipped = found.skipped.map(({ e, d }) => ({
          firm: e.firm,
          website: e.website ?? "",
          reason: d.reason,
          source: e.source,
          phone: e.phone ?? "",
          address: e.address ?? "",
          added: false,
        }));
        j.state = found.error ? "failed" : found.stoppedBy ? "stopped" : "done";
        j.error = found.error ?? found.stoppedBy;
      } catch (err) {
        j.state = "failed";
        j.error = (err as Error).message;
        j.log.push(`Search failed: ${j.error}`);
      } finally {
        j.finishedAt = now().toISOString();
        const summary = `${j.state}: ${j.added} added for review, ${j.skipped.length} skipped, ${j.alreadyThere} already known`;
        j.log.push(`Done. ${j.added} firm(s) added to the review queue. Nothing was sent to anyone.`);
        try {
          store.update((d) => {
            d.searches.push({ id: j.id, startedAt: j.startedAt, finishedAt: j.finishedAt ?? "", summary });
            if (d.searches.length > 100) d.searches.splice(0, d.searches.length - 100);
          });
        } catch (err) {
          j.log.push(`Could not save the search summary: ${(err as Error).message}`);
        }
      }
    })();
    return j;
  }

  type Handler = (m: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown;
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/state$/, () => state()],
    [
      "POST",
      /^\/api\/firms$/,
      (_m, b) => {
        const r = store.update((d) => P.addFirms(d, clock, [{ ...(b as unknown as P.NewFirmInput), source: "added by hand" }], "Researched"));
        if (r.added.length === 0) throw new P.GateError(r.alreadyThere ? "That firm is already in the app." : "Firm name is required.", 409);
        return r.added[0];
      },
    ],
    ["PATCH", /^\/api\/firms\/([\w-]+)$/, (m, b) => store.update((d) => P.updateFirm(d, clock, m[1]!, b))],
    ["POST", /^\/api\/firms\/([\w-]+)\/review$/, (m, b) => store.update((d) => P.reviewFirm(d, clock, m[1]!, b.decision, b.reason))],
    ["POST", /^\/api\/firms\/([\w-]+)\/status$/, (m, b) => store.update((d) => P.setStatus(d, clock, m[1]!, b.status, b.pin))],
    ["POST", /^\/api\/firms\/([\w-]+)\/optout$/, (m) => store.update((d) => P.optOut(d, clock, m[1]!))],
    ["POST", /^\/api\/firms\/([\w-]+)\/reply$/, (m, b) => store.update((d) => P.logReply(d, clock, m[1]!, b.note))],
    ["POST", /^\/api\/firms\/([\w-]+)\/drafts$/, (m, b) => store.update((d) => P.createDraft(d, clock, m[1]!, b.kind))],
    ["PATCH", /^\/api\/firms\/([\w-]+)\/drafts\/([\w-]+)$/, (m, b) => store.update((d) => P.editDraft(d, clock, m[1]!, m[2]!, b.subject, b.body))],
    ["DELETE", /^\/api\/firms\/([\w-]+)\/drafts\/([\w-]+)$/, (m) => store.update((d) => P.deleteDraft(d, clock, m[1]!, m[2]!))],
    ["POST", /^\/api\/firms\/([\w-]+)\/drafts\/([\w-]+)\/approve$/, (m, b) => store.update((d) => P.approveDraft(d, clock, m[1]!, m[2]!, b.pin))],
    ["POST", /^\/api\/firms\/([\w-]+)\/drafts\/([\w-]+)\/unapprove$/, (m) => store.update((d) => P.unapproveDraft(d, clock, m[1]!, m[2]!))],
    ["POST", /^\/api\/firms\/([\w-]+)\/drafts\/([\w-]+)\/sent$/, (m) => store.update((d) => P.markDraftSent(d, clock, m[1]!, m[2]!))],
    ["POST", /^\/api\/firms\/([\w-]+)\/permission$/, (m, b) => store.update((d) => P.recordPermission(d, clock, m[1]!, b))],
    ["PATCH", /^\/api\/firms\/([\w-]+)\/speedcheck$/, (m, b) => store.update((d) => P.updateSpeedCheck(d, clock, m[1]!, b))],
    ["POST", /^\/api\/firms\/([\w-]+)\/speedcheck\/approve$/, (m, b) => store.update((d) => P.approveReport(d, clock, m[1]!, b.pin))],
    ["POST", /^\/api\/firms\/([\w-]+)\/speedcheck\/unapprove$/, (m) => store.update((d) => P.unapproveReport(d, clock, m[1]!))],
    ["POST", /^\/api\/firms\/([\w-]+)\/speedcheck\/sent$/, (m) => store.update((d) => P.markReportSent(d, clock, m[1]!))],
    ["PUT", /^\/api\/settings$/, (_m, b) => store.update((d) => P.updateSettings(d, b))],
    ["POST", /^\/api\/settings\/pin$/, (_m, b) => store.update((d) => P.setPin(d, b.newPin, b.oldPin))],
    ["GET", /^\/api\/search$/, () => job ?? null],
    ["POST", /^\/api\/search$/, (_m, b) => startSearch(b)],
    [
      "POST",
      /^\/api\/search\/add$/,
      (_m, b) => {
        const i = Number(b.index);
        const s = job?.skipped[i];
        if (!job || job.state === "running" || !s) throw new P.GateError("That search result is no longer available.", 404);
        if (s.added) throw new P.GateError("Already added.", 409);
        const r = store.update((d) =>
          P.addFirms(d, clock, [{ firm: s.firm, website: s.website || undefined, phone: s.phone || undefined, address: s.address || undefined, source: s.source, foundNote: `Added by hand after: ${s.reason}` }], "Needs review"),
        );
        if (r.added.length === 0) throw new P.GateError("That firm is already in the app.", 409);
        s.added = true;
        return r.added[0];
      },
    ],
    [
      "POST",
      /^\/api\/import$/,
      (_m, b) => {
        if (typeof b.csv !== "string" || !b.csv.trim()) throw new P.GateError("Choose a CSV file to import.");
        const label = typeof b.name === "string" ? b.name.slice(0, 200) : "import.csv";
        const { firms, optedOut } = parseImport(b.csv, label);
        return store.update((d) => {
          let optedOutAdded = 0;
          const normal: P.NewFirmInput[] = [];
          firms.forEach((f, i) => {
            if (optedOut.has(i)) {
              const r = P.addFirms(d, clock, [f], "Researched");
              const added = r.added[0];
              if (added) {
                P.optOut(d, clock, added.id);
                optedOutAdded++;
              }
            } else normal.push(f);
          });
          const r = P.addFirms(d, clock, normal, "Needs review");
          return { added: r.added.length + optedOutAdded, optedOut: optedOutAdded, alreadyThere: r.alreadyThere };
        });
      },
    ],
    [
      "POST",
      /^\/api\/offswitch$/,
      () => {
        const dir = stopDirs[0] ?? PROJECT_ROOT;
        writeFileSync(join(dir, "STOP"), `Off switch turned on from the app at ${now().toISOString()}\n`);
        return { offSwitch: stopReason(stopOpts) };
      },
    ],
  ];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port;
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      send(res, 403, "text/plain; charset=utf-8", "Forbidden: open this app at its local address.");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      send(res, 200, "text/html; charset=utf-8", indexHtml, { "content-security-policy": PAGE_CSP, "x-frame-options": "DENY" });
      return;
    }
    const asset = statics[url.pathname];
    if (method === "GET" && asset) {
      send(res, 200, asset[1], asset[0]);
      return;
    }

    const given = req.headers["x-lf-token"] ?? url.searchParams.get("t");
    if (given !== token) {
      json(res, 403, { error: "Missing or wrong app token. Reload the page." });
      return;
    }

    if (method === "GET" && url.pathname === "/export.csv") {
      send(res, 200, "text/csv; charset=utf-8", exportCsv(store.data), {
        "content-disposition": `attachment; filename="lead-finder-tracker-${stamp(now())}.csv"`,
      });
      return;
    }
    const reportMatch = /^\/report\/([\w-]+)$/.exec(url.pathname);
    if (method === "GET" && reportMatch) {
      const f: Firm = P.getFirm(store.data, reportMatch[1]!);
      if (!f.speedCheck) throw new P.GateError("This firm has no speed check yet.", 404);
      send(res, 200, "text/html; charset=utf-8", reportHtml(f, store.data.settings, now()), { "content-security-policy": REPORT_CSP });
      return;
    }

    for (const [m, re, handler] of routes) {
      if (m !== method) continue;
      const match = re.exec(url.pathname);
      if (!match) continue;
      const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
      const out = handler(match, body, url);
      json(res, 200, out ?? { ok: true });
      return;
    }
    json(res, 404, { error: "Not found." });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof P.GateError) json(res, err.status, { error: err.message });
      else if (err instanceof HttpError) json(res, err.status, { error: err.message });
      else {
        console.error(err);
        json(res, 500, { error: `Something went wrong: ${(err as Error).message}` });
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 4321, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    token,
    url: `http://127.0.0.1:${port}/`,
    store,
    job: () => job,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const DEFAULT_DATA_FILE = resolve(PROJECT_ROOT, "data", "lead-finder.json");
