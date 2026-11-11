/**
 * Email drafts and the speed check report, built from the training packet templates.
 * Anything the app cannot know is left as a [bracketed placeholder]; a draft with a
 * placeholder left in it cannot be approved.
 */
import { DEFAULT_INSTANT_INTAKE, type AppSettings, type DraftKind, type Firm, type SpeedCheck } from "./model.js";

export const OPT_OUT_LINE = "If you'd prefer not to hear from us, just reply and let me know.";

const PRACTICE_ORDER = ["estate planning", "probate", "trusts", "trust administration", "elder law", "wills", "guardianship", "medicaid planning"];

export function firstName(contact: string): string {
  const cleaned = contact
    .replace(/,.*$/, "")
    .replace(/\b(mr|mrs|ms|dr|attorney|atty)\.?\s+/gi, "")
    .trim();
  return cleaned.split(/\s+/)[0] ?? "";
}

/** "estate planning and probate" from the firm's practice keywords, or a placeholder. */
export function practicePhrase(practiceArea: string): string {
  const terms = practiceArea
    .split(/[,;]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const picked = PRACTICE_ORDER.filter((p) => terms.includes(p)).slice(0, 2);
  if (picked.length === 0) {
    const first = terms[0];
    return first ? first : "[practice area]";
  }
  return picked.join(" and ");
}

function footer(s: AppSettings): string {
  const name = s.senderName || "[your name]";
  const reach = [s.phone, s.email].filter(Boolean);
  const contactBits = [s.company || "[company]", ...(reach.length ? reach : ["[phone or email]"])].join(" | ");
  return [`Best,`, name, contactBits, s.mailingAddress || "[mailing address]", OPT_OUT_LINE].join("\n");
}

function greeting(f: Firm): string {
  const first = firstName(f.contact);
  return `Hi ${first || "[first name]"},`;
}

export function buildDraft(kind: DraftKind, f: Firm, s: AppSettings): { subject: string; body: string } {
  const sender = s.senderName || "[your name]";
  const company = s.company || "[company]";
  const city = s.city || "[city]";
  switch (kind) {
    case "first":
      return {
        subject: `A free intake check for ${f.firm}`,
        body: [
          greeting(f),
          "",
          `I'm ${sender} with ${company}, a small tech company here in ${city}. I saw that ${f.firm} focuses on ${practicePhrase(f.practiceArea)}, and [one real detail from their website].`,
          "",
          "We recently studied how about 100 small law firms respond to new client inquiries. Most took over a day just to book a consult, and clients often sign with whichever firm answers first.",
          "",
          "Would you like a free, confidential speed check of your own intake? You'd get a one-page report with the results, and there's nothing you have to buy.",
          "",
          footer(s),
        ].join("\n"),
      };
    case "followup":
      return {
        subject: `Re: A free intake check for ${f.firm}`,
        body: [
          greeting(f),
          "",
          `Just following up on my note about a free, confidential intake speed check for ${f.firm}. If it would be useful, reply with a good time and I'll set it up. If not, no problem at all.`,
          "",
          footer(s),
        ].join("\n"),
      };
    case "report":
      return {
        subject: `Your intake speed check results, ${f.firm}`,
        body: [
          greeting(f),
          "",
          "Thank you for letting us run the speed check. Your one-page report is attached. It shows what a new client experienced and what instant intake would look like for your office.",
          "",
          "Would a 20-minute call to walk through it be helpful? [suggest two times]",
          "",
          footer(s),
        ].join("\n"),
      };
    case "recap":
      return {
        subject: `Recap of our call, ${f.firm}`,
        body: [
          greeting(f),
          "",
          "Thanks for your time today. Here's what I heard:",
          "",
          "- [their pain point, in their own words]",
          "- [second pain point, in their own words]",
          "",
          "Next step: [the agreed next step and date]",
          "",
          footer(s),
        ].join("\n"),
      };
  }
}

export function findPlaceholders(text: string): string[] {
  return [...new Set(text.match(/\[[^\]\n]{1,80}\]/g) ?? [])];
}

/** Milliseconds between two local date-time strings, or undefined if either is missing or invalid. */
export function between(from: string, to: string): number | undefined {
  if (!from || !to) return undefined;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return b - a;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = ms / 3_600_000;
  if (hours < 72) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} days`;
}

export function formatLocal(dt: string): string {
  const d = new Date(dt);
  if (!Number.isFinite(d.getTime())) return dt;
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** Text for one measured time: the measured duration, or "No reply after X (checked ...)". */
export function measured(sc: SpeedCheck, field: "firstReplyAt" | "consultBookedAt", none: string): string {
  const ms = between(sc.inquirySentAt, sc[field]);
  if (ms !== undefined) return formatDuration(ms);
  const waited = between(sc.inquirySentAt, sc.checkedAt);
  if (waited !== undefined) return `${none} after ${formatDuration(waited)} (checked ${formatLocal(sc.checkedAt)})`;
  return "";
}

/** Problems that must be fixed before a report can be approved. Empty means ready. */
export function reportProblems(sc: SpeedCheck | undefined): string[] {
  if (!sc) return ["No speed check has been logged."];
  const problems: string[] = [];
  if (!sc.channel.trim()) problems.push("How the inquiry was sent (website form, phone or email) is missing.");
  if (!sc.inquirySentAt) problems.push("The time the test inquiry was sent is missing.");
  for (const [field, label] of [
    ["firstReplyAt", "first reply"],
    ["consultBookedAt", "booked consult"],
  ] as const) {
    const ms = between(sc.inquirySentAt, sc[field]);
    if (sc[field] && ms === undefined) problems.push(`The ${label} time is not a valid date and time.`);
    if (ms !== undefined && ms < 0) problems.push(`The ${label} time is before the inquiry was sent.`);
  }
  const needsCheckTime = !sc.firstReplyAt || !sc.consultBookedAt;
  if (needsCheckTime) {
    const waited = between(sc.inquirySentAt, sc.checkedAt);
    if (waited === undefined) {
      problems.push('A reply or booking is missing, so fill in "Checked at" with when you last looked.');
    } else if (waited < 0) {
      problems.push('"Checked at" is before the inquiry was sent.');
    }
  }
  if (!sc.afterHours) problems.push("Answer whether they reply after hours or on weekends.");
  if (!sc.followUp) problems.push("Answer whether they followed up when there was no answer.");
  if (!sc.experience.trim()) problems.push('"What the client experienced" is empty.');
  return problems;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function reportHtml(f: Firm, s: AppSettings, preparedOn: Date): string {
  const sc = f.speedCheck;
  if (!sc) throw new Error("no speed check");
  const e = escapeHtml;
  const contact = f.contact || "your firm";
  const isDraft = sc.reportState === "draft";
  const date = preparedOn.toLocaleDateString("en-US", { dateStyle: "long" });
  const rows: [string, string, string][] = [
    ["Time to first reply", measured(sc, "firstReplyAt", "No reply") || "Not recorded", "Under a minute"],
    ["Time to booked consult", measured(sc, "consultBookedAt", "Not booked") || "Not recorded", "Booked during intake"],
    ["Reply after hours or on weekends", sc.afterHours || "Not recorded", "Yes"],
    ["Follow-up if no answer", sc.followUp || "Not recorded", "Yes"],
  ];
  const nextStepContact = [s.senderName, s.phone, s.email].filter(Boolean).join(" | ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Intake Speed Check: ${e(f.firm)}</title>
<style>
  :root { --ink:#1d2433; --muted:#5b6475; --line:#d9dee7; --accent:#2457c5; --paper:#fff; }
  * { box-sizing:border-box; }
  body { margin:0; background:#eef1f6; color:var(--ink); font:15px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { max-width:780px; margin:24px auto; background:var(--paper); padding:40px 48px; border-radius:6px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size:24px; margin:0 0 4px; }
  .meta { color:var(--muted); margin:0 0 24px; }
  .draft { background:#fff4d6; border:1px solid #f0c75e; padding:8px 12px; border-radius:4px; margin-bottom:20px; font-weight:600; }
  table { width:100%; border-collapse:collapse; margin:12px 0 24px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:#f5f7fb; font-size:13px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
  td:last-child { color:var(--accent); font-weight:600; }
  h2 { font-size:15px; margin:20px 0 4px; }
  p { margin:0 0 8px; }
  footer { margin-top:28px; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
  @media print { body { background:#fff; } main { box-shadow:none; margin:0; max-width:none; padding:24px; } .draft { display:block; } }
  @media (max-width:600px) { main { margin:0; padding:20px 16px; border-radius:0; } }
</style></head>
<body><main>
${isDraft ? '<div class="draft">DRAFT: not yet approved. Do not send.</div>' : ""}
<h1>Intake Speed Check: ${e(f.firm)}</h1>
<p class="meta">Prepared by ${e(s.company || "Futreeng")} for ${e(contact)}, ${e(date)}. Confidential, shared only with your firm.</p>
<h2>What we did</h2>
<p>With your permission, on ${e(sc.inquirySentAt ? formatLocal(sc.inquirySentAt) : "[date and time]")} we sent one new client inquiry through ${e(sc.channel || "[channel]")}, posing as someone needing ${e(sc.need || "estate planning help")}.</p>
<table>
<thead><tr><th>Measure</th><th>Your firm</th><th>With instant intake</th></tr></thead>
<tbody>
${rows.map(([m, yours, ours]) => `<tr><td>${e(m)}</td><td>${e(yours)}</td><td>${e(ours)}</td></tr>`).join("\n")}
</tbody></table>
<h2>What the client experienced</h2>
<p>${e(sc.experience || "[2 or 3 plain sentences, facts only]")}</p>
<h2>Why it matters</h2>
<p>Clients often sign with the first firm that responds. In our study of about 100 small firms, only 8% replied quickly, and even those took over a day to book a consult.</p>
<h2>What instant intake would look like for you</h2>
<p>${e(sc.instantIntake || DEFAULT_INSTANT_INTAKE)}</p>
<h2>Next step</h2>
<p>A 20-minute walkthrough of these results. ${e(nextStepContact)}</p>
<footer>All times above were measured, not estimated.${sc.approvedBy ? ` Reviewed by ${e(sc.approvedBy)}.` : ""}</footer>
</main></body></html>`;
}
