import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../src/csv.js";
import { startApp, type RunningApp } from "../src/app/server.js";
import { PROSPECT_HEADER } from "../src/tracker.js";
import { FakeFetcher, page, profileLinks } from "./helpers.js";

async function boot(fetcher?: FakeFetcher): Promise<{ app: RunningApp; dir: string; call: (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }> }> {
  const dir = mkdtempSync(join(tmpdir(), "lf-app-"));
  const app = await startApp({ dataFile: join(dir, "data", "lead-finder.json"), port: 0, stopDirs: [dir], env: {}, fetcher });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, app.url), {
      method,
      headers: { "x-lf-token": app.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  };
  return { app, dir, call };
}

function rawGet(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ hostname: u.hostname, port: u.port, path: "/api/state", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("page loads with its token and a strict content security policy; API needs the token and the local host name", async () => {
  const { app } = await boot();
  try {
    const res = await fetch(app.url);
    const html = await res.text();
    assert.ok(html.includes(`content="${app.token}"`));
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal((await fetch(new URL("/api/state", app.url))).status, 403, "no token");
    const port = new URL(app.url).port;
    assert.equal(await rawGet(app.url, `evil.test:${port}`), 403, "wrong Host header");
    const noType = await fetch(new URL("/api/settings", app.url), { method: "PUT", headers: { "x-lf-token": app.token }, body: "{}" });
    assert.equal(noType.status, 415);
  } finally {
    await app.close();
  }
});

test("full flow through the API: add, draft, approve with PIN, send, permission, report", async () => {
  const { app, call } = await boot();
  try {
    assert.equal((await call("PUT", "/api/settings", { senderName: "Frankie", phone: "330-555-0100", mailingAddress: "1 Main St, Akron, OH 44308", approverName: "Joe" })).status, 200);
    assert.equal((await call("POST", "/api/settings/pin", { newPin: "4321" })).status, 200);
    const state0 = (await call("GET", "/api/state")).data;
    assert.equal(state0.settings.pinSet, true);
    assert.equal(state0.settings.approverPinHash, undefined, "the PIN hash never leaves the server");

    const firm = (await call("POST", "/api/firms", { firm: "Oak Estate Law", website: "oak.test", contact: "Sam Lee", practiceArea: "estate planning" })).data;
    assert.equal(firm.status, "Researched");
    assert.equal((await call("POST", "/api/firms", { firm: "Oak Estate Law" })).status, 409);

    const draft = (await call("POST", `/api/firms/${firm.id}/drafts`, { kind: "first" })).data;
    const blocked = await call("POST", `/api/firms/${firm.id}/drafts/${draft.id}/approve`, { pin: "4321" });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /placeholders/);
    const body = draft.body.replace("[one real detail from their website]", "your trust FAQ is very clear");
    assert.equal((await call("PATCH", `/api/firms/${firm.id}/drafts/${draft.id}`, { subject: draft.subject, body })).status, 200);
    assert.equal((await call("POST", `/api/firms/${firm.id}/drafts/${draft.id}/approve`, { pin: "9999" })).status, 403);
    assert.equal((await call("POST", `/api/firms/${firm.id}/drafts/${draft.id}/approve`, { pin: "4321" })).status, 200);
    assert.equal((await call("POST", `/api/firms/${firm.id}/drafts/${draft.id}/sent`, {})).status, 200);

    assert.equal((await call("POST", `/api/firms/${firm.id}/permission`, { grantedBy: "Sam Lee", date: "2026-11-10", how: "replied yes" })).status, 200);
    await call("PATCH", `/api/firms/${firm.id}/speedcheck`, {
      channel: "website form",
      inquirySentAt: "2026-11-11T09:00",
      firstReplyAt: "2026-11-11T09:30",
      consultBookedAt: "2026-11-13T10:00",
      afterHours: "No",
      followUp: "Yes",
      experience: "Reply in 30 minutes, consult two days later.",
    });
    const report = await fetch(new URL(`/report/${firm.id}?t=${app.token}`, app.url));
    assert.equal(report.status, 200);
    assert.match(await report.text(), /30 minutes/);
    assert.equal((await call("POST", `/api/firms/${firm.id}/speedcheck/approve`, { pin: "4321" })).status, 200);
    assert.equal((await call("POST", `/api/firms/${firm.id}/speedcheck/sent`, {})).status, 200);

    const state = (await call("GET", "/api/state")).data;
    const f = state.firms.find((x: any) => x.id === firm.id);
    assert.equal(f.status, "Report sent");
    assert.equal(state.metrics.thisWeek.firstEmails, 1);
    assert.equal(state.metrics.thisWeek.reportsSent, 1);

    const csv = await fetch(new URL(`/export.csv?t=${app.token}`, app.url));
    const rows = parseCsv(await csv.text());
    assert.deepEqual(rows[0], PROSPECT_HEADER);
    assert.equal(rows[1]?.[0], "Oak Estate Law");
  } finally {
    await app.close();
  }
});

test("search adds likely fits to the review queue and never re-checks known firms", async () => {
  const fetcher = new FakeFetcher({
    "https://maple.test/": page(`<a href="/attorneys/">Attorneys</a><p>Estate planning and probate.</p>`),
    "https://maple.test/attorneys/": page(profileLinks("attorneys", 4)),
    "https://injury.test/": page(`<p>Car accidents only.</p>`),
  });
  const { app, call } = await boot(fetcher);
  try {
    await call("POST", "/api/firms", { firm: "Known Firm", website: "known.test" });
    const seedCsv = "Firm,Website\nMaple Law,https://maple.test/\nInjury Co,https://injury.test/\nKnown Firm,https://known.test/\nNo Site Firm,\n";
    const start = await call("POST", "/api/search", { seedCsv, seedName: "akron.csv" });
    assert.equal(start.status, 200, JSON.stringify(start.data));
    let job = start.data;
    for (let i = 0; i < 50 && job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await call("GET", "/api/search")).data;
    }
    assert.equal(job.state, "done", job.log.join("\n"));
    assert.equal(job.added, 1);
    assert.equal(job.alreadyThere, 1);
    assert.ok(!fetcher.requested.some((u) => u.includes("known.test")), "known firm was not checked");
    assert.deepEqual(job.skipped.map((s: any) => s.firm), ["Injury Co", "No Site Firm"]);

    const state = (await call("GET", "/api/state")).data;
    const maple = state.firms.find((f: any) => f.firm === "Maple Law");
    assert.equal(maple.status, "Needs review");
    assert.equal(maple.attorneys, "4");
    assert.equal(state.today.review, 1);

    assert.equal((await call("POST", "/api/search/add", { index: 1 })).status, 200);
    assert.equal((await call("POST", "/api/search/add", { index: 1 })).status, 409);
  } finally {
    await app.close();
  }
});

test("off switch button writes STOP and blocks searching", async () => {
  const { app, dir, call } = await boot(new FakeFetcher({}));
  try {
    const r = await call("POST", "/api/offswitch", {});
    assert.match(r.data.offSwitch, /STOP file found/);
    assert.ok(existsSync(join(dir, "STOP")));
    const s = await call("POST", "/api/search", { seedCsv: "Firm,Website\nA,https://a.test/\n" });
    assert.equal(s.status, 409);
    assert.match(s.data.error, /off switch is on/);
  } finally {
    await app.close();
  }
});

test("import keeps opted-out firms opted out and skips firms already here", async () => {
  const { app, call } = await boot();
  try {
    const csv = "Firm,Website,Status\nMaple Law,maple.test,Researched\nGone Firm,gone.test,Opted out\n";
    const r = (await call("POST", "/api/import", { csv, name: "tracker.csv" })).data;
    assert.deepEqual(r, { added: 2, optedOut: 1, alreadyThere: 0 });
    const again = (await call("POST", "/api/import", { csv, name: "tracker.csv" })).data;
    assert.equal(again.added, 0);
    const state = (await call("GET", "/api/state")).data;
    assert.equal(state.firms.find((f: any) => f.firm === "Gone Firm").status, "Opted out");
    assert.equal(state.firms.find((f: any) => f.firm === "Maple Law").status, "Needs review");
  } finally {
    await app.close();
  }
});
