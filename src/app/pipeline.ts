/**
 * Every change to the data goes through here, so the rules from the training packet are
 * enforced in one place:
 * - new firms wait in "Needs review" until a person accepts them
 * - emails and reports need the approver PIN before they can be copied or marked sent
 * - a draft with a [placeholder], or without the mailing address and opt-out line, cannot be approved
 * - no speed check is logged until the firm's permission is recorded
 * - opted-out firms get no new drafts, and only the approver can undo an opt-out
 */
import { randomUUID } from "node:crypto";
import type { Candidate } from "../types.js";
import { firmKey } from "../urls.js";
import {
  DEFAULT_INSTANT_INTAKE,
  DRAFT_KINDS,
  EDITABLE_FIRM_FIELDS,
  SETTINGS_FIELDS,
  SPEEDCHECK_FIELDS,
  STATUSES,
  type Data,
  type Draft,
  type DraftKind,
  type EventType,
  type Firm,
  type Permission,
  type SpeedCheck,
  type Status,
} from "./model.js";
import { MIN_PIN_LENGTH, hashPin, verifyPin } from "./pin.js";
import { OPT_OUT_LINE, buildDraft, findPlaceholders, reportProblems } from "./templates.js";

/** A rule said no. `status` is the HTTP status the server returns. */
export class GateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "GateError";
  }
}

export interface Clock {
  now(): Date;
}

const NO_OUTREACH: Status[] = ["Needs review", "Rejected", "Opted out"];

/** Statuses that only a dedicated action may set, so its rule cannot be skipped from the dropdown. */
const ACTION_ONLY: Partial<Record<Status, string>> = {
  "Needs review": "New firms start in Needs review; it cannot be chosen by hand.",
  "Speed check approved": 'Use "Record permission" so who agreed, and when, is written down.',
  "Report sent": 'Use "Mark report sent" on an approved report.',
  "Opted out": 'Use the "Opted out" button.',
  Rejected: 'Use "Reject" in the review queue.',
};

const STATUS_EVENTS: Partial<Record<Status, EventType>> = {
  "Call booked": "call_booked",
  "Proposal sent": "proposal_sent",
  Signed: "signed",
};

function iso(c: Clock): string {
  return c.now().toISOString();
}

function today(c: Clock): string {
  const d = c.now();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function log(d: Data, c: Clock, firmId: string, type: EventType, detail = ""): void {
  d.events.push({ at: iso(c), firmId, type, detail });
}

export function getFirm(d: Data, id: string): Firm {
  const f = d.firms.find((x) => x.id === id);
  if (!f) throw new GateError("That firm was not found.", 404);
  return f;
}

function getDraft(f: Firm, draftId: string): Draft {
  const dr = f.drafts.find((x) => x.id === draftId);
  if (!dr) throw new GateError("That draft was not found.", 404);
  return dr;
}

function requirePin(d: Data, pin: unknown): string {
  if (!d.settings.approverPinHash) throw new GateError("Set an approver PIN in Settings first.", 403);
  if (typeof pin !== "string" || !verifyPin(pin, d.settings.approverPinHash)) {
    throw new GateError("Wrong approver PIN.", 403);
  }
  return d.settings.approverName || "Approver";
}

function clean(v: unknown, max = 5000): string {
  return typeof v === "string" ? v.slice(0, max).trim() : "";
}

function touch(f: Firm, c: Clock): void {
  f.updatedAt = iso(c);
}

/** Every key used to recognise a firm already in the app: its website domain and its name. */
export function knownFirmKeys(d: Data): Set<string> {
  const keys = new Set<string>();
  for (const f of d.firms) {
    keys.add(firmKey(f.firm, f.website));
    keys.add(firmKey(f.firm, undefined));
  }
  return keys;
}

export interface NewFirmInput extends Candidate {
  attorneys?: string;
  practiceArea?: string;
  foundNote?: string;
  publicEmail?: string;
  contact?: string;
}

/** Adds firms that are not already in the app. Returns how many were added and how many were already there. */
export function addFirms(
  d: Data,
  c: Clock,
  inputs: NewFirmInput[],
  status: "Needs review" | "Researched",
): { added: Firm[]; alreadyThere: number } {
  const keys = knownFirmKeys(d);
  const added: Firm[] = [];
  let alreadyThere = 0;
  for (const i of inputs) {
    const name = clean(i.firm, 300);
    if (!name) continue;
    const byWebsite = firmKey(name, i.website);
    const byName = firmKey(name, undefined);
    if (keys.has(byWebsite) || keys.has(byName)) {
      alreadyThere++;
      continue;
    }
    keys.add(byWebsite);
    keys.add(byName);
    const now = iso(c);
    const f: Firm = {
      id: randomUUID(),
      firm: name,
      contact: clean(i.contact, 300),
      attorneys: clean(i.attorneys, 20),
      practiceArea: clean(i.practiceArea, 500),
      website: clean(i.website, 500),
      status,
      lastContact: "",
      nextStep: status === "Needs review" ? "Review this firm" : "Draft the first email",
      nextStepDate: "",
      notes: "",
      phone: clean(i.phone, 100),
      publicEmail: clean(i.publicEmail, 300),
      address: clean(i.address, 500),
      source: clean(i.source, 300),
      foundNote: clean(i.foundNote, 2000),
      createdAt: now,
      updatedAt: now,
      drafts: [],
    };
    d.firms.push(f);
    added.push(f);
    log(d, c, f.id, status === "Needs review" ? "found" : "added", f.source);
  }
  return { added, alreadyThere };
}

export function reviewFirm(d: Data, c: Clock, id: string, decision: unknown, reason: unknown): Firm {
  const f = getFirm(d, id);
  if (f.status !== "Needs review") throw new GateError("This firm has already been reviewed.", 409);
  if (decision === "accept") {
    f.status = "Researched";
    f.nextStep = "Draft the first email";
    log(d, c, f.id, "reviewed");
    log(d, c, f.id, "added");
  } else if (decision === "reject") {
    const why = clean(reason, 500);
    if (!why) throw new GateError("Say why this firm is being rejected.");
    f.status = "Rejected";
    f.nextStep = "";
    f.notes = [f.notes, `Rejected: ${why}`].filter(Boolean).join("\n");
    log(d, c, f.id, "rejected", why);
  } else {
    throw new GateError('Decision must be "accept" or "reject".');
  }
  touch(f, c);
  return f;
}

export function updateFirm(d: Data, c: Clock, id: string, patch: Record<string, unknown>): Firm {
  const f = getFirm(d, id);
  for (const key of EDITABLE_FIRM_FIELDS) {
    if (key in patch) f[key] = clean(patch[key], key === "notes" ? 20000 : 1000);
  }
  if (!f.firm) throw new GateError("Firm name cannot be empty.");
  touch(f, c);
  return f;
}

export function setStatus(d: Data, c: Clock, id: string, status: unknown, pin?: unknown): Firm {
  const f = getFirm(d, id);
  if (!STATUSES.includes(status as Status)) throw new GateError("Unknown status.");
  const to = status as Status;
  if (to === f.status) return f;
  const actionOnly = ACTION_ONLY[to];
  if (actionOnly) throw new GateError(actionOnly);
  if (f.status === "Needs review") throw new GateError("Review this firm first (accept or reject).");
  if (f.status === "Opted out") {
    const who = requirePin(d, pin);
    log(d, c, f.id, "status", `Opt-out undone by ${who}`);
  }
  if (f.status === "Rejected" && to !== "Researched") {
    throw new GateError("A rejected firm can only be moved back to Researched first.");
  }
  const from = f.status;
  f.status = to;
  log(d, c, f.id, "status", `${from} -> ${to}`);
  const extra = STATUS_EVENTS[to];
  if (extra) log(d, c, f.id, extra);
  touch(f, c);
  return f;
}

export function optOut(d: Data, c: Clock, id: string): Firm {
  const f = getFirm(d, id);
  f.status = "Opted out";
  f.drafts = f.drafts.filter((x) => x.state === "sent");
  f.nextStep = "Never contact again";
  f.nextStepDate = "";
  log(d, c, f.id, "opted_out");
  touch(f, c);
  return f;
}

function settingsProblems(d: Data): string[] {
  const s = d.settings;
  const missing: string[] = [];
  if (!s.senderName) missing.push("your name");
  if (!s.company) missing.push("company");
  if (!s.phone && !s.email) missing.push("a phone or email");
  if (!s.mailingAddress) missing.push("mailing address");
  return missing;
}

export function createDraft(d: Data, c: Clock, id: string, kind: unknown): Draft {
  const f = getFirm(d, id);
  if (!(typeof kind === "string" && kind in DRAFT_KINDS)) throw new GateError("Unknown email type.");
  if (NO_OUTREACH.includes(f.status)) {
    throw new GateError(
      f.status === "Opted out"
        ? "This firm opted out. Never contact it again."
        : f.status === "Rejected"
          ? "This firm was rejected."
          : "Review this firm before drafting anything.",
      409,
    );
  }
  const missing = settingsProblems(d);
  if (missing.length) throw new GateError(`Fill in Settings first: ${missing.join(", ")}.`);
  if (kind === "report" && f.speedCheck?.reportState !== "approved" && f.speedCheck?.reportState !== "sent") {
    throw new GateError("The speed check report must be approved before its cover note.");
  }
  const { subject, body } = buildDraft(kind as DraftKind, f, d.settings);
  const now = iso(c);
  const draft: Draft = { id: randomUUID(), kind: kind as DraftKind, subject, body, state: "draft", createdAt: now, updatedAt: now };
  f.drafts.push(draft);
  touch(f, c);
  return draft;
}

export function editDraft(d: Data, c: Clock, id: string, draftId: string, subject: unknown, body: unknown): Draft {
  const f = getFirm(d, id);
  const dr = getDraft(f, draftId);
  if (dr.state !== "draft") throw new GateError("Approved or sent emails cannot be edited. Unapprove it first.", 409);
  dr.subject = clean(subject, 300);
  dr.body = typeof body === "string" ? body.slice(0, 20000) : dr.body;
  dr.updatedAt = iso(c);
  touch(f, c);
  return dr;
}

export function approveDraft(d: Data, c: Clock, id: string, draftId: string, pin: unknown): Draft {
  const f = getFirm(d, id);
  const dr = getDraft(f, draftId);
  if (dr.state !== "draft") throw new GateError("This email is already approved or sent.", 409);
  if (NO_OUTREACH.includes(f.status)) throw new GateError(`Cannot approve: firm status is ${f.status}.`, 409);
  const placeholders = findPlaceholders(`${dr.subject}\n${dr.body}`);
  if (placeholders.length) {
    throw new GateError(`Replace these placeholders first: ${placeholders.join(", ")}`);
  }
  if (!dr.subject.trim()) throw new GateError("The subject line is empty.");
  if (!dr.body.includes(OPT_OUT_LINE)) throw new GateError("Keep the opt-out line in the email.");
  const address = d.settings.mailingAddress.trim();
  if (!address || !dr.body.includes(address)) throw new GateError("Keep the mailing address from Settings in the email.");
  const who = requirePin(d, pin);
  dr.state = "approved";
  dr.approvedBy = who;
  dr.approvedAt = iso(c);
  dr.updatedAt = dr.approvedAt;
  log(d, c, f.id, "draft_approved", DRAFT_KINDS[dr.kind]);
  touch(f, c);
  return dr;
}

export function unapproveDraft(d: Data, c: Clock, id: string, draftId: string): Draft {
  const f = getFirm(d, id);
  const dr = getDraft(f, draftId);
  if (dr.state !== "approved") throw new GateError("Only an approved, unsent email can be unapproved.", 409);
  dr.state = "draft";
  delete dr.approvedBy;
  delete dr.approvedAt;
  dr.updatedAt = iso(c);
  touch(f, c);
  return dr;
}

export function markDraftSent(d: Data, c: Clock, id: string, draftId: string): Draft {
  const f = getFirm(d, id);
  const dr = getDraft(f, draftId);
  if (dr.state !== "approved") throw new GateError("Only an approved email can be marked sent.", 409);
  if (NO_OUTREACH.includes(f.status)) throw new GateError(`Cannot send: firm status is ${f.status}.`, 409);
  dr.state = "sent";
  dr.sentAt = iso(c);
  dr.updatedAt = dr.sentAt;
  f.lastContact = today(c);
  if (f.status === "Researched") {
    log(d, c, f.id, "status", "Researched -> Contacted");
    f.status = "Contacted";
  }
  if (dr.kind === "first") {
    f.nextStep = "Follow up if no reply";
  }
  log(d, c, f.id, "emailed", dr.kind);
  touch(f, c);
  return dr;
}

export function deleteDraft(d: Data, c: Clock, id: string, draftId: string): void {
  const f = getFirm(d, id);
  const dr = getDraft(f, draftId);
  if (dr.state === "sent") throw new GateError("Sent emails stay in the record.", 409);
  f.drafts = f.drafts.filter((x) => x.id !== draftId);
  touch(f, c);
}

export function logReply(d: Data, c: Clock, id: string, note: unknown): Firm {
  const f = getFirm(d, id);
  if (f.status === "Needs review") throw new GateError("Review this firm first.");
  const text = clean(note, 2000);
  f.lastContact = today(c);
  if (text) f.notes = [f.notes, `Reply ${today(c)}: ${text}`].filter(Boolean).join("\n");
  log(d, c, f.id, "replied", text);
  touch(f, c);
  return f;
}

export function recordPermission(d: Data, c: Clock, id: string, input: Record<string, unknown>): Firm {
  const f = getFirm(d, id);
  if (NO_OUTREACH.includes(f.status)) throw new GateError(`Cannot record permission: firm status is ${f.status}.`, 409);
  const grantedBy = clean(input.grantedBy, 300);
  const date = clean(input.date, 40);
  const how = clean(input.how, 1000);
  if (!grantedBy || !date || !how) throw new GateError("Write down who agreed, the date, and how they agreed (for example, reply email).");
  const permission: Permission = { grantedBy, date, how, recordedAt: iso(c) };
  f.permission = permission;
  f.speedCheck ??= {
    channel: "",
    need: "estate planning help",
    inquirySentAt: "",
    firstReplyAt: "",
    consultBookedAt: "",
    checkedAt: "",
    afterHours: "",
    followUp: "",
    experience: "",
    instantIntake: DEFAULT_INSTANT_INTAKE,
    reportState: "draft",
  };
  const from = f.status;
  f.status = "Speed check approved";
  f.nextStep = "Send the test inquiry and log the times";
  log(d, c, f.id, "status", `${from} -> Speed check approved`);
  log(d, c, f.id, "permission", `${grantedBy}, ${date}, ${how}`);
  touch(f, c);
  return f;
}

export function updateSpeedCheck(d: Data, c: Clock, id: string, patch: Record<string, unknown>): SpeedCheck {
  const f = getFirm(d, id);
  if (!f.permission || !f.speedCheck) throw new GateError("Record the firm's permission before logging a speed check.", 409);
  if (f.speedCheck.reportState !== "draft") throw new GateError("The report is approved or sent. Unapprove it to edit.", 409);
  const sc = f.speedCheck;
  for (const key of SPEEDCHECK_FIELDS) {
    if (!(key in patch)) continue;
    const v = clean(patch[key], 4000);
    if (key === "afterHours" || key === "followUp") {
      if (v !== "" && v !== "Yes" && v !== "No") throw new GateError(`${key} must be Yes, No or blank.`);
      sc[key] = v;
    } else {
      sc[key] = v;
    }
  }
  touch(f, c);
  return sc;
}

export function approveReport(d: Data, c: Clock, id: string, pin: unknown): SpeedCheck {
  const f = getFirm(d, id);
  const sc = f.speedCheck;
  if (!f.permission || !sc) throw new GateError("No speed check to approve.", 409);
  if (sc.reportState !== "draft") throw new GateError("The report is already approved or sent.", 409);
  const problems = reportProblems(sc);
  if (problems.length) throw new GateError(problems.join(" "));
  const who = requirePin(d, pin);
  sc.reportState = "approved";
  sc.approvedBy = who;
  sc.approvedAt = iso(c);
  log(d, c, f.id, "report_approved");
  touch(f, c);
  return sc;
}

export function unapproveReport(d: Data, c: Clock, id: string): SpeedCheck {
  const f = getFirm(d, id);
  const sc = f.speedCheck;
  if (!sc || sc.reportState !== "approved") throw new GateError("Only an approved, unsent report can be unapproved.", 409);
  sc.reportState = "draft";
  delete sc.approvedBy;
  delete sc.approvedAt;
  touch(f, c);
  return sc;
}

export function markReportSent(d: Data, c: Clock, id: string): Firm {
  const f = getFirm(d, id);
  const sc = f.speedCheck;
  if (!sc || sc.reportState !== "approved") throw new GateError("Only an approved report can be marked sent.", 409);
  if (NO_OUTREACH.includes(f.status)) throw new GateError(`Cannot send: firm status is ${f.status}.`, 409);
  sc.reportState = "sent";
  sc.sentAt = iso(c);
  const from = f.status;
  f.status = "Report sent";
  f.lastContact = today(c);
  f.nextStep = "Book the 20-minute walkthrough call";
  log(d, c, f.id, "status", `${from} -> Report sent`);
  log(d, c, f.id, "report_sent");
  touch(f, c);
  return f;
}

export function updateSettings(d: Data, patch: Record<string, unknown>): void {
  for (const key of SETTINGS_FIELDS) {
    if (key in patch) d.settings[key] = clean(patch[key], 1000);
  }
}

export function setPin(d: Data, newPin: unknown, oldPin: unknown): void {
  if (d.settings.approverPinHash) {
    if (typeof oldPin !== "string" || !verifyPin(oldPin, d.settings.approverPinHash)) {
      throw new GateError("The current PIN is wrong.", 403);
    }
  }
  if (typeof newPin !== "string" || newPin.trim().length < MIN_PIN_LENGTH) {
    throw new GateError(`The PIN needs at least ${MIN_PIN_LENGTH} characters.`);
  }
  d.settings.approverPinHash = hashPin(newPin.trim());
}

/** Firms that need attention, for the Today view. */
export function todayList(d: Data, c: Clock): { due: Firm[]; toApprove: { firm: Firm; draft: Draft }[]; toSend: { firm: Firm; draft: Draft }[]; reports: Firm[]; review: number } {
  const t = today(c);
  const due = d.firms
    .filter((f) => f.nextStepDate && f.nextStepDate <= t && !["Opted out", "Rejected", "Signed"].includes(f.status))
    .sort((a, b) => a.nextStepDate.localeCompare(b.nextStepDate));
  const toApprove: { firm: Firm; draft: Draft }[] = [];
  const toSend: { firm: Firm; draft: Draft }[] = [];
  for (const f of d.firms) {
    for (const dr of f.drafts) {
      if (dr.state === "draft") toApprove.push({ firm: f, draft: dr });
      if (dr.state === "approved") toSend.push({ firm: f, draft: dr });
    }
  }
  const reports = d.firms.filter((f) => f.speedCheck && f.speedCheck.reportState !== "sent" && f.permission);
  const review = d.firms.filter((f) => f.status === "Needs review").length;
  return { due, toApprove, toSend, reports, review };
}
