import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, parseRobots } from "../src/robots.js";

const SAMPLE = `
# comment line
User-agent: *
Disallow: /private
Allow: /private/ok
Crawl-delay: 3

User-agent: FutreengLeadFinder
Disallow: /no-bots
`;

test("the * group applies to other bots", () => {
  const rules = parseRobots(SAMPLE, "OtherBot");
  assert.equal(isAllowed("/", rules), true);
  assert.equal(isAllowed("/private", rules), false);
  assert.equal(isAllowed("/privateX", rules), false, "rules are prefix matches");
  assert.equal(isAllowed("/private/ok/page", rules), true, "longer Allow wins");
  assert.equal(rules.crawlDelaySec, 3);
});

test("a group naming our bot replaces the * group", () => {
  const rules = parseRobots(SAMPLE, "FutreengLeadFinder");
  assert.equal(isAllowed("/private", rules), true);
  assert.equal(isAllowed("/no-bots/x", rules), false);
  assert.equal(rules.crawlDelaySec, undefined);
});

test("empty Disallow allows everything", () => {
  const rules = parseRobots("User-agent: *\nDisallow:\n", "FutreengLeadFinder");
  assert.equal(isAllowed("/anything", rules), true);
});

test("Disallow: / blocks everything", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /\n", "FutreengLeadFinder");
  assert.equal(isAllowed("/", rules), false);
  assert.equal(isAllowed("/attorneys/", rules), false);
});

test("wildcards and $ anchors", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=\n", "X");
  assert.equal(isAllowed("/files/a.pdf", rules), false);
  assert.equal(isAllowed("/files/a.pdf?download=1", rules), true);
  assert.equal(isAllowed("/search?q=wills", rules), false);
  assert.equal(isAllowed("/searching", rules), true);
});

test("several user-agent lines share one group", () => {
  const rules = parseRobots("User-agent: a\nUser-agent: *\nDisallow: /x\n", "Whatever");
  assert.equal(isAllowed("/x", rules), false);
});

test("equal-length Allow and Disallow: Allow wins", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\n", "X");
  assert.equal(isAllowed("/page", rules), true);
});
