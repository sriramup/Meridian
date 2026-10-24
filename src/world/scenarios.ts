// Scenario branches and undo/redo history. Every scenario stores its full
// ordered changeset list from the baseline plus a cursor; branching copies the
// applied prefix. Switching scenarios reverts to baseline and replays, so all
// scenarios share one exact, reversible representation.

import type { Entity } from "./types";
import { newId, type Changeset, type World } from "./world";

export interface Scenario {
  id: string;
  name: string;
  parentId: string | null;
  changesets: Changeset[];
  cursor: number;
  createdAt: number;
  author: "user" | "agent";
  description?: string;
  color: string;
}

const COLORS = ["#2f6fed", "#d9622b", "#2a9d6f", "#8a5cd1", "#c2410c", "#0e7490", "#b45309"];

export interface ScenarioOptions {
  baselineName?: string;
  baselineDescription?: string;
  /** name of branches made automatically by the first edit */
  branchPrefix?: string;
}

/** a JSON-safe copy of every scenario; changesets shared between branches are stored once */
export interface ScenarioSnapshot {
  version: 1;
  activeId: string;
  changesets: Changeset[];
  scenarios: (Omit<Scenario, "changesets"> & { changesets: string[] })[];
}

export class ScenarioManager {
  readonly scenarios = new Map<string, Scenario>();
  activeId: string;
  private baseline: Map<string, Entity>;
  private listeners = new Set<() => void>();

  constructor(
    private world: World,
    private opts: ScenarioOptions = {},
  ) {
    this.baseline = world.cloneEntities();
    const base: Scenario = { id: "baseline", name: opts.baselineName ?? "Current", parentId: null, changesets: [], cursor: 0, createdAt: Date.now(), author: "user", color: "#6b7280", description: opts.baselineDescription ?? "Measured / mapped existing conditions" };
    this.scenarios.set(base.id, base);
    this.activeId = base.id;
  }

  get active(): Scenario {
    return this.scenarios.get(this.activeId)!;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  /** apply a changeset to the active scenario (branching automatically off the read-only baseline) */
  commit(cs: Changeset) {
    if (this.activeId === "baseline") this.branch(`${this.opts.branchPrefix ?? "Proposal"} ${this.scenarios.size}`, cs.author === "agent" ? "agent" : "user");
    const s = this.active;
    if (s.cursor < s.changesets.length) s.changesets = s.changesets.slice(0, s.cursor);
    this.world.apply(cs);
    s.changesets.push(cs);
    s.cursor++;
    this.emit();
  }

  canUndo() {
    return this.active.cursor > 0;
  }
  canRedo() {
    return this.active.cursor < this.active.changesets.length;
  }

  undo(steps = 1): Changeset[] {
    const s = this.active;
    const out: Changeset[] = [];
    for (let i = 0; i < steps && s.cursor > 0; i++) {
      const cs = s.changesets[s.cursor - 1];
      this.world.revert(cs);
      s.cursor--;
      out.push(cs);
    }
    if (out.length) this.emit();
    return out;
  }

  redo(steps = 1): Changeset[] {
    const s = this.active;
    const out: Changeset[] = [];
    for (let i = 0; i < steps && s.cursor < s.changesets.length; i++) {
      const cs = s.changesets[s.cursor];
      this.world.apply(cs);
      s.cursor++;
      out.push(cs);
    }
    if (out.length) this.emit();
    return out;
  }

  /** revert a specific changeset (and everything after it), then replay the later ones if they still apply */
  revertChangeset(csId: string): boolean {
    const s = this.active;
    const idx = s.changesets.findIndex((c) => c.id === csId);
    if (idx < 0 || idx >= s.cursor) return false;
    const later = s.changesets.slice(idx + 1, s.cursor);
    for (let i = s.cursor - 1; i >= idx; i--) this.world.revert(s.changesets[i]);
    s.changesets = [...s.changesets.slice(0, idx), ...later];
    s.cursor = idx;
    for (const cs of later) {
      if (this.applicable(cs)) {
        this.world.apply(cs);
        s.cursor++;
      } else {
        s.changesets = s.changesets.filter((c) => c !== cs);
      }
    }
    this.emit();
    return true;
  }

  private applicable(cs: Changeset) {
    return cs.ops.every((op) => (op.type === "add" ? !this.world.get(op.entity.id) : op.type === "remove" ? !!this.world.get(op.entity.id) : !!this.world.get(op.before.id)));
  }

  branch(name: string, author: "user" | "agent" = "user", fromId = this.activeId, description?: string): Scenario {
    const parent = this.scenarios.get(fromId)!;
    const s: Scenario = {
      id: newId("sc"),
      name,
      parentId: parent.id,
      changesets: parent.changesets.slice(0, parent.cursor),
      cursor: parent.cursor,
      createdAt: Date.now(),
      author,
      description,
      color: COLORS[(this.scenarios.size - 1) % COLORS.length],
    };
    this.scenarios.set(s.id, s);
    if (fromId !== this.activeId) this.switchTo(s.id);
    else this.activeId = s.id;
    this.emit();
    return s;
  }

  switchTo(id: string) {
    if (id === this.activeId || !this.scenarios.has(id)) return;
    const cur = this.active;
    const next = this.scenarios.get(id)!;
    // find common prefix to minimise work
    let common = 0;
    while (common < cur.cursor && common < next.cursor && cur.changesets[common] === next.changesets[common]) common++;
    for (let i = cur.cursor - 1; i >= common; i--) this.world.revert(cur.changesets[i]);
    for (let i = common; i < next.cursor; i++) this.world.apply(next.changesets[i]);
    this.activeId = id;
    this.emit();
  }

  rename(id: string, name: string) {
    const s = this.scenarios.get(id);
    if (s) {
      s.name = name;
      this.emit();
    }
  }

  remove(id: string) {
    if (id === "baseline") return;
    if (id === this.activeId) this.switchTo(this.scenarios.get(id)!.parentId ?? "baseline");
    this.scenarios.delete(id);
    this.emit();
  }

  /** entity map of any scenario without touching the live world */
  materialize(id: string): Map<string, Entity> {
    if (id === this.activeId) return this.world.cloneEntities();
    const s = this.scenarios.get(id)!;
    const m = new Map(this.baseline);
    for (let i = 0; i < s.cursor; i++) {
      for (const op of s.changesets[i].ops) {
        if (op.type === "add") m.set(op.entity.id, op.entity);
        else if (op.type === "remove") m.delete(op.entity.id);
        else {
          m.delete(op.before.id);
          m.set(op.after.id, op.after);
        }
      }
    }
    return m;
  }

  /** ids added / removed / modified between two scenarios */
  diff(aId: string, bId: string) {
    const a = this.materialize(aId);
    const b = this.materialize(bId);
    const added: string[] = [],
      removed: string[] = [],
      modified: string[] = [];
    for (const [id, e] of b) {
      const o = a.get(id);
      if (!o) added.push(id);
      else if (o !== e) modified.push(id);
    }
    for (const id of a.keys()) if (!b.has(id)) removed.push(id);
    return { added, removed, modified, a, b };
  }

  snapshot(): ScenarioSnapshot {
    const byId = new Map<string, Changeset>();
    for (const s of this.scenarios.values()) for (const cs of s.changesets) byId.set(cs.id, cs);
    return {
      version: 1,
      activeId: this.activeId,
      changesets: [...byId.values()],
      scenarios: [...this.scenarios.values()].map((s) => ({ ...s, changesets: s.changesets.map((c) => c.id) })),
    };
  }

  /** replace every scenario with a snapshot taken on the same baseline; the world must be at the baseline */
  restore(snap: ScenarioSnapshot): boolean {
    if (snap?.version !== 1 || this.activeId !== "baseline" || this.active.cursor) return false;
    const byId = new Map(snap.changesets.map((c) => [c.id, c]));
    const scenarios = snap.scenarios.map((s) => ({ ...s, changesets: s.changesets.map((id) => byId.get(id)!).filter(Boolean) }));
    if (!scenarios.some((s) => s.id === "baseline")) return false;
    this.scenarios.clear();
    for (const s of scenarios) this.scenarios.set(s.id, { ...s, cursor: Math.min(s.cursor, s.changesets.length) });
    const target = this.scenarios.has(snap.activeId) ? snap.activeId : "baseline";
    for (let i = 0; i < this.scenarios.get(target)!.cursor; i++) this.world.apply(this.scenarios.get(target)!.changesets[i]);
    this.activeId = target;
    this.emit();
    return true;
  }

  appliedChangesets(id = this.activeId) {
    const s = this.scenarios.get(id)!;
    return s.changesets.slice(0, s.cursor);
  }
}
