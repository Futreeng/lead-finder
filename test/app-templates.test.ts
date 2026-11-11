import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultAppSettings, type Firm, type SpeedCheck } from "../src/app/model.js";
import { escapeHtml, findPlaceholders, firstName, formatDuration, measured, practicePhrase, reportHtml, reportProblems } from "../src/app/templates.js";

test("first names from contact fields", () => {
  assert.equal(firstName("Jane Doe, Managing Partner"), "Jane");
  assert.equal(firstName("Attorney John Roe"), "John");
  assert.equal(firstName(""), "");
});

test("practice phrase picks the most useful two keywords or leaves a placeholder", () => {
  assert.equal(practicePhrase("estate planning, estate plan, trusts, probate"), "estate planning and probate");
  assert.equal(practicePhrase("elder law"), "elder law");
  assert.equal(practicePhrase(""), "[practice area]");
});

test("placeholders are found once each", () => {
  assert.deepEqual(findPlaceholders("Hi [first name], [first name] [x]"), ["[first name]", "[x]"]);
});

test("durations read like a person wrote them", () => {
  assert.equal(formatDuration(45 * 60_000), "45 minutes");
  assert.equal(formatDuration(26 * 3_600_000), "26 hours");
  assert.equal(formatDuration(80 * 3_600_000), "3.3 days");
});

function sc(over: Partial<SpeedCheck> = {}): SpeedCheck {
  return {
    channel: "website form",
    need: "estate planning help",
    inquirySentAt: "2026-11-11T09:00",
    firstReplyAt: "2026-11-12T11:00",
    consultBookedAt: "",
    checkedAt: "2026-11-14T09:00",
    afterHours: "No",
    followUp: "No",
    experience: "Reply came the next day.",
    instantIntake: "",
    reportState: "draft",
    ...over,
  };
}

test("measured times say when nothing happened, with when it was checked", () => {
  assert.equal(measured(sc(), "firstReplyAt", "No reply"), "26 hours");
  assert.match(measured(sc(), "consultBookedAt", "Not booked"), /^Not booked after 3 days \(checked /);
});

test("report problems list what is missing", () => {
  assert.deepEqual(reportProblems(sc()), []);
  assert.match(reportProblems(sc({ experience: "", afterHours: "" })).join(" "), /after hours.*experienced/);
});

test("report escapes everything that came from a website or a form", () => {
  const f = {
    firm: '<script>alert("x")</script> Law',
    contact: "Jane",
    speedCheck: sc({ experience: "<img src=x onerror=alert(1)>" }),
  } as unknown as Firm;
  const html = reportHtml(f, { ...defaultAppSettings(), senderName: "Frankie" }, new Date("2026-11-14T12:00:00Z"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes(escapeHtml('<script>alert("x")</script> Law')));
  assert.match(html, /DRAFT: not yet approved/);
});
