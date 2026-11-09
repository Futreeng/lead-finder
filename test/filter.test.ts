import { test } from "node:test";
import assert from "node:assert/strict";
import { applyExclusions, dedupe, parseExclusions } from "../src/filter.js";

test("same website with and without www counts once, gaps are filled", () => {
  const { kept, duplicates } = dedupe([
    { firm: "Maple Law", website: "https://www.maple.test/", source: "a" },
    { firm: "Maple Law LLC", website: "maple.test", phone: "330-555-0100", source: "b" },
    { firm: "Oak Law", source: "a" },
    { firm: "OAK LAW", source: "b" },
  ]);
  assert.equal(duplicates, 2);
  assert.equal(kept.length, 2);
  assert.equal(kept[0]?.phone, "330-555-0100");
});

test("tracker export: website and firm name columns are both used", () => {
  const keys = parseExclusions("Firm,Contact,Website,Status\nMaple Law,,https://www.maple.test/,Opted out\nPaper Firm,,,Researched\n");
  const { kept, excluded } = applyExclusions(
    [
      { firm: "Maple Law Group", website: "maple.test", source: "s" },
      { firm: "Paper Firm", website: "https://paperfirm.test/", source: "s" },
      { firm: "New Firm", website: "https://new.test/", source: "s" },
    ],
    keys,
  );
  assert.deepEqual(excluded.map((c) => c.firm), ["Maple Law Group", "Paper Firm"]);
  assert.deepEqual(kept.map((c) => c.firm), ["New Firm"]);
});

test("plain list of websites", () => {
  const keys = parseExclusions("maple.test\nhttps://www.oak.test/contact\n");
  assert.deepEqual([...keys].sort(), ["maple.test", "oak.test"]);
});
