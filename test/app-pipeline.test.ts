import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMetrics, startOfWeek } from "../src/app/metrics.js";
import { emptyData, type Data } from "../src/app/model.js";
import * as P from "../src/app/pipeline.js";
import { DataFileError, Store } from "../src/app/store.js";

function clockAt(iso: string): P.Clock & { set(iso: string): void } {
  let t = new Date(iso);
  return { now: () => t, set: (x) => (t = new Date(x)) };
}

function ready(): { d: Data; c: ReturnType<typeof clockAt>; id: string } {
  const d = emptyData();
  const c = clockAt("2026-11-10T15:00:00Z");
  Object.assign(d.settings, { senderName: "Frankie", phone: "330-555-0100", email: "frankie@example.test", mailingAddress: "1 Main St, Akron, OH 44308", approverName: "Joe" });
  P.setPin(d, "4321", undefined);
  const { added } = P.addFirms(d, c, [{ firm: "Maple Law", website: "https://maple.test/", source: "test", practiceArea: "estate planning, probate", contact: "Jane Doe, Managing Partner" }], "Needs review");
  return { d, c, id: added[0]!.id };
}

test("new firms wait for review; nothing can be drafted or set until accepted", () => {
  const { d, c, id } = ready();
  assert.equal(P.getFirm(d, id).status, "Needs review");
  assert.throws(() => P.createDraft(d, c, id, "first"), /Review this firm/);
  assert.throws(() => P.setStatus(d, c, id, "Contacted"), /Review this firm first/);
  assert.throws(() => P.reviewFirm(d, c, id, "reject", ""), /Say why/);
  P.reviewFirm(d, c, id, "accept", undefined);
  assert.equal(P.getFirm(d, id).status, "Researched");
  assert.throws(() => P.reviewFirm(d, c, id, "accept", undefined), /already been reviewed/);
});

test("the same firm is never added twice, by website or by name", () => {
  const { d, c } = ready();
  const r = P.addFirms(
    d,
    c,
    [
      { firm: "Maple Law LLC", website: "maple.test", source: "x" },
      { firm: "maple law", source: "x" },
      { firm: "Oak Law", website: "https://oak.test", source: "x" },
    ],
    "Needs review",
  );
  assert.equal(r.added.length, 1);
  assert.equal(r.alreadyThere, 2);
});

test("email approval: placeholders, opt-out line, address and the PIN are all required", () => {
  const { d, c, id } = ready();
  P.reviewFirm(d, c, id, "accept", undefined);
  const dr = P.createDraft(d, c, id, "first");
  assert.match(dr.body, /Hi Jane,/);
  assert.match(dr.body, /focuses on estate planning and probate/);
  assert.throws(() => P.approveDraft(d, c, id, dr.id, "4321"), /\[one real detail from their website\]/);

  const fixed = dr.body.replace("[one real detail from their website]", "your site explains trusts in plain English");
  P.editDraft(d, c, id, dr.id, dr.subject, fixed.replace("1 Main St, Akron, OH 44308", "somewhere"));
  assert.throws(() => P.approveDraft(d, c, id, dr.id, "4321"), /mailing address/);
  P.editDraft(d, c, id, dr.id, dr.subject, fixed.replace(/If you'd prefer not to hear from us.*$/m, ""));
  assert.throws(() => P.approveDraft(d, c, id, dr.id, "4321"), /opt-out line/);

  P.editDraft(d, c, id, dr.id, dr.subject, fixed);
  assert.throws(() => P.approveDraft(d, c, id, dr.id, "0000"), /Wrong approver PIN/);
  assert.throws(() => P.markDraftSent(d, c, id, dr.id), /Only an approved email/);
  P.approveDraft(d, c, id, dr.id, "4321");
  assert.equal(dr.approvedBy, "Joe");
  assert.throws(() => P.editDraft(d, c, id, dr.id, "x", "y"), /Unapprove it first/);

  P.markDraftSent(d, c, id, dr.id);
  const f = P.getFirm(d, id);
  assert.equal(f.status, "Contacted");
  assert.equal(f.lastContact, "2026-11-10");
  assert.throws(() => P.deleteDraft(d, c, id, dr.id), /Sent emails stay/);
});

test("drafts need the sender details from Settings first", () => {
  const { d, c, id } = ready();
  P.reviewFirm(d, c, id, "accept", undefined);
  d.settings.mailingAddress = "";
  assert.throws(() => P.createDraft(d, c, id, "first"), /mailing address/);
});

test("no PIN set means nothing can be approved", () => {
  const { d, c, id } = ready();
  d.settings.approverPinHash = "";
  P.reviewFirm(d, c, id, "accept", undefined);
  const dr = P.createDraft(d, c, id, "followup");
  assert.throws(() => P.approveDraft(d, c, id, dr.id, "4321"), /Set an approver PIN/);
});

test("opt-out deletes unsent drafts, blocks new ones, and only the approver can undo it", () => {
  const { d, c, id } = ready();
  P.reviewFirm(d, c, id, "accept", undefined);
  P.createDraft(d, c, id, "first");
  P.optOut(d, c, id);
  const f = P.getFirm(d, id);
  assert.equal(f.drafts.length, 0);
  assert.throws(() => P.createDraft(d, c, id, "first"), /opted out/);
  assert.throws(() => P.recordPermission(d, c, id, { grantedBy: "x", date: "2026-11-10", how: "y" }), /Opted out/);
  assert.throws(() => P.setStatus(d, c, id, "Researched", "0000"), /Wrong approver PIN/);
  P.setStatus(d, c, id, "Researched", "4321");
  assert.equal(f.status, "Researched");
});

test("statuses with their own rule cannot be picked from the dropdown", () => {
  const { d, c, id } = ready();
  P.reviewFirm(d, c, id, "accept", undefined);
  assert.throws(() => P.setStatus(d, c, id, "Speed check approved"), /Record permission/);
  assert.throws(() => P.setStatus(d, c, id, "Report sent"), /Mark report sent/);
  assert.throws(() => P.setStatus(d, c, id, "Opted out"), /Opted out/);
  P.setStatus(d, c, id, "Call booked");
  assert.ok(d.events.some((e) => e.type === "call_booked"));
});

test("speed check: permission first, measured times, PIN, then sent", () => {
  const { d, c, id } = ready();
  P.reviewFirm(d, c, id, "accept", undefined);
  assert.throws(() => P.updateSpeedCheck(d, c, id, { channel: "form" }), /Record the firm's permission/);
  assert.throws(() => P.recordPermission(d, c, id, { grantedBy: "Jane Doe", date: "", how: "email" }), /who agreed/);
  P.recordPermission(d, c, id, { grantedBy: "Jane Doe", date: "2026-11-10", how: "replied yes by email" });
  assert.equal(P.getFirm(d, id).status, "Speed check approved");

  P.updateSpeedCheck(d, c, id, { channel: "website form", inquirySentAt: "2026-11-11T09:00", firstReplyAt: "2026-11-12T11:00" });
  assert.throws(() => P.approveReport(d, c, id, "4321"), /Checked at/);
  P.updateSpeedCheck(d, c, id, { checkedAt: "2026-11-14T09:00", afterHours: "No", followUp: "No", experience: "The inquiry got an email reply the next day. No consult was offered." });
  assert.throws(() => P.updateSpeedCheck(d, c, id, { afterHours: "Maybe" }), /Yes, No or blank/);
  assert.throws(() => P.createDraft(d, c, id, "report"), /must be approved/);
  assert.throws(() => P.approveReport(d, c, id, "1111"), /Wrong approver PIN/);
  P.approveReport(d, c, id, "4321");
  assert.throws(() => P.updateSpeedCheck(d, c, id, { channel: "phone" }), /Unapprove it to edit/);
  P.createDraft(d, c, id, "report");
  P.markReportSent(d, c, id);
  const f = P.getFirm(d, id);
  assert.equal(f.status, "Report sent");
  assert.equal(f.speedCheck?.reportState, "sent");
});

test("reply time before the inquiry time is refused", () => {
  const { d, c, id } = ready();
  P.reviewFirm(d, c, id, "accept", undefined);
  P.recordPermission(d, c, id, { grantedBy: "Jane", date: "2026-11-10", how: "email" });
  P.updateSpeedCheck(d, c, id, {
    channel: "form",
    inquirySentAt: "2026-11-11T09:00",
    firstReplyAt: "2026-11-10T09:00",
    consultBookedAt: "2026-11-12T09:00",
    afterHours: "No",
    followUp: "No",
    experience: "x",
  });
  assert.throws(() => P.approveReport(d, c, id, "4321"), /first reply time is before/);
});

test("changing the PIN needs the current PIN", () => {
  const { d } = ready();
  assert.throws(() => P.setPin(d, "9999", "0000"), /current PIN is wrong/);
  assert.throws(() => P.setPin(d, "12", "4321"), /at least 4/);
  P.setPin(d, "9999", "4321");
  assert.throws(() => P.setPin(d, "1234", "4321"), /current PIN is wrong/);
});

test("weekly numbers and rates come from the event log", () => {
  const { d, c, id } = ready();
  P.reviewFirm(d, c, id, "accept", undefined);
  const dr = P.createDraft(d, c, id, "first");
  P.editDraft(d, c, id, dr.id, dr.subject, dr.body.replace("[one real detail from their website]", "x"));
  P.approveDraft(d, c, id, dr.id, "4321");
  P.markDraftSent(d, c, id, dr.id);
  P.logReply(d, c, id, "Sounds interesting");
  d.events.push({ at: "2026-10-01T12:00:00Z", firmId: id, type: "emailed", detail: "first" });
  const m = computeMetrics(d.events, c.now());
  assert.equal(m.thisWeek.firstEmails, 1);
  assert.equal(m.allTime.firstEmails, 2);
  assert.equal(m.thisWeek.replies, 1);
  assert.equal(m.thisWeek.firmsAdded, 1);
  assert.equal(m.rates.replyRate, 0.5);
  assert.equal(m.rates.closeRate, null);
  assert.equal(startOfWeek(new Date(2026, 10, 15, 18)).getDay(), 1, "weeks start on Monday");
});

test("store: saves atomically, keeps a daily backup, and rolls back a failed change", () => {
  const dir = mkdtempSync(join(tmpdir(), "lf-store-"));
  const file = join(dir, "data", "lead-finder.json");
  const s1 = new Store(file, () => "2026-11-10");
  s1.update((d) => d.settings.senderName = "Frankie");
  s1.update((d) => (d.settings.city = "Akron"));
  assert.ok(existsSync(join(dir, "data", "backups", "lead-finder-2026-11-10.json")));
  assert.throws(() =>
    s1.update((d) => {
      d.settings.city = "Changed";
      throw new P.GateError("no");
    }),
  );
  assert.equal(s1.data.settings.city, "Akron");
  const s2 = new Store(file);
  assert.equal(s2.data.settings.senderName, "Frankie");
  assert.deepEqual(readdirSync(join(dir, "data")).sort(), ["backups", "lead-finder.json"]);
});

test("store: a damaged data file stops the app instead of being overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "lf-bad-"));
  const file = join(dir, "lead-finder.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => new Store(file), DataFileError);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});
