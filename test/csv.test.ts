import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, safeCell, toCsv } from "../src/csv.js";

test("round trip keeps commas, quotes and line breaks", () => {
  const rows = [
    ["Firm", "Notes"],
    ['Smith, Jones & "Partners"', "line one\nline two"],
    ["Plain", ""],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("parses CRLF, a byte order mark, and skips blank lines", () => {
  const text = "﻿Firm,Website\r\nA,a.com\r\n\r\nB,b.com\r\n";
  assert.deepEqual(parseCsv(text), [
    ["Firm", "Website"],
    ["A", "a.com"],
    ["B", "b.com"],
  ]);
});

test("cells that could run as spreadsheet formulas get an apostrophe", () => {
  assert.equal(safeCell("=HYPERLINK(\"http://x\")"), "'=HYPERLINK(\"http://x\")");
  assert.equal(safeCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(safeCell("+cmd"), "'+cmd");
  assert.equal(safeCell("-2+3"), "'-2+3");
});

test("phone numbers and normal text are left alone", () => {
  assert.equal(safeCell("+1 (330) 555-0100"), "+1 (330) 555-0100");
  assert.equal(safeCell("330-555-0100"), "330-555-0100");
  assert.equal(safeCell("Estate planning"), "Estate planning");
});
