// Civic, education and health buildings.

import type { Solid } from "@/world/types";
import type { PrimitiveDef } from "../types";
import { subFrame } from "../geometry/frame";
import { C } from "../geometry/palette";
import { S, box, cyl } from "../geometry/solids";
import { buildingType, type DecorateArgs } from "./building";
import { atRear, frontParking, parkingParams, portico } from "./commercial";
import { areaL, fenceRect, rectL } from "./decor";
import { playgroundSolids, fieldMarkings } from "./recreation";
import { bool, choice, int, num, opts } from "./params";

const CV = "civic" as const,
  ED = "education" as const,
  HE = "health" as const;
const SITE = "Site";

function flagpole(info: DecorateArgs["info"]) {
  const { mid, n } = info.front;
  const p: [number, number] = [mid[0] + n[0] * 8, mid[1] + n[1] * 8];
  info.addSolids([cyl(p[0], p[1], 0, 0.12, 10, C.steel, "metal"), S("box", [p[0] + 0.8, p[1], 8.6], [1.5, 0.03, 1.0], [60, 90, 160], "fabric")]);
}

function cupola(info: DecorateArgs["info"], h: number, kind: "dome" | "clock" | "spire" | "none") {
  if (kind === "none") return;
  const [x0, y0, x1, y1] = info.bbox;
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  const z = info.height;
  const w = Math.min(x1 - x0, y1 - y0) * 0.22;
  const s: Solid[] = [box(cx, cy, z, w, w, h * 0.5, [236, 230, 216], "stone")];
  if (kind === "dome") s.push(cyl(cx, cy, z + h * 0.5, w * 0.9, h * 0.15, [236, 230, 216], "stone"), S("hemisphere", [cx, cy, z + h * 0.65], [w * 0.9, w * 0.9, w * 0.55], [110, 168, 150], "metal"));
  if (kind === "clock") {
    for (const [dx, dy] of [[0, w / 2], [0, -w / 2], [w / 2, 0], [-w / 2, 0]]) s.push(S("cylinder", [cx + dx, cy + dy, z + h * 0.3], [w * 0.6, w * 0.6, 0.05], C.white, "plastic", Math.abs(dx) > 0 ? 90 : 0, [90, 0]));
    s.push(S("pyramid", [cx, cy, z + h * 0.5], [w * 1.1, w * 1.1, h * 0.4], [78, 84, 94], "stone"));
  }
  if (kind === "spire") s.push(S("pyramid", [cx, cy, z + h * 0.5], [w, w, h * 1.2], [78, 84, 94], "stone"));
  info.addSolids(s);
}

const civ = { use: "civic", roofType: "flat", parapetHeight: 1.2, facade: "limestone", entrance: true };

export const CIVIC: PrimitiveDef[] = [
  buildingType({
    id: "civic.city_hall",
    name: "City hall",
    category: CV,
    tags: ["town hall", "municipal building", "civic center", "council", "government"],
    description: "Civic landmark with a portico, cupola and civic forecourt.",
    icon: "landmark",
    defaults: { ...civ, shape: "u", width: 70, depth: 45, wing: 16, wing2: 18, floors: 4, groundFloorHeight: 6, floorHeight: 4.5, fitToSite: false },
    extra: [choice("cupola", "Cupola", "dome", opts("dome", "clock", "spire", "none"), { group: SITE }), int("columns", "Portico columns", 8, { group: SITE, min: 0, max: 14 }), bool("forecourt", "Civic forecourt", true, { group: SITE })],
    decorate: ({ r, out, info }) => {
      portico(info, r.n("columns"), r.n("columns") > 0);
      cupola(info, 14, r.s("cupola") as "dome");
      flagpole(info);
      if (r.b("forecourt")) {
        const [x0, , x1, y1] = info.bbox;
        areaL(out, info.frame, "plaza", rectL((x0 + x1) / 2, y1 + 15, x1 - x0, 30));
      }
    },
  }),
  buildingType({
    id: "civic.library",
    name: "Library",
    category: CV,
    tags: ["public library", "branch library", "reading room", "media centre"],
    description: "Public library with a glazed reading room and a reading garden.",
    icon: "library",
    defaults: { ...civ, shape: "l", width: 50, depth: 40, wing: 18, wing2: 18, floors: 2, groundFloorHeight: 6, floorHeight: 5, facade: "brick_buff", roofType: "shed", roofPitch: 8, fitToSite: false },
    extra: [bool("garden", "Reading garden", true, { group: SITE })],
    decorate: ({ r, out, info }) => {
      if (!r.b("garden")) return;
      const [x0, y0, x1, y1] = info.bbox;
      areaL(out, info.frame, "park", rectL(x0 + (x1 - x0) * 0.68, y0 + (y1 - y0) * 0.68, (x1 - x0) * 0.6, (y1 - y0) * 0.6));
    },
  }),
  buildingType({
    id: "civic.fire_station",
    name: "Fire station",
    category: CV,
    tags: ["firehouse", "fire hall", "ems station", "emergency services", "fire department"],
    description: "Fire / EMS station with apparatus bays and an apron (counts as a fire station in the response model).",
    icon: "siren",
    defaults: { ...civ, name: "Fire Station", width: 36, depth: 24, floors: 2, groundFloorHeight: 5.5, facade: "brick_red", fitToSite: false },
    extra: [int("bays", "Apparatus bays", 3, { group: SITE, min: 1, max: 8, description: "≈ 4.3 m wide, 4.3 m tall doors" }), bool("hoseTower", "Hose tower", true, { group: SITE })],
    decorate: ({ r, out, info }) => {
      const [x0, , x1, y1] = info.bbox;
      const n = r.n("bays");
      const w = Math.min((x1 - x0) / n, 5);
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) s.push(box(x0 + w * (i + 0.5) + 1, y1 + 0.05, 0, w - 0.8, 0.12, 4.3, [196, 58, 48], "metal"));
      if (r.b("hoseTower")) s.push(box(x1 - 3, y1 - 3, 0, 4, 4, info.height + 6, [168, 92, 72], "stone"));
      info.addSolids(s);
      areaL(out, info.frame, "parking", rectL(x0 + (n * w) / 2 + 1, y1 + 9, n * w + 2, 18));
    },
  }),
  buildingType({
    id: "civic.police_station",
    name: "Police station",
    category: CV,
    tags: ["police precinct", "public safety", "sheriff", "law enforcement"],
    description: "Police station with a secure parking yard.",
    icon: "shield",
    defaults: { ...civ, width: 45, depth: 30, floors: 3, facade: "brick_brown", fitToSite: false },
    extra: parkingParams(true, 24),
    decorate: (a) => {
      flagpole(a.info);
      frontParking(a);
    },
  }),
  buildingType({
    id: "civic.post_office",
    name: "Post office",
    category: CV,
    tags: ["usps", "mail", "postal", "parcel"],
    description: "Post office with a loading dock and collection boxes.",
    icon: "mail",
    defaults: { ...civ, width: 36, depth: 28, floors: 1, groundFloorHeight: 6, facade: "brick_buff", fitToSite: false },
    decorate: ({ info }) => flagpole(info),
  }),
  buildingType({
    id: "civic.courthouse",
    name: "Courthouse",
    category: CV,
    tags: ["court", "justice center", "county courthouse", "judicial"],
    description: "Monumental courthouse with steps, columns and a dome.",
    icon: "scale",
    defaults: { ...civ, width: 60, depth: 50, floors: 4, groundFloorHeight: 7, floorHeight: 5, fitToSite: false },
    extra: [choice("cupola", "Crown", "dome", opts("dome", "clock", "spire", "none"), { group: SITE }), int("columns", "Portico columns", 8, { group: SITE, min: 0, max: 14 })],
    decorate: ({ r, info }) => {
      portico(info, r.n("columns"), r.n("columns") > 0);
      cupola(info, 18, r.s("cupola") as "dome");
      flagpole(info);
    },
  }),
  buildingType({
    id: "civic.community_center",
    name: "Community centre",
    category: CV,
    tags: ["community center", "recreation center", "neighbourhood house", "civic hall", "senior center", "youth center"],
    description: "Community and recreation centre with a gym hall and meeting rooms.",
    icon: "users",
    defaults: { ...civ, shape: "l", width: 55, depth: 40, wing: 20, wing2: 18, floors: 2, groundFloorHeight: 6, floorHeight: 5, facade: "timber_light", roofType: "shed", roofPitch: 10, fitToSite: false },
  }),
  buildingType({
    id: "civic.place_of_worship",
    name: "Place of worship",
    category: CV,
    tags: ["church", "chapel", "cathedral", "mosque", "synagogue", "temple", "gurdwara", "religious"],
    description: "Church, mosque, synagogue or temple form: nave with a steep roof plus a steeple, dome or minaret.",
    icon: "church",
    defaults: { use: "religious", width: 18, depth: 36, floors: 1, groundFloorHeight: 12, roofType: "gable", roofPitch: 45, roofMaterial: "slate", facade: "sandstone", parapetHeight: 0, fitToSite: false, jobs: 6 },
    extra: [choice("tower", "Tower", "steeple", [{ value: "steeple", label: "Steeple / spire" }, { value: "dome", label: "Central dome" }, { value: "minaret", label: "Minaret" }, { value: "bell", label: "Bell tower" }, { value: "none", label: "None" }], { group: SITE }), num("towerHeight", "Tower height", 30, { group: SITE, unit: "m", min: 8, max: 120, step: 1, when: { key: "tower", in: ["steeple", "minaret", "bell"] } })],
    decorate: ({ r, info }) => {
      const [x0, y0, x1, y1] = info.bbox;
      const t = r.s("tower");
      const H = r.n("towerHeight");
      const stone: [number, number, number] = [214, 180, 136];
      if (t === "dome") {
        const d = Math.min(x1 - x0, y1 - y0) * 0.8;
        info.addSolids([cyl((x0 + x1) / 2, (y0 + y1) / 2, info.height, d * 0.9, 3, stone, "stone"), S("hemisphere", [(x0 + x1) / 2, (y0 + y1) / 2, info.height + 3], [d, d, d * 0.6], [110, 168, 150], "metal")]);
      } else if (t !== "none") {
        const w = t === "minaret" ? 3.5 : 6;
        const cx = t === "minaret" ? x1 + 4 : (x0 + x1) / 2,
          cy = t === "minaret" ? y1 - 4 : y1 + w / 2 - 1;
        const s: Solid[] = [t === "minaret" ? cyl(cx, cy, 0, w, H * 0.85, stone, "stone") : box(cx, cy, 0, w, w, H * 0.7, stone, "stone")];
        if (t === "steeple") s.push(S("pyramid", [cx, cy, H * 0.7], [w * 0.9, w * 0.9, H * 0.3], [78, 84, 94], "stone"));
        if (t === "minaret") s.push(cyl(cx, cy, H * 0.6, w * 1.4, 0.6, stone, "stone"), S("cone", [cx, cy, H * 0.85], [w, w, H * 0.15], [110, 168, 150], "metal"));
        if (t === "bell") s.push(box(cx, cy, H * 0.7, w * 0.9, w * 0.9, H * 0.15, [236, 230, 216], "stone"), S("pyramid", [cx, cy, H * 0.85], [w, w, H * 0.15], [184, 98, 70], "stone"));
        info.addSolids(s);
      }
    },
  }),
  buildingType({
    id: "civic.museum",
    name: "Museum / gallery",
    category: CV,
    tags: ["art museum", "gallery", "exhibition hall", "cultural center", "science center"],
    description: "Museum with top-lit galleries and a sculpture forecourt.",
    icon: "frame",
    defaults: { ...civ, shape: "plus", width: 70, depth: 60, wing: 22, wing2: 22, floors: 3, groundFloorHeight: 7, floorHeight: 6, facade: "precast_white", fitToSite: false, roofType: "flat", parapetHeight: 1.5, solar: false },
  }),
  buildingType({
    id: "civic.performing_arts",
    name: "Theatre / concert hall",
    category: CV,
    tags: ["opera house", "concert hall", "auditorium", "performing arts center", "playhouse"],
    description: "Performing-arts venue with a tall fly tower over the stage.",
    icon: "drama",
    defaults: { ...civ, shape: "rounded", corner: 15, width: 70, depth: 60, floors: 3, groundFloorHeight: 8, floorHeight: 6, facade: "glass_bronze", fitToSite: false, jobs: 80 },
    extra: [num("flyTower", "Fly tower height", 12, { group: SITE, unit: "m", min: 0, max: 40, step: 1 })],
    decorate: ({ r, info }) => {
      const h = r.n("flyTower");
      if (h <= 0) return;
      const [x0, y0, x1, y1] = info.bbox;
      info.addMass(rectL((x0 + x1) / 2, y0 + (y1 - y0) * 0.3, (x1 - x0) * 0.4, (y1 - y0) * 0.3), info.height, info.height + h, "crown");
    },
  }),
];

export const EDUCATION: PrimitiveDef[] = [
  buildingType({
    id: "education.daycare",
    name: "Daycare / preschool",
    category: ED,
    tags: ["nursery", "kindergarten", "pre-k", "childcare", "early learning"],
    description: "Single-storey early-learning centre with a fenced play yard.",
    icon: "baby",
    defaults: { use: "education", width: 30, depth: 20, floors: 1, groundFloorHeight: 4, roofType: "gable", roofPitch: 25, roofMaterial: "metal_red", facade: "siding_yellow", fitToSite: false, jobs: 15 },
    extra: [num("yardDepth", "Play yard depth", 18, { group: SITE, unit: "m", min: 6, max: 60, step: 1 })],
    decorate: ({ r, out, info }) => {
      const [x0, y0, x1] = info.bbox;
      const d = r.n("yardDepth");
      const cy = y0 - d / 2 - 1;
      areaL(out, info.frame, "grass", rectL((x0 + x1) / 2, cy, x1 - x0, d));
      out.prop("recreation.playground", subFrame(info.frame, [(x0 + x1) / 2, cy]), playgroundSolids("toddler", Math.min(x1 - x0, d) * 0.6), { primary: false });
      fenceRect(out, info.frame, (x0 + x1) / 2, cy, x1 - x0, d, 1.2, C.steel);
    },
  }),
  buildingType({
    id: "education.elementary_school",
    name: "Elementary school",
    category: ED,
    tags: ["primary school", "grade school", "public school", "k-5", "playground"],
    description: "Two-storey primary school with a playground and play field behind.",
    icon: "school",
    defaults: { use: "education", shape: "l", width: 80, depth: 55, wing: 18, wing2: 18, floors: 2, groundFloorHeight: 4.5, floorHeight: 4.2, roofType: "flat", facade: "brick_red", fitToSite: false },
    extra: [bool("playground", "Playground", true, { group: SITE }), bool("field", "Play field", true, { group: SITE })],
    decorate: ({ r, out, info }) => {
      const [x0, y0, x1] = info.bbox;
      if (r.b("playground")) {
        areaL(out, info.frame, "park", rectL(x0 + 18, y0 - 16, 34, 28));
        out.prop("recreation.playground", subFrame(info.frame, [x0 + 18, y0 - 16]), playgroundSolids("school", 20), { primary: false });
      }
      if (r.b("field")) {
        areaL(out, info.frame, "pitch", rectL(x1 - 32, y0 - 30, 60, 45));
        out.prop("recreation.soccer_field", subFrame(info.frame, [x1 - 32, y0 - 30]), fieldMarkings("soccer", 55, 40), { primary: false, height: 0.05 });
      }
    },
  }),
  buildingType({
    id: "education.middle_school",
    name: "Middle school",
    category: ED,
    tags: ["junior high", "intermediate school", "6-8"],
    description: "Middle school with a gymnasium wing and courts.",
    icon: "school",
    defaults: { use: "education", shape: "h", width: 100, depth: 70, wing: 20, wing2: 16, floors: 2, groundFloorHeight: 4.5, floorHeight: 4.2, roofType: "flat", facade: "brick_buff", fitToSite: false },
  }),
  buildingType({
    id: "education.high_school",
    name: "High school",
    category: ED,
    tags: ["secondary school", "senior high", "9-12", "sports field", "stadium", "track"],
    description: "High school with a gym, a football field with running track and parking.",
    icon: "graduation-cap",
    defaults: { use: "education", shape: "u", width: 130, depth: 80, wing: 22, wing2: 22, floors: 3, groundFloorHeight: 4.8, floorHeight: 4.2, roofType: "flat", facade: "brick_red", fitToSite: false },
    extra: [bool("track", "Football field and track", true, { group: SITE }), ...parkingParams(true, 36)],
    decorate: (a) => {
      const { r, out, info } = a;
      const [x0, y0, x1] = info.bbox;
      if (r.b("track")) {
        const cx = (x0 + x1) / 2,
          cy = y0 - 60;
        areaL(out, info.frame, "pitch", rectL(cx, cy, 176, 92));
        out.prop("recreation.running_track", subFrame(info.frame, [cx, cy]), fieldMarkings("track", 176, 92), { primary: false, height: 0.05 });
      }
      frontParking(a);
    },
  }),
  buildingType({
    id: "education.university_building",
    name: "University building",
    category: ED,
    tags: ["college building", "academic building", "lecture hall", "faculty", "campus building", "laboratory"],
    description: "Academic building with a colonnade and a quad lawn.",
    icon: "graduation-cap",
    defaults: { use: "education", width: 70, depth: 22, floors: 4, groundFloorHeight: 5, floorHeight: 4.2, roofType: "hip", roofPitch: 25, roofMaterial: "slate", parapetHeight: 0, facade: "brick_red", fitToSite: false },
    extra: [int("columns", "Colonnade columns", 6, { group: SITE, min: 0, max: 14 }), choice("cupola", "Cupola", "clock", opts("dome", "clock", "spire", "none"), { group: SITE })],
    decorate: ({ r, info }) => {
      portico(info, r.n("columns"), r.n("columns") > 0);
      cupola(info, 10, r.s("cupola") as "clock");
    },
  }),
  buildingType({
    id: "education.research_lab",
    name: "Research laboratory",
    category: ED,
    tags: ["lab building", "science building", "r&d", "biotech", "engineering building"],
    description: "Lab building with tall floors and rooftop exhaust plant.",
    icon: "flask-conical",
    defaults: { use: "education", width: 60, depth: 30, floors: 5, groundFloorHeight: 5, floorHeight: 4.8, roofType: "flat", facade: "metal_silver", penthouse: true, fitToSite: false },
    decorate: ({ info }) => {
      const [x0, y0, x1, y1] = info.bbox;
      const s: Solid[] = [];
      for (let i = 0; i < 4; i++) s.push(cyl(x0 + ((x1 - x0) * (i + 1)) / 5, y0 + (y1 - y0) * 0.25, info.height, 1.2, 7, C.steel, "metal"));
      info.addSolids(s);
    },
  }),
];

export const HEALTH: PrimitiveDef[] = [
  buildingType({
    id: "health.clinic",
    name: "Clinic",
    category: HE,
    tags: ["medical office", "doctor", "health center", "urgent care", "gp surgery", "dentist"],
    description: "Primary-care clinic / medical office building (counts as a clinic in walk access).",
    icon: "stethoscope",
    defaults: { use: "health", width: 30, depth: 22, floors: 2, roofType: "flat", facade: "precast_white", awning: true, awningColor: "#3c6ca8", fitToSite: false },
    extra: parkingParams(true, 20),
    decorate: (a) => frontParking(a),
  }),
  buildingType({
    id: "health.hospital",
    name: "Hospital",
    category: HE,
    tags: ["medical center", "infirmary", "emergency room", "er", "trauma center", "healthcare"],
    description: "Hospital: diagnostic podium, bed tower, emergency canopy and rooftop helipad.",
    icon: "hospital",
    defaults: { use: "health", shape: "rect", width: 110, depth: 80, floors: 10, podiumFloors: 3, towerCoverage: 35, groundFloorHeight: 5.5, floorHeight: 4.5, roofType: "flat", facade: "precast_white", penthouse: false, fitToSite: false },
    extra: [bool("helipad", "Rooftop helipad", true, { group: SITE }), bool("emergency", "Emergency canopy", true, { group: SITE })],
    decorate: ({ r, info }) => {
      const s: Solid[] = [];
      const [x0, y0, x1, y1] = info.bbox;
      if (r.b("helipad")) s.push(cyl((x0 + x1) / 2, (y0 + y1) / 2, info.height, 18, 0.4, [80, 82, 86], "concrete"), S("torus", [(x0 + x1) / 2, (y0 + y1) / 2, info.height + 0.4], [15, 15, 0.05], C.white, "plastic"), box((x0 + x1) / 2, (y0 + y1) / 2, info.height + 0.4, 1, 6, 0.05, C.white, "plastic"));
      if (r.b("emergency")) s.push(box(x1 - 12, y1 + 6, 5, 20, 12, 0.6, [196, 58, 48], "metal"), box(x1 - 21, y1 + 11, 0, 0.5, 0.5, 5, C.steel, "metal"), box(x1 - 3, y1 + 11, 0, 0.5, 0.5, 5, C.steel, "metal"));
      info.addSolids(s);
    },
  }),
  buildingType({
    id: "health.pharmacy",
    name: "Pharmacy",
    category: HE,
    tags: ["drugstore", "chemist", "drive-through pharmacy"],
    description: "Corner pharmacy with a drive-through window.",
    icon: "pill",
    defaults: { use: "retail", width: 30, depth: 25, floors: 1, groundFloorHeight: 5.5, roofType: "flat", parapetHeight: 1.5, facade: "brick_buff", awning: true, awningColor: "#c43a30", fitToSite: false },
    extra: parkingParams(true, 20),
    layout: atRear,
    decorate: (a) => frontParking(a),
  }),
];
