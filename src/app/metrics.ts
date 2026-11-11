/** The weekly numbers from the training packet's Friday review, counted from the event log. */
import type { LfEvent } from "./model.js";

export interface Counts {
  firmsAdded: number;
  firstEmails: number;
  followUps: number;
  replies: number;
  speedChecksApproved: number;
  reportsSent: number;
  callsBooked: number;
  proposalsSent: number;
  signed: number;
  optedOut: number;
}

export interface Rates {
  replyRate: number | null;
  speedCheckYesRate: number | null;
  callRate: number | null;
  closeRate: number | null;
}

export interface Metrics {
  weekStart: string;
  thisWeek: Counts;
  allTime: Counts;
  rates: Rates;
}

function zero(): Counts {
  return {
    firmsAdded: 0,
    firstEmails: 0,
    followUps: 0,
    replies: 0,
    speedChecksApproved: 0,
    reportsSent: 0,
    callsBooked: 0,
    proposalsSent: 0,
    signed: 0,
    optedOut: 0,
  };
}

function add(c: Counts, e: LfEvent): void {
  switch (e.type) {
    case "added":
      c.firmsAdded++;
      break;
    case "emailed":
      if (e.detail === "first") c.firstEmails++;
      else if (e.detail === "followup") c.followUps++;
      break;
    case "replied":
      c.replies++;
      break;
    case "permission":
      c.speedChecksApproved++;
      break;
    case "report_sent":
      c.reportsSent++;
      break;
    case "call_booked":
      c.callsBooked++;
      break;
    case "proposal_sent":
      c.proposalsSent++;
      break;
    case "signed":
      c.signed++;
      break;
    case "opted_out":
      c.optedOut++;
      break;
    default:
      break;
  }
}

/** Monday 00:00 local time of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysSinceMonday = (s.getDay() + 6) % 7;
  s.setDate(s.getDate() - daysSinceMonday);
  return s;
}

function ratio(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

export function computeMetrics(events: LfEvent[], now: Date): Metrics {
  const weekStart = startOfWeek(now);
  const thisWeek = zero();
  const allTime = zero();
  for (const e of events) {
    add(allTime, e);
    if (new Date(e.at).getTime() >= weekStart.getTime()) add(thisWeek, e);
  }
  return {
    weekStart: weekStart.toISOString(),
    thisWeek,
    allTime,
    rates: {
      replyRate: ratio(allTime.replies, allTime.firstEmails),
      speedCheckYesRate: ratio(allTime.speedChecksApproved, allTime.replies),
      callRate: ratio(allTime.callsBooked, allTime.reportsSent),
      closeRate: ratio(allTime.signed, allTime.proposalsSent),
    },
  };
}
