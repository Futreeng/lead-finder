import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoppedError, assertNotStopped, stopReason } from "../src/killswitch.js";

test("STOP file turns the tool off", () => {
  const dir = mkdtempSync(join(tmpdir(), "lf-stop-"));
  assert.equal(stopReason({ env: {}, dirs: [dir] }), null);
  writeFileSync(join(dir, "STOP"), "");
  assert.match(stopReason({ env: {}, dirs: [dir] }) ?? "", /STOP file found/);
  assert.throws(() => assertNotStopped({ env: {}, dirs: [dir] }), StoppedError);
});

test("LEAD_FINDER_DISABLED turns the tool off unless it is 0 or false", () => {
  const dir = mkdtempSync(join(tmpdir(), "lf-env-"));
  assert.equal(stopReason({ env: { LEAD_FINDER_DISABLED: "1" }, dirs: [dir] }), "LEAD_FINDER_DISABLED is set");
  assert.equal(stopReason({ env: { LEAD_FINDER_DISABLED: "yes" }, dirs: [dir] }), "LEAD_FINDER_DISABLED is set");
  assert.equal(stopReason({ env: { LEAD_FINDER_DISABLED: "0" }, dirs: [dir] }), null);
  assert.equal(stopReason({ env: { LEAD_FINDER_DISABLED: "false" }, dirs: [dir] }), null);
});
