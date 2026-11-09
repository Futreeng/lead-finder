import { test } from "node:test";
import assert from "node:assert/strict";
import { PoliteFetcher, type PoliteFetcherOptions } from "../src/http.js";
import { StoppedError } from "../src/killswitch.js";
import { html, redirect, startServer, text } from "./helpers.js";

function makeFetcher(extra: Partial<PoliteFetcherOptions> = {}) {
  const waits: number[] = [];
  const fetcher = new PoliteFetcher({
    userAgent: "FutreengLeadFinder/test",
    agentToken: "FutreengLeadFinder",
    delayMs: 1000,
    timeoutMs: 5000,
    maxBytes: 1000,
    stopCheck: () => {},
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra,
  });
  return { fetcher, waits };
}

test("obeys robots.txt and waits between requests to the same site", async () => {
  const srv = await startServer({
    "/robots.txt": text("User-agent: *\nDisallow: /secret\n"),
    "/": html("<p>home</p>"),
    "/secret": html("<p>secret</p>"),
  });
  try {
    const { fetcher, waits } = makeFetcher();
    const home = await fetcher.get(`${srv.origin}/`);
    assert.equal(home.ok, true);
    const secret = await fetcher.get(`${srv.origin}/secret`);
    assert.deepEqual(secret, { ok: false, url: `${srv.origin}/secret`, reason: "blocked by the site's robots.txt" });
    assert.deepEqual(srv.hits, ["/robots.txt", "/"], "the blocked page was never requested");
    assert.equal(waits.length, 1, "second request to the same site waited");
    assert.ok((waits[0] ?? 0) > 0 && (waits[0] ?? 0) <= 1000);
  } finally {
    await srv.close();
  }
});

test("robots.txt server error means skip the site; missing robots.txt means allowed", async () => {
  const broken = await startServer({ "/robots.txt": text("oops", 500), "/": html("<p>x</p>") });
  const missing = await startServer({ "/": html("<p>x</p>") });
  try {
    const { fetcher } = makeFetcher();
    const a = await fetcher.get(`${broken.origin}/`);
    assert.equal(a.ok, false);
    assert.match(a.ok ? "" : a.reason, /robots\.txt could not be read/);
    assert.deepEqual(broken.hits, ["/robots.txt"]);
    const b = await fetcher.get(`${missing.origin}/`);
    assert.equal(b.ok, true);
  } finally {
    await broken.close();
    await missing.close();
  }
});

test("redirects are followed and robots.txt is checked on the new site", async () => {
  const blocked = await startServer({ "/robots.txt": text("User-agent: *\nDisallow: /\n"), "/page": html("<p>no</p>") });
  const start = await startServer({
    "/same": redirect("/final"),
    "/final": html("<p>final</p>"),
    "/away": redirect(`${blocked.origin}/page`, 302),
  });
  try {
    const { fetcher } = makeFetcher();
    const same = await fetcher.get(`${start.origin}/same`);
    assert.equal(same.ok && same.url, `${start.origin}/final`);
    const away = await fetcher.get(`${start.origin}/away`);
    assert.equal(away.ok, false);
    assert.match(away.ok ? "" : away.reason, /robots\.txt/);
    assert.ok(!blocked.hits.includes("/page"), "page on the blocking site was never requested");
  } finally {
    await start.close();
    await blocked.close();
  }
});

test("large pages are cut off, non-HTML and 404 are refused", async () => {
  const srv = await startServer({
    "/big": html("x".repeat(5000)),
    "/file.pdf": (_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF");
    },
  });
  try {
    const { fetcher } = makeFetcher();
    const big = await fetcher.get(`${srv.origin}/big`);
    assert.equal(big.ok && big.body.length, 1000);
    const pdf = await fetcher.get(`${srv.origin}/file.pdf`);
    assert.match(pdf.ok ? "" : pdf.reason, /not a web page/);
    const gone = await fetcher.get(`${srv.origin}/gone`);
    assert.equal(gone.ok ? "" : gone.reason, "HTTP 404");
  } finally {
    await srv.close();
  }
});

test("off switch stops before any request is sent", async () => {
  const srv = await startServer({ "/": html("<p>x</p>") });
  try {
    const { fetcher } = makeFetcher({
      stopCheck: () => {
        throw new StoppedError("test");
      },
    });
    await assert.rejects(fetcher.get(`${srv.origin}/`), StoppedError);
    assert.equal(srv.hits.length, 0);
    assert.equal(fetcher.requestCount, 0);
  } finally {
    await srv.close();
  }
});

test("Crawl-delay longer than our delay is respected", async () => {
  const srv = await startServer({ "/robots.txt": text("User-agent: *\nCrawl-delay: 5\n"), "/": html("<p>x</p>") });
  try {
    const { fetcher, waits } = makeFetcher();
    await fetcher.get(`${srv.origin}/`);
    assert.equal(waits.length, 1);
    assert.ok((waits[0] ?? 0) > 1000, `waited ${waits[0]} ms, expected close to 5000`);
  } finally {
    await srv.close();
  }
});
