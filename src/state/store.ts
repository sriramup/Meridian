import { create } from "zustand";

export type Tool = "select" | "building" | "street" | "area" | "measure" | "tree" | "district" | "transit" | "library";

/** what the drawing tools make: chosen before drawing, applied when the shape is finished */
export interface Palette {
  street: { cls: "residential" | "tertiary" | "secondary" | "primary" | "living" | "pedestrian"; bike: "none" | "lane" | "track"; trees: boolean };
  building: { use: "mixed" | "residential" | "office" | "retail" | "civic" | "education" | "health" | "hotel" | "fire_station"; typology: string; floors: number };
  area: { type: "park" | "plaza" | "water" | "wood" | "grass" | "raingarden" | "permeable" | "retention" | "parking" };
  district: { style: "european" | "grid" | "midrise" | "towers" | "tod" | "civic" | "infill"; homes: number; maxFloors: number; newStreets: boolean };
  transit: { mode: "bus" | "brt" | "tram"; headway: number };
}
export type OverlayId = "traffic" | "heat" | "density" | "access" | "bike" | "flood" | "zoning" | "growth" | "transit" | "sun" | "runoff" | "change";
export type CameraMode = "orbit" | "pedestrian";

export interface Annotation {
  id: string;
  p: [number, number];
  z?: number;
  title: string;
  body?: string;
  tone?: "info" | "warn" | "good";
}

export interface AppState {
  status: "idle" | "loading" | "ready" | "error";
  progress: number;
  progressLabel: string;
  error?: string;

  worldVersion: number;
  scenarioVersion: number;
  bumpWorld: () => void;
  bumpScenarios: () => void;

  selection: string[];
  hover: string | null;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  setHover: (id: string | null) => void;

  tool: Tool;
  setTool: (t: Tool) => void;
  /** planting palette: species, and single clicks or a row along a drawn line (spaced a crown apart) */
  planting: { species: string; mode: "single" | "row" };
  setPlanting: (p: Partial<AppState["planting"]>) => void;
  palette: Palette;
  setPalette: <K extends keyof Palette>(k: K, p: Partial<Palette[K]>) => void;

  theme: "model" | "night";
  setTheme: (t: "model" | "night") => void;

  cameraMode: CameraMode;
  setCameraMode: (m: CameraMode) => void;

  overlay: OverlayId | null;
  setOverlay: (o: OverlayId | null) => void;
  overlayVersion: number;
  bumpOverlay: () => void;

  hour: number;
  setHour: (h: number) => void;
  /** day of the year modelled by heat / shade ("MM-DD"; typical weather for that day) */
  date: string;
  setDate: (d: string) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;

  showChanges: boolean;
  setShowChanges: (v: boolean) => void;
  compareId: string | null;
  setCompareId: (id: string | null) => void;

  layers: { context: boolean; labels: boolean; trees: boolean; markings: boolean; transit: boolean; parcels: boolean; utilities: boolean; paths: boolean };
  toggleLayer: (k: keyof AppState["layers"]) => void;

  annotations: Annotation[];
  setAnnotations: (a: Annotation[]) => void;
  highlight: { ids: string[]; color?: [number, number, number]; label?: string } | null;
  setHighlight: (h: AppState["highlight"]) => void;

  agentOpen: boolean;
  setAgentOpen: (v: boolean) => void;
  /** text handed to the agent's message box (from the search), taken by the panel once shown */
  agentDraft: string | null;
  askAgent: (text?: string) => void;
  takeAgentDraft: () => string | null;
  /** the controls & navigation guide */
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
  panel: "layers" | "scenarios" | "history" | null;
  setPanel: (p: AppState["panel"]) => void;

  toast: { id: number; text: string; tone?: "info" | "warn" | "error" } | null;
  notify: (text: string, tone?: "info" | "warn" | "error") => void;

  fps: number;
  setFps: (n: number) => void;
  toolVersion: number;
  bumpTool: () => void;
}

/**
 * Analyses are dated by month: each month is modelled on its mean day, the day whose sun
 * declination equals the month's average (Klein 1977), so sun and typical weather stay representative.
 */
export const MONTH_MEAN_DAY = [17, 16, 16, 15, 15, 11, 17, 16, 15, 15, 14, 10];

/** "MM-DD" of the mean day of month m (0-based) */
export function monthDate(m: number): string {
  const k = ((m % 12) + 12) % 12;
  return `${String(k + 1).padStart(2, "0")}-${String(MONTH_MEAN_DAY[k]).padStart(2, "0")}`;
}

export const useApp = create<AppState>((set, get) => ({
  status: "idle",
  progress: 0,
  progressLabel: "",
  worldVersion: 0,
  scenarioVersion: 0,
  bumpWorld: () => set((s) => ({ worldVersion: s.worldVersion + 1 })),
  bumpScenarios: () => set((s) => ({ scenarioVersion: s.scenarioVersion + 1 })),

  selection: [],
  hover: null,
  setSelection: (ids) => set({ selection: ids }),
  toggleSelection: (id) => {
    const cur = get().selection;
    set({ selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  setHover: (id) => {
    if (get().hover !== id) set({ hover: id });
  },

  tool: "select",
  setTool: (tool) => set({ tool }),
  planting: { species: "live_oak", mode: "single" },
  setPlanting: (p) => set((s) => ({ planting: { ...s.planting, ...p } })),
  palette: {
    street: { cls: "residential", bike: "none", trees: true },
    building: { use: "mixed", typology: "courtyard", floors: 6 },
    area: { type: "park" },
    district: { style: "midrise", homes: 0, maxFloors: 8, newStreets: true },
    transit: { mode: "bus", headway: 10 },
  },
  setPalette: (k, p) => set((s) => ({ palette: { ...s.palette, [k]: { ...s.palette[k], ...p } } })),

  theme: "model",
  setTheme: (theme) => set({ theme }),

  cameraMode: "orbit",
  setCameraMode: (cameraMode) => set({ cameraMode }),

  overlay: "heat",
  setOverlay: (overlay) => set({ overlay }),
  overlayVersion: 0,
  bumpOverlay: () => set((s) => ({ overlayVersion: s.overlayVersion + 1 })),

  hour: 15,
  setHour: (hour) => set({ hour }),
  date: monthDate(new Date().getMonth()),
  setDate: (date) => set({ date }),
  playing: false,
  setPlaying: (playing) => set({ playing }),

  showChanges: true,
  setShowChanges: (showChanges) => set({ showChanges }),
  compareId: null,
  setCompareId: (compareId) => set({ compareId }),

  layers: { context: true, labels: true, trees: true, markings: true, transit: false, parcels: false, utilities: false, paths: true },
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),

  annotations: [],
  setAnnotations: (annotations) => set({ annotations }),
  highlight: null,
  setHighlight: (highlight) => set({ highlight }),

  agentOpen: false,
  setAgentOpen: (agentOpen) => set({ agentOpen }),
  agentDraft: null,
  askAgent: (text) => set({ agentOpen: true, agentDraft: text ?? "" }),
  takeAgentDraft: () => {
    const d = get().agentDraft;
    if (d !== null) set({ agentDraft: null });
    return d;
  },
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  panel: null,
  setPanel: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel })),

  toast: null,
  notify: (text, tone = "info") => set({ toast: { id: Date.now(), text, tone } }),

  fps: 0,
  setFps: (fps) => set({ fps }),
  toolVersion: 0,
  bumpTool: () => set((s) => ({ toolVersion: s.toolVersion + 1 })),
}));
