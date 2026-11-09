import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings } from "../src/config.js";
import { enrichCandidate, findEsqNames, findProfileLinks } from "../src/enrich.js";
import { decide } from "../src/filter.js";
import { extractLinks } from "../src/html.js";
import { FakeFetcher, page, profileLinks } from "./helpers.js";

const s = defaultSettings({});

test("small estate planning firm: counts 3 attorneys, finds phone and email", async () => {
  const fetcher = new FakeFetcher({
    "https://www.maple-estate.test/": page(
      `<nav><a href="/attorneys/">Our Attorneys</a> <a href="/practice-areas/">Practice Areas</a></nav>
       <p>Estate planning and probate for Akron families.</p>
       <script>var noise = "personal injury";</script>
       <a href="tel:+13305550100">Call us</a> <a href="mailto:info@maple-estate.test">Email</a>`,
      "Maple Estate Law | Wills and Trusts",
    ),
    "https://www.maple-estate.test/attorneys/": page(
      `<a href="/attorneys/jane-doe/">Jane Doe</a>
       <a href="/attorneys/john-roe/">John Roe</a>
       <a href="/attorneys/ann-lee.html">Ann Lee</a>
       <a href="/attorneys/jane-doe/#bio">Jane again</a>
       <a href="/attorneys/practice-areas/">Practice areas</a>
       <a href="/attorneys/">All attorneys</a>
       <a href="https://othersite.test/attorneys/x-y/">Someone elsewhere</a>`,
    ),
  });
  const e = await enrichCandidate({ firm: "Maple Estate Law", website: "https://www.maple-estate.test/", source: "test" }, fetcher, s);
  assert.equal(e.checked, true);
  assert.equal(e.attorneyCount, 3);
  assert.equal(e.attorneyCountMayIncludeStaff, false);
  assert.match(e.attorneyCountNote ?? "", /3 profile link\(s\) on https:\/\/www\.maple-estate\.test\/attorneys\//);
  assert.deepEqual(e.practiceTerms, ["estate planning", "wills", "trusts", "probate"]);
  assert.equal(e.phone, "+13305550100");
  assert.equal(e.publicEmail, "info@maple-estate.test");
  assert.deepEqual(decide(e, s), { keep: true, reason: "Practice and size match" });
  assert.equal(fetcher.requested.length, 2, "practice page not needed once keywords are found");
});

test("firm above 10 attorneys is skipped", async () => {
  const fetcher = new FakeFetcher({
    "https://big.test/": page(`<a href="/lawyers">Lawyers</a><p>Estate planning</p>`),
    "https://big.test/lawyers": page(profileLinks("lawyers", 12)),
  });
  const e = await enrichCandidate({ firm: "Big", website: "big.test", source: "test" }, fetcher, s);
  assert.equal(e.attorneyCount, 12);
  assert.deepEqual(decide(e, s), { keep: false, reason: "12 attorneys detected, above 10" });
});

test("team page that may include staff is kept but flagged instead of skipped", async () => {
  const fetcher = new FakeFetcher({
    "https://mixed.test/": page(`<a href="/our-team/">Our Team</a><p>Probate</p>`),
    "https://mixed.test/our-team/": page(profileLinks("our-team", 14)),
  });
  const e = await enrichCandidate({ firm: "Mixed", website: "https://mixed.test/", source: "test" }, fetcher, s);
  assert.equal(e.attorneyCount, 14);
  assert.equal(e.attorneyCountMayIncludeStaff, true);
  const d = decide(e, s);
  assert.equal(d.keep, true);
  assert.match(d.reason, /may include staff/);
});

test("solo practice found through an Esq. mention is skipped", async () => {
  const fetcher = new FakeFetcher({
    "https://solo.test/": page(`<p>Estate planning by Attorney John Q. Public, Esq. in Akron.</p>`),
  });
  const e = await enrichCandidate({ firm: "Solo", website: "https://solo.test/", source: "test" }, fetcher, s);
  assert.equal(e.attorneyCount, 1);
  assert.equal(decide(e, s).keep, false);
  assert.match(decide(e, s).reason, /may be a solo practice/);
});

test("no attorney info: kept and marked unverified, never guessed", async () => {
  const fetcher = new FakeFetcher({
    "https://quiet.test/": page(`<p>We help with wills and probate.</p>`),
  });
  const e = await enrichCandidate({ firm: "Quiet", website: "https://quiet.test/", source: "test" }, fetcher, s);
  assert.equal(e.attorneyCount, undefined);
  assert.deepEqual(decide(e, s), { keep: true, reason: "Attorney count unverified, check by hand" });
});

test("keywords found on the practice page when the homepage has none", async () => {
  const fetcher = new FakeFetcher({
    "https://deep.test/": page(`<p>Welcome to our firm.</p><a href="/services/">What we do</a>`),
    "https://deep.test/services/": page(`<h1>Probate and trust administration</h1>`),
  });
  const e = await enrichCandidate({ firm: "Deep", website: "https://deep.test/", source: "test" }, fetcher, s);
  assert.deepEqual(e.practiceTerms, ["trust administration", "probate"]);
});

test("firm with no estate planning keywords is skipped unless asked to keep it", async () => {
  const fetcher = new FakeFetcher({
    "https://injury.test/": page(`<p>Car accidents and personal injury.</p>`),
  });
  const e = await enrichCandidate({ firm: "Injury", website: "https://injury.test/", source: "test" }, fetcher, s);
  assert.equal(decide(e, s).keep, false);
  assert.equal(decide(e, { ...s, includeUnmatched: true }).keep, true);
});

test("site that cannot be read is skipped with the reason", async () => {
  const fetcher = new FakeFetcher({ "https://down.test/": { fail: "timed out" } });
  const e = await enrichCandidate({ firm: "Down", website: "https://down.test/", source: "test" }, fetcher, s);
  assert.equal(e.checked, false);
  assert.match(decide(e, s).reason, /timed out/);
});

test("website without http(s) tries https first, then http", async () => {
  const fetcher = new FakeFetcher({ "http://oldsite.test/": page(`<p>Estate planning</p>`) });
  const e = await enrichCandidate({ firm: "Old", website: "oldsite.test", source: "test" }, fetcher, s);
  assert.deepEqual(fetcher.requested, ["https://oldsite.test/", "http://oldsite.test/"]);
  assert.equal(e.checked, true);
  assert.equal(e.website, "http://oldsite.test/");
});

test("no website at all: nothing is fetched", async () => {
  const fetcher = new FakeFetcher({});
  const e = await enrichCandidate({ firm: "Paper Only", source: "test" }, fetcher, s);
  assert.equal(fetcher.requested.length, 0);
  assert.equal(e.checkError, "no website listed");
});

test("profile link rules: attorney folders win over team folders", () => {
  const links = extractLinks(
    `<a href="/attorneys/jane-doe">a</a><a href="/about/our-team/sam-lee/">b</a><a href="/team/overview">c</a>
     <a href="/attorneys/123">d</a><a href="/blog/some-post">e</a><a href="/attorneys/jane-doe/bio">f</a>`,
    "https://x.test/",
  );
  const p = findProfileLinks(links, "x.test");
  assert.deepEqual(p.paths, ["/attorneys/jane-doe"]);
  assert.equal(p.mayIncludeStaff, false);
});

test("profile link rules: team folders are a flagged fallback, /staff/ never counts", () => {
  const links = extractLinks(
    `<a href="/about/our-team/sam-lee/">a</a><a href="/team/overview">b</a><a href="/staff/pat-jones/">c</a>`,
    "https://x.test/",
  );
  const p = findProfileLinks(links, "x.test");
  assert.deepEqual(p.paths, ["/about/our-team/sam-lee"]);
  assert.equal(p.mayIncludeStaff, true);
});

test("regression: staff profiles under /staff/ do not inflate the attorney count", async () => {
  // Same URL shape as a real Akron firm whose menu links 10 /attorneys/ and 10 /staff/ profiles.
  const nav = `${profileLinks("attorneys", 10)}\n${profileLinks("staff", 10)}`;
  const fetcher = new FakeFetcher({
    "https://tenfirm.test/": page(`<nav><a href="/attorneys/">Attorneys</a>${nav}</nav><p>Estate planning and probate.</p>`),
    "https://tenfirm.test/attorneys/": page(`<nav>${nav}</nav>${profileLinks("attorneys", 10)}`),
  });
  const e = await enrichCandidate({ firm: "Ten", website: "https://tenfirm.test/", source: "test" }, fetcher, s);
  assert.equal(e.attorneyCount, 10);
  assert.equal(e.attorneyCountMayIncludeStaff, false);
  assert.deepEqual(decide(e, s), { keep: true, reason: "Practice and size match" });
});

test("Esq. names are counted once each", () => {
  assert.deepEqual(findEsqNames("Mary Jo Smith, Esq. and Tom Brown Esq. Also Mary Jo Smith, Esq."), ["Mary Jo Smith", "Tom Brown"]);
});
