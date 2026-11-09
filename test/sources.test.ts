import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverpassQuery, OSM_SOURCE, parseNear, parseOverpass } from "../src/sources/osm.js";
import { parseSeed } from "../src/sources/seed.js";

test("seed file with flexible header names", () => {
  const { candidates, warnings } = parseSeed("Firm Name,URL,Telephone\nMaple Law,maple.test,330-555-0100\n,nofirm.test,\n", "akron.csv");
  assert.deepEqual(candidates, [{ firm: "Maple Law", website: "maple.test", phone: "330-555-0100", address: undefined, source: "seed: akron.csv" }]);
  assert.deepEqual(warnings, ["akron.csv: row 3 has no firm name, skipped"]);
});

test("seed file without a Firm column is refused", () => {
  const { candidates, warnings } = parseSeed("Website\nmaple.test\n", "bad.csv");
  assert.equal(candidates.length, 0);
  assert.match(warnings[0] ?? "", /needs a header row with a "Firm" column/);
});

test("Overpass query asks only for law offices around the point", () => {
  assert.equal(
    buildOverpassQuery({ lat: 41.08, lon: -81.52, radiusKm: 15 }),
    '[out:json][timeout:60];nwr["office"="lawyer"](around:15000,41.08,-81.52);out center tags;',
  );
});

test("Overpass reply becomes candidates; unnamed offices are dropped", () => {
  const out = parseOverpass({
    elements: [
      { tags: { office: "lawyer", name: "Maple Law", "contact:website": "https://maple.test", phone: "+1 330 555 0100", "addr:housenumber": "1", "addr:street": "Main St", "addr:city": "Akron", "addr:state": "OH" } },
      { tags: { office: "lawyer" } },
      { tags: { office: "lawyer", name: "Oak Law" } },
    ],
  });
  assert.deepEqual(out, [
    { firm: "Maple Law", website: "https://maple.test", phone: "+1 330 555 0100", address: "1 Main St, Akron, OH", source: OSM_SOURCE },
    { firm: "Oak Law", website: undefined, phone: undefined, address: undefined, source: OSM_SOURCE },
  ]);
});

test("bad --near values are rejected", () => {
  assert.throws(() => parseNear("akron", 10), /latitude,longitude/);
  assert.throws(() => parseNear("200,10", 10), /out of range/);
  assert.throws(() => parseNear("41,-81", 500), /between 0 and 50/);
  assert.deepEqual(parseNear(" 41.08 , -81.52 ", 15), { lat: 41.08, lon: -81.52, radiusKm: 15 });
});
