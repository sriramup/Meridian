import { describe, expect, it } from "vitest";
import { routeRequest } from "@/agent/router";

const cases: [string, "quick" | "standard" | "deep"][] = [
  ["What is the current scenario?", "quick"],
  ["how many buildings are selected?", "quick"],
  ["Which overlay is on?", "quick"],
  ["Is the zone set?", "quick"],
  ["thanks!", "quick"],
  ["What's the tallest building here?", "quick"],
  ["Add a protected bike lane on Guadalupe between 24th and MLK", "standard"],
  ["Build a 12-storey residential block on the selected parcel", "standard"],
  ["Plant street trees along Rainey Street", "standard"],
  ["Run the PM traffic model", "standard"],
  ["Can you add a park here?", "standard"],
  ["What would happen to traffic if we closed Congress?", "standard"],
  ["undo that", "standard"],
  ["Masterplan the east side of downtown for 3,000 homes with a park network", "deep"],
  ["Give me three alternatives for the Lamar & 6th junction and compare them", "deep"],
  ["Optimise the worst bottlenecks in the PM peak", "deep"],
  ["Find the best sites for affordable housing near frequent transit", "deep"],
];

describe("request router", () => {
  for (const [text, tier] of cases) it(`${tier}: ${text}`, () => expect(routeRequest(text).tier).toBe(tier));
  it("classifies in well under a millisecond", () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) routeRequest(cases[i % cases.length][0]);
    expect((performance.now() - t0) / 1000).toBeLessThan(0.2);
  });
});
