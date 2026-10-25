import { describe, expect, it } from "vitest";
import { MAX_EDGE, base64Bytes, checkFile, displayName, fitWithin, projectNameFor } from "@/sketch/image";

describe("sketch image preprocessing helpers", () => {
  it("fits the long edge within 1568 px without upscaling", () => {
    expect(fitWithin(4032, 3024, MAX_EDGE)).toMatchObject({ w: 1568, h: 1176 });
    expect(fitWithin(3024, 4032, MAX_EDGE)).toMatchObject({ w: 1176, h: 1568 });
    expect(fitWithin(800, 600, MAX_EDGE)).toMatchObject({ w: 800, h: 600, scale: 1 });
  });

  it("refuses what can't be a sketch, kindly", () => {
    expect(checkFile({ type: "image/png", size: 20_000 })).toBeNull();
    expect(checkFile({ type: "", size: 2_000_000, name: "IMG_1234.HEIC" })).toBeNull();
    expect(checkFile({ type: "application/pdf", size: 20_000 })).toMatch(/isn't an image/);
    expect(checkFile({ type: "image/gif", size: 20_000 })).toMatch(/can't be read/);
    expect(checkFile({ type: "image/jpeg", size: 90 * 1024 * 1024 })).toMatch(/90 MB; the limit is 40 MB/);
    expect(checkFile({ type: "image/jpeg", size: 10 })).toMatch(/empty/);
  });

  it("names attachments and projects from file names", () => {
    expect(displayName("riverside-plan.png")).toBe("riverside plan");
    expect(displayName("IMG_20261021_101500.jpg", "Photo")).toBe("Photo");
    expect(projectNameFor({ name: "riverside plan" })).toBe("Riverside plan");
    expect(projectNameFor({ name: "IMG_4411.HEIC" })).toBe("From a sketch");
  });

  it("measures base64 payloads", () => {
    expect(base64Bytes(btoa("hello"))).toBe(5);
    expect(base64Bytes(btoa("hello!"))).toBe(6);
  });
});
