import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { editDistance, tokenSim } from "@/search/fuzzy";
import { abbreviate, looksLikeAddress, normKey, splitIntersection, tokenize } from "@/search/normalize";
import { matchScore, PlaceIndex } from "@/search/placeIndex";
import { toResults } from "@/search/geocode";
import { makeChangeset } from "@/world/world";
import type { Building, Street } from "@/world/types";

describe("normalisation", () => {
  it("reduces street names to the same tokens however they are written", () => {
    expect(tokenize("West Twenty-first Street").map((t) => t.t)).toEqual(["w", "21", "st"]);
    for (const s of ["W 21st St", "west 21st street", "W. 21st St.", "West 21 Street", "west twenty first street"]) expect(normKey(s)).toBe("w 21 st");
    expect(normKey("Congress Avenue")).toBe(normKey("congress ave"));
    expect(normKey("Martin Luther King Jr Boulevard")).toBe("mlk jr blvd");
    expect(normKey("Perry-Castañeda Library")).toBe("perry castaneda library");
    // types and directions are soft, names are not
    const t = tokenize("South Congress Avenue");
    expect(t.map((x) => x.soft)).toEqual([true, false, true]);
  });

  it("splits intersections however they are joined", () => {
    expect(splitIntersection("21st & Guadalupe")).toEqual(["21st", "Guadalupe"]);
    expect(splitIntersection("21st and guadalupe")).toEqual(["21st", "guadalupe"]);
    expect(splitIntersection("W 21st St / Guadalupe St")).toEqual(["W 21st St", "Guadalupe St"]);
    expect(splitIntersection("lamar at 6th")).toEqual(["lamar", "6th"]);
    expect(splitIntersection("republic square")).toBeNull();
  });

  it("abbreviates for display and recognises addresses", () => {
    expect(abbreviate("West 21st Street")).toBe("W 21st St");
    expect(abbreviate("East Avenue")).toBe("East Ave");
    expect(abbreviate("South Congress Avenue")).toBe("S Congress Ave");
    expect(looksLikeAddress("101 e 21st st")).toBe(true);
    expect(looksLikeAddress("21st street")).toBe(false);
  });
});

describe("fuzzy tokens", () => {
  it("counts edits with a cut-off", () => {
    expect(editDistance("guadalupe", "guadelupe", 2)).toBe(1);
    expect(editDistance("republic", "repbulic", 2)).toBe(1); // a swap is one edit
    expect(editDistance("congress", "lamar", 2)).toBe(3);
  });

  it("prefers exact over prefix over typo, and never fuzzes numbers", () => {
    const exact = tokenSim("guadalupe", "guadalupe", false, false);
    const prefix = tokenSim("guad", "guadalupe", true, false);
    const typo = tokenSim("guadelupe", "guadalupe", false, false);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(typo);
    expect(typo).toBeGreaterThan(0);
    expect(tokenSim("21", "22", false, true)).toBe(0);
    expect(tokenSim("21", "210", false, true)).toBe(0);
    expect(tokenSim("2", "21", true, true)).toBeGreaterThan(0);
  });

  it("scores names against queries", () => {
    expect(matchScore("congress ave", "Congress Avenue")).toBeGreaterThan(matchScore("congress ave", "South Congress Avenue"));
    expect(matchScore("101 e 21st", "101 West 21st Street")).toBeLessThan(matchScore("101 e 21st", "101 East 21st Street"));
    expect(matchScore("lamar", "Congress Avenue")).toBe(-1);
  });
});

describe("place index on Austin", () => {
  let R: ReturnType<typeof loadHeadless>;
  let ix: PlaceIndex;
  beforeAll(() => {
    R = loadHeadless("austin");
    ix = new PlaceIndex(R.world);
  });
  const top = (q: string) => ix.search(q)[0];

  it("finds intersections written every way", () => {
    for (const q of ["21st & Guadalupe", "21st and guadalupe", "W 21st St / Guadalupe St", "guadalupe & 21st", "21st guadalupe", "twenty-first and guadalupe"]) {
      const r = top(q);
      expect(r?.kind, q).toBe("intersection");
      // named in the order asked
      expect(r.label.split(" & ").sort()).toEqual(["Guadalupe St", "W 21st St"]);
      expect(r.detail).toMatch(/^Intersection/);
    }
    expect(top("cesar chavez & congress")?.label).toBe("E Cesar Chavez St & Congress Ave");
  });

  it("finds streets as whole streets", () => {
    const r = top("Congress Ave");
    expect(r.kind).toBe("street");
    expect(r.label).toBe("Congress Avenue");
    expect(r.ids.length).toBeGreaterThan(5);
    expect(r.detail).toMatch(/^Street · \d+(\.\d)? mi$/);
    expect(top("6th street")?.label).toMatch(/6th Street$/);
    expect(top("mlk")?.label).toMatch(/Martin Luther King Jr Boulevard/);
  });

  it("finds named places, POIs and buildings, tolerating typos", () => {
    expect(top("republic square")).toMatchObject({ label: "Republic Square", kind: "park" });
    expect(top("republc sqare")?.label).toBe("Republic Square");
    expect(top("guadelupe")?.label).toBe("Guadalupe Street");
    expect(top("hancock")).toMatchObject({ label: "Hancock", kind: "neighbourhood" });
    expect(top("texas state capitol")?.label).toBe("Texas State Capitol");
    // what a place is outranks what it is named after, and the notable one leads
    expect(top("capitol")?.label).toBe("Texas State Capitol");
    expect(top("capitol building")?.label).toBe("Texas State Capitol");
    expect(top("main building")?.label).toBe("Main Building");
    // a campus mapped in parts is one result
    const uni = ix.search("university");
    expect(uni[0]).toMatchObject({ label: "University of Texas at Austin", kind: "campus" });
    expect(uni.filter((r) => r.label === "University of Texas at Austin" && r.detail === "Campus")).toHaveLength(1);
    expect(top("perry castaneda")?.label).toBe("Perry-Castañeda Library");
  });

  it("finds addresses in the data, and places one that is not between its neighbours", () => {
    const a = top("101 e 21st st");
    expect(a.label).toBe("101 E 21st St");
    expect(a.detail).toBe("Perry-Castañeda Library");
    // the West side has its own 101
    expect(ix.search("101 e 21st st").some((r) => r.label.startsWith("101 W"))).toBe(false);
    const est = top("1100 congress");
    expect(est).toMatchObject({ kind: "address", label: "1100 Congress Ave" });
    expect(est.detail).toMatch(/^Approximate address/);
  });

  it("returns at most five places, and nothing for nonsense", () => {
    expect(ix.search("park").length).toBeLessThanOrEqual(5);
    expect(ix.search("xyzzy plugh")).toEqual([]);
    // one row per place: the park is not repeated as its area and its point of interest
    expect(ix.search("republic square").filter((r) => r.label === "Republic Square")).toHaveLength(1);
  });

  it("answers each keystroke within a few milliseconds", () => {
    const fresh = new PlaceIndex(R.world);
    fresh.search("warm");
    const times: number[] = [];
    for (const q of ["21st & guadalupe", "republic square", "congress avenue", "1100 congress"])
      for (let i = 1; i <= q.length; i++) {
        const t = performance.now();
        fresh.search(q.slice(0, i));
        times.push(performance.now() - t);
      }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    // < 5 ms on an idle machine; generous here because suites run in parallel
    expect(median).toBeLessThan(10);
    fresh.dispose();
  });

  it("keeps up with edits: renamed streets, new buildings, undo", () => {
    const seg = R.world.all("street").find((s) => s.name === "Guadalupe Street")!;
    const renamed: Street = { ...seg, name: "Zanzibar Promenade" };
    const cs = makeChangeset("rename", "user", [{ type: "update", before: seg, after: renamed }]);
    R.world.apply(cs);
    expect(top("zanzibar promenade")?.label).toBe("Zanzibar Promenade");
    expect(top("zanzibar promenade")?.ids).toEqual([seg.id]);
    // the rest of Guadalupe is still found
    expect(top("guadalupe street")?.label).toBe("Guadalupe Street");
    const b: Building = { ...(R.world.all("building")[0] as Building), id: "b:test-search", name: "Moonbeam Hall", address: undefined };
    const add = makeChangeset("add", "user", [{ type: "add", entity: b }]);
    R.world.apply(add);
    expect(top("moonbeam")?.ids).toEqual(["b:test-search"]);
    R.world.revert(add);
    R.world.revert(cs);
    expect(ix.search("moonbeam")).toEqual([]);
    expect(ix.search("zanzibar promenade")).toEqual([]);
    expect(top("21st & guadalupe")?.label).toBe("W 21st St & Guadalupe St");
  });
});

describe("geocoder results", () => {
  it("keeps only places inside the city and labels them like the rest", () => {
    const city = { origin: { lon: -97.741, lat: 30.2725 }, bounds: [-2000, -2000, 2000, 2000] as [number, number, number, number] };
    const rs = toResults(
      [
        { geometry: { type: "Point", coordinates: [-97.7429, 30.2682] }, properties: { osm_type: "N", osm_id: 1, osm_key: "amenity", osm_value: "cafe", name: "Starbucks", street: "West 6th Street" } },
        { geometry: { type: "Point", coordinates: [-97.742, 30.27] }, properties: { osm_type: "N", osm_id: 2, housenumber: "1100", street: "Congress Avenue" } },
        { geometry: { type: "Point", coordinates: [-97.9, 30.4] }, properties: { osm_type: "N", osm_id: 3, name: "Far away" } },
      ],
      city,
    );
    expect(rs.map((r) => [r.label, r.detail])).toEqual([
      ["Starbucks", "Cafe · W 6th St"],
      ["1100 Congress Ave", "Address"],
    ]);
  });
});
