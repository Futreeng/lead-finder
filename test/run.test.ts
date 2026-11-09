import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../src/csv.js";
import { run } from "../src/run.js";
import { PROSPECT_HEADER, REVIEW_NOTE, TRACKER_COLUMNS } from "../src/tracker.js";
import { html, startServer, text, type TestServer } from "./helpers.js";

async function firmServers(): Promise<{ small: TestServer; injury: TestServer; excluded: TestServer }> {
  const small = await startServer({
    "/robots.txt": text("User-agent: *\nAllow: /\n"),
    "/": html(`<a href="/attorneys/">Our Attorneys</a><p>Estate planning and probate.</p><a href="tel:3305550100">Call</a>`),
    "/attorneys/": html(`<a href="/attorneys/jane-doe/">Jane</a><a href="/attorneys/john-roe/">John</a><a href="/attorneys/ann-lee/">Ann</a>`),
  });
  const injury = await startServer({ "/": html(`<p>Car accidents and personal injury.</p>`) });
  const excluded = await startServer({ "/": html(`<p>Estate planning.</p>`) });
  return { small, injury, excluded };
}

function setup(servers: { small: TestServer; injury: TestServer; excluded: TestServer }) {
  const dir = mkdtempSync(join(tmpdir(), "lf-run-"));
  writeFileSync(
    join(dir, "seed.csv"),
    [
      "Firm,Website",
      `Small Estate Firm,${servers.small.origin}/`,
      `Small Estate Firm (again),${servers.small.origin}`,
      `Injury Firm,${servers.injury.origin}/`,
      `Opted Out Firm,${servers.excluded.origin}/`,
      "No Site Firm,",
    ].join("\n"),
  );
  writeFileSync(join(dir, "tracker.csv"), `Firm,Website,Status\nOpted Out Firm,${servers.excluded.origin}/,Opted out\n`);
  return dir;
}

test("end to end: writes tracker-ready CSVs, skips excluded firms without contacting them", async () => {
  const servers = await firmServers();
  const lines: string[] = [];
  try {
    const dir = setup(servers);
    const r = await run(["--seed", "seed.csv", "--exclude", "tracker.csv", "--delay-ms", "500"], {
      cwd: dir,
      env: {},
      stop: { env: {}, dirs: [dir] },
      log: (l) => lines.push(l),
    });
    assert.equal(r.exitCode, 0, lines.join("\n"));
    assert.equal(servers.excluded.hits.length, 0, "excluded firm's site was never requested");
    assert.equal(r.kept.length, 1);
    assert.equal(r.skipped.length, 2);

    const files = readdirSync(join(dir, "output")).sort();
    assert.equal(files.length, 2);
    const prospectsFile = files.find((f) => f.startsWith("prospects-"));
    assert.ok(prospectsFile);
    const rows = parseCsv(readFileSync(join(dir, "output", prospectsFile), "utf8"));
    assert.deepEqual(rows[0], PROSPECT_HEADER);
    assert.deepEqual(rows[0]?.slice(0, TRACKER_COLUMNS.length), [...TRACKER_COLUMNS]);
    const row = rows[1] ?? [];
    assert.equal(row[0], "Small Estate Firm");
    assert.equal(row[2], "3");
    assert.equal(row[3], "estate planning, probate");
    assert.equal(row[5], "Researched");
    assert.ok(row[8]?.includes(REVIEW_NOTE));
    assert.equal(row[9], "3305550100");

    const skipped = parseCsv(readFileSync(join(dir, "output", files.find((f) => f.startsWith("skipped-"))!), "utf8"));
    assert.deepEqual(
      skipped.slice(1).map((s) => [s[0], s[2]]),
      [
        ["Injury Firm", "No estate planning keywords found on the pages checked"],
        ["No Site Firm", "Website not checked (no website listed), research by hand"],
      ],
    );
    assert.ok(lines.some((l) => l.includes("Removed 1 repeat(s)")));
    assert.ok(lines.some((l) => l.includes("Nothing was sent to anyone")));
  } finally {
    await Promise.all(Object.values(servers).map((s) => s.close()));
  }
});

test("dry run with a limit writes no files", async () => {
  const servers = await firmServers();
  try {
    const dir = setup(servers);
    const lines: string[] = [];
    const r = await run(["--seed", "seed.csv", "--dry-run", "--limit", "1", "--delay-ms", "500"], {
      cwd: dir,
      env: {},
      stop: { env: {}, dirs: [dir] },
      log: (l) => lines.push(l),
    });
    assert.equal(r.exitCode, 0, lines.join("\n"));
    assert.equal(r.kept.length + r.skipped.length, 1);
    assert.equal(existsSync(join(dir, "output")), false);
    assert.equal(servers.injury.hits.length, 0, "limit 1 means only the first firm was checked");
  } finally {
    await Promise.all(Object.values(servers).map((s) => s.close()));
  }
});

test("off switch on: nothing runs and no site is contacted", async () => {
  const servers = await firmServers();
  try {
    const dir = setup(servers);
    writeFileSync(join(dir, "STOP"), "");
    const lines: string[] = [];
    const r = await run(["--seed", "seed.csv"], { cwd: dir, env: {}, stop: { env: {}, dirs: [dir] }, log: (l) => lines.push(l) });
    assert.equal(r.exitCode, 2);
    assert.match(lines[0] ?? "", /Off switch is on/);
    assert.equal(servers.small.hits.length + servers.injury.hits.length + servers.excluded.hits.length, 0);
  } finally {
    await Promise.all(Object.values(servers).map((s) => s.close()));
  }
});

test("bad options are explained, not guessed", async () => {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "lf-args-"));
  const r1 = await run(["--delay-ms", "10", "--seed", "x.csv"], { cwd: dir, env: {}, stop: { env: {}, dirs: [dir] }, log: (l) => lines.push(l) });
  assert.equal(r1.exitCode, 1);
  assert.match(lines.at(-1) ?? "", /--delay-ms must be a whole number of at least 500/);
  const r2 = await run(["--frobnicate"], { cwd: dir, env: {}, stop: { env: {}, dirs: [dir] }, log: (l) => lines.push(l) });
  assert.equal(r2.exitCode, 1);
  const r3 = await run([], { cwd: dir, env: {}, stop: { env: {}, dirs: [dir] }, log: (l) => lines.push(l) });
  assert.equal(r3.exitCode, 1);
  assert.match(lines.at(-1) ?? "", /give --seed/);
});
