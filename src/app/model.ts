/** Data model for the outreach app. Everything is stored in one JSON file on this computer. */

/** Pipeline stages, in the order of the training packet's tracker. */
export const STATUSES = [
  "Needs review",
  "Researched",
  "Contacted",
  "Speed check approved",
  "Report sent",
  "Call booked",
  "Proposal sent",
  "Signed",
  "Not now",
  "Opted out",
  "Rejected",
] as const;
export type Status = (typeof STATUSES)[number];

export const DRAFT_KINDS = {
  first: "First email",
  followup: "Follow-up",
  report: "Report cover note",
  recap: "Call recap",
} as const;
export type DraftKind = keyof typeof DRAFT_KINDS;
export type DraftState = "draft" | "approved" | "sent";

export interface Draft {
  id: string;
  kind: DraftKind;
  subject: string;
  body: string;
  state: DraftState;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  sentAt?: string;
}

/** The firm's permission to run a speed check. Required before any test inquiry. */
export interface Permission {
  grantedBy: string;
  date: string;
  how: string;
  recordedAt: string;
}

export type YesNo = "" | "Yes" | "No";
export type ReportState = "draft" | "approved" | "sent";

export interface SpeedCheck {
  channel: string;
  need: string;
  /** Local date-time strings from the form, e.g. "2026-11-12T09:30". */
  inquirySentAt: string;
  firstReplyAt: string;
  consultBookedAt: string;
  /** When the report is written and there is still no reply or booking, the moment that was checked. */
  checkedAt: string;
  afterHours: YesNo;
  followUp: YesNo;
  experience: string;
  instantIntake: string;
  reportState: ReportState;
  approvedBy?: string;
  approvedAt?: string;
  sentAt?: string;
}

export interface Firm {
  id: string;
  firm: string;
  contact: string;
  attorneys: string;
  practiceArea: string;
  website: string;
  status: Status;
  lastContact: string;
  nextStep: string;
  nextStepDate: string;
  notes: string;
  phone: string;
  publicEmail: string;
  address: string;
  source: string;
  /** What the finder noted about this firm (how the attorney count was found, etc.). */
  foundNote: string;
  createdAt: string;
  updatedAt: string;
  permission?: Permission;
  speedCheck?: SpeedCheck;
  drafts: Draft[];
}

export type EventType =
  | "found"
  | "added"
  | "reviewed"
  | "rejected"
  | "status"
  | "draft_approved"
  | "emailed"
  | "replied"
  | "permission"
  | "report_approved"
  | "report_sent"
  | "call_booked"
  | "proposal_sent"
  | "signed"
  | "opted_out";

export interface LfEvent {
  at: string;
  firmId: string;
  type: EventType;
  detail: string;
}

export interface AppSettings {
  senderName: string;
  senderTitle: string;
  company: string;
  city: string;
  phone: string;
  email: string;
  mailingAddress: string;
  approverName: string;
  /** scrypt hash of the approver PIN, "salt:hash" in hex. Empty until a PIN is set. */
  approverPinHash: string;
}

export interface SearchRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
}

export interface Data {
  version: 1;
  firms: Firm[];
  events: LfEvent[];
  settings: AppSettings;
  searches: SearchRun[];
}

export const EDITABLE_FIRM_FIELDS = [
  "firm",
  "contact",
  "attorneys",
  "practiceArea",
  "website",
  "lastContact",
  "nextStep",
  "nextStepDate",
  "notes",
  "phone",
  "publicEmail",
  "address",
] as const;
export type EditableFirmField = (typeof EDITABLE_FIRM_FIELDS)[number];

export const SPEEDCHECK_FIELDS = [
  "channel",
  "need",
  "inquirySentAt",
  "firstReplyAt",
  "consultBookedAt",
  "checkedAt",
  "afterHours",
  "followUp",
  "experience",
  "instantIntake",
] as const;
export type SpeedCheckField = (typeof SPEEDCHECK_FIELDS)[number];

export const SETTINGS_FIELDS = [
  "senderName",
  "senderTitle",
  "company",
  "city",
  "phone",
  "email",
  "mailingAddress",
  "approverName",
] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];

export function defaultAppSettings(): AppSettings {
  return {
    senderName: "",
    senderTitle: "",
    company: "Futreeng",
    city: "Akron",
    phone: "",
    email: "",
    mailingAddress: "",
    approverName: "",
    approverPinHash: "",
  };
}

export function emptyData(): Data {
  return { version: 1, firms: [], events: [], settings: defaultAppSettings(), searches: [] };
}

export const DEFAULT_INSTANT_INTAKE =
  "With instant intake, a new client answers a few screening questions on your website and books a consultation " +
  "right away, including after hours. It works alongside the systems you already use.";
