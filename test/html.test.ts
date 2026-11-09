import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractLinks, firstMailto, firstTel, htmlToText, matchKeywords, pageTitle } from "../src/html.js";

test("text skips scripts, styles and comments, and decodes entities", () => {
  const html = `<p>Wills &amp; Trusts</p><script>var x = "personal injury";</script><style>.a{}</style><!-- probate --><p>Estate&nbsp;planning &#169; 2026</p>`;
  assert.equal(htmlToText(html), "Wills & Trusts Estate planning © 2026");
});

test("links resolve against the page address", () => {
  const links = extractLinks(
    `<a href="/attorneys/">Our Attorneys</a> <a class="x" href='team/jane-doe'>Jane</a> <a data-href="/no" href=https://other.test/a>Other</a>`,
    "https://firm.test/about/",
  );
  assert.deepEqual(
    links.map((l) => [l.url?.href, l.text]),
    [
      ["https://firm.test/attorneys/", "Our Attorneys"],
      ["https://firm.test/about/team/jane-doe", "Jane"],
      ["https://other.test/a", "Other"],
    ],
  );
});

test("mailto and tel links", () => {
  const links = extractLinks(
    `<a href="mailto:Info@Firm.test?subject=Hi">Email</a><a href="tel:+1-330-555-0100">Call</a>`,
    "https://firm.test/",
  );
  assert.equal(firstMailto(links), "info@firm.test");
  assert.equal(firstTel(links), "+1-330-555-0100");
});

test("keywords match whole words only, any case", () => {
  const found = matchKeywords("We handle Estate  Planning and probate. Willsburg office.", ["estate planning", "probate", "wills"]);
  assert.deepEqual(found, ["estate planning", "probate"]);
});

test("page title", () => {
  assert.equal(pageTitle("<title>\n Maple &amp; Oak Law </title>"), "Maple & Oak Law");
});

test("entity decoding leaves unknown entities as they are", () => {
  assert.equal(decodeEntities("a &bogus; b &#65;"), "a &bogus; b A");
});
