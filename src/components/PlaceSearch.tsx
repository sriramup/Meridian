"use client";

// The top bar's search: places only, like a map app. Streets, junctions ("21st & Guadalupe"),
// neighbourhoods, parks, landmarks, shops and schools, named buildings and street addresses, and
// whatever a design named; addresses the data doesn't have come from a public geocoder (real
// cities only). Choosing one flies the camera there and marks it briefly. The agent is offered
// only when nothing matches. "/" or ⌘K to focus, ↑↓ to choose, Enter to go, Esc to leave.

import { Command as Cmdk } from "cmdk";
import {
  BedDouble,
  Bridge,
  Building2,
  Bus,
  Church,
  Fence,
  Footprints,
  Globe,
  GraduationCap,
  History,
  Hospital,
  House,
  LandPlot,
  Landmark,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  PencilRuler,
  Route,
  School,
  Search,
  ShoppingBag,
  ShoppingBasket,
  Signpost,
  Square,
  Theater,
  TrainFront,
  Trees,
  UtensilsCrossed,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rtMaybe } from "@/state/runtime";
import { useProjects } from "@/state/projects";
import { useApp } from "@/state/store";
import { intersectionOf, placeIndexFor, bestPlace, searchPlaces, type PlaceResult } from "@/search";
import { flyToPlace } from "@/search/fly";
import { GEOCODER_ATTRIBUTION, geocode } from "@/search/geocode";
import { highlightShapes, useSearchHighlight } from "@/search/highlight";
import { fold, looksLikeAddress, normKey, words } from "@/search/normalize";
import { matchScore } from "@/search/placeIndex";
import { PlaceHighlight } from "@/search/PlaceHighlight";
import { clearRecents, loadRecents, rememberPlace, type RecentPlace } from "@/search/recent";
import { Command, CommandItem, CommandList } from "./ui/kit";
import { cx } from "./ui";
import { searchGoogleMaps } from "./serp/mapsSearch";

const ICONS: Record<string, LucideIcon> = {
  BedDouble,
  Bridge,
  Building2,
  Bus,
  Church,
  Fence,
  Footprints,
  GraduationCap,
  Hospital,
  House,
  LandPlot,
  Landmark,
  Map: MapIcon,
  MapPin,
  PencilRuler,
  Route,
  School,
  ShoppingBag,
  ShoppingBasket,
  Signpost,
  Square,
  Theater,
  TrainFront,
  Trees,
  UtensilsCrossed,
  Waves,
};

const MAX = 5;
const GEO_DEBOUNCE = 350;

/** should the public geocoder be asked as well? (an address we don't have, or nothing good) */
function wantsGeocoder(q: string, local: PlaceResult[]): boolean {
  if (q.trim().length < 4) return false;
  if (looksLikeAddress(q)) return !local.some((r) => /^\d/.test(r.label) && !r.detail.startsWith("Approximate") && matchScore(q, r.label) >= 0.8);
  return !local.length || local[0].score < 0.9;
}

/** geocoded places merged into the local list: no repeats, an estimated address gives way to a real one */
function merge(q: string, local: PlaceResult[], geo: PlaceResult[]): PlaceResult[] {
  const out = [...local];
  const ix = placeIndexFor();
  for (const g0 of geo) {
    // the geocoder finds by any field; offer only what reads as the place asked for
    const m = Math.max(matchScore(q, g0.label), matchScore(q, `${g0.label} ${g0.detail}`) - 0.1);
    if (m < 0.5) continue;
    const near = (o: PlaceResult, d: number) => Math.hypot(o.point[0] - g0.point[0], o.point[1] - g0.point[1]) < d;
    const k = normKey(g0.label);
    const dup = out.findIndex((o) => (near(o, 400) && (normKey(o.label) === k || normKey(o.detail) === k)) || (near(o, 40) && o.kind !== "street"));
    const hood = !g0.detail.includes(" · ") && ix ? ix.hoodOf(g0.key, g0.point) : "";
    const g = { ...g0, detail: hood ? `${g0.detail} · ${hood}` : g0.detail, score: m >= 0.8 ? 1.0 + 0.12 * m : 0.8 + 0.1 * Math.max(0, m) };
    if (dup < 0) out.push(g);
    else if (out[dup].detail.startsWith("Approximate") && m >= 0.8) out[dup] = g;
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX);
}

/** the label with the words the query begins drawn a little stronger */
function Marked({ text, q }: { text: string; q: string }) {
  const qw = words(q);
  if (!qw.length) return <>{text}</>;
  const parts = text.split(/(\s+|[/&,-])/);
  return (
    <>
      {parts.map((p, i) => {
        const f = fold(p).replace(/[^a-z0-9]/g, "");
        const hit = f && qw.some((w) => f.startsWith(w) || (w.length > 2 && f.startsWith(w.replace(/(st|nd|rd|th)$/, ""))));
        return hit ? (
          <span key={i} className="font-semibold">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        );
      })}
    </>
  );
}

function Row({ r, q, icon }: { r: Pick<PlaceResult, "label" | "detail" | "icon">; q: string; icon?: LucideIcon }) {
  const Icon = icon ?? ICONS[r.icon] ?? MapPin;
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-paper-2/70">
        <Icon size={13} strokeWidth={1.7} className="text-ink-3" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="truncate text-[12.5px] text-ink">
          <Marked text={r.label} q={q} />
        </span>
        {r.detail && <span className="truncate text-[11px] text-ink-4">{r.detail}</span>}
      </span>
    </>
  );
}

export function PlaceSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState("");
  const [geo, setGeo] = useState<{ q: string; results: PlaceResult[] | null; pending: boolean }>({ q: "", results: null, pending: false });
  const [recents, setRecents] = useState<RecentPlace[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const agentOpen = useApp((s) => s.agentOpen);
  useApp((s) => s.worldVersion);
  const R = rtMaybe();
  // recent places belong to the open project (its designs name their own streets)
  const projectId = useProjects((s) => s.currentId);
  const city = projectId ?? R?.cityId ?? "";
  const sandbox = !!R?.meta.sandbox;

  // build the index while the app is idle, so the first keystroke is instant
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    const h = w.requestIdleCallback ? w.requestIdleCallback(() => placeIndexFor(), { timeout: 4000 }) : window.setTimeout(() => placeIndexFor(), 1500);
    (window as unknown as { __meridianSearch: unknown }).__meridianSearch = { search: searchPlaces, resolve: bestPlace, intersection: intersectionOf, highlight: useSearchHighlight };
    return () => (w.cancelIdleCallback ? w.cancelIdleCallback(h) : clearTimeout(h));
  }, [R?.world]);

  useEffect(() => {
    if (open) setRecents(loadRecents(city));
  }, [open, city]);

  const local = useMemo(() => (open && q.trim() ? searchPlaces(q, MAX) : []), [q, open]);
  const needGeo = open && !sandbox && wantsGeocoder(q, local);

  // the geocoder: debounced, the stale request cancelled
  useEffect(() => {
    if (!needGeo || !R) return;
    const query = q.trim();
    setGeo((g) => (g.q === query && !g.pending ? g : { q: query, results: g.q === query ? g.results : null, pending: true }));
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      const res = await geocode(query, { origin: R.meta.origin, bounds: R.meta.bounds }, ctl.signal);
      if (!ctl.signal.aborted) setGeo({ q: query, results: res, pending: false });
    }, GEO_DEBOUNCE);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, needGeo]);

  const geoFor = needGeo && geo.q === q.trim() ? geo : null;
  const results = useMemo(() => (geoFor?.results?.length ? merge(q, local, geoFor.results) : local), [q, local, geoFor]);
  const searching = !!q.trim() && !results.length && needGeo && (!geoFor || geoFor.pending);
  const askAgent = !!q.trim() && !results.length && !searching;
  const showGeoCredit = results.some((r) => r.kind === "geocoded");
  const showRecents = open && !q.trim() && recents.length > 0;

  // keep the first row chosen as results change
  const firstKey = results[0]?.key ?? (askAgent ? "ask" : showRecents ? `recent:${recents[0].key}` : "");
  useEffect(() => setSel(firstKey), [firstKey, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,select,[contenteditable]")) return;
      if (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const leave = () => {
    setQ("");
    setOpen(false);
    input.current?.blur();
  };

  const go = (r: PlaceResult | RecentPlace) => {
    leave();
    const RR = rtMaybe();
    if (!RR) return;
    setRecents(rememberPlace(city || RR.cityId, r));
    const hl = useSearchHighlight.getState();
    hl.show(r.key, highlightShapes(RR.world, r));
    void flyToPlace(r).then(() => useSearchHighlight.getState().land(r.key));
  };

  const ask = () => {
    const text = q.trim();
    leave();
    useApp.getState().askAgent(text);
  };

  // real cities: a last row searches Google Maps (SerpApi) around the view — spent only when chosen
  const offerMaps = !!q.trim() && !sandbox && q.trim().length >= 2;
  // armed only by a deliberate choice (arrow keys, or the pointer on the row): cmdk may highlight the
  // row on its own when it is the only one, and a plain Enter on a typed query must not spend a search
  const mapsArmed = useRef(false);
  useEffect(() => {
    mapsArmed.current = false;
  }, [q]);
  const mapsSearch = () => {
    if (!mapsArmed.current) return;
    const text = q.trim();
    leave();
    void searchGoogleMaps(text);
  };

  const listOpen = open && (results.length > 0 || searching || askAgent || showRecents || offerMaps);

  let body: ReactNode = null;
  if (showRecents)
    body = (
      <>
        <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
          <span className="font-legend text-[12px] leading-none text-ink-3">Recent</span>
          <button
            className="text-[10.5px] text-ink-4 hover:text-ink-2"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              clearRecents(city);
              setRecents([]);
            }}
          >
            Clear
          </button>
        </div>
        {recents.map((r) => (
          <CommandItem key={r.key} value={`recent:${r.key}`} onSelect={() => go(r)} className="gap-2.5 py-1.5">
            <Row r={r} q="" icon={History} />
          </CommandItem>
        ))}
      </>
    );
  else if (q.trim())
    body = (
      <>
        {results.map((r) => (
          <CommandItem key={r.key} value={r.key} onSelect={() => go(r)} className="gap-2.5 py-1.5">
            <Row r={r} q={q} />
          </CommandItem>
        ))}
        {searching && (
          <div className="flex h-9 items-center gap-2.5 px-2 text-[12px] text-ink-4">
            <span className="flex size-6 items-center justify-center">
              <Search size={13} strokeWidth={1.7} className="animate-pulse" />
            </span>
            Searching addresses…
          </div>
        )}
        {askAgent && (
          <CommandItem value="ask" onSelect={ask} className="gap-2.5 py-1.5">
            <span className="flex size-6 shrink-0 items-center justify-center">
              <MessageSquare size={13} strokeWidth={1.7} className="text-ink-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
              Ask the agent: “{q.trim()}”
            </span>
          </CommandItem>
        )}
        {offerMaps && (
          <CommandItem value="serp-maps" onSelect={mapsSearch} onPointerDown={() => (mapsArmed.current = true)} onPointerMove={() => (mapsArmed.current = true)} className="gap-2.5 py-1.5" data-serp-row>
            <span className="flex size-6 shrink-0 items-center justify-center">
              <Globe size={13} strokeWidth={1.7} className="text-rose" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">
              Search Google Maps for “{q.trim()}” nearby
            </span>
            <span className="shrink-0 text-[9.5px] text-ink-4">SerpApi</span>
          </CommandItem>
        )}
        {showGeoCredit && (
          <a href={GEOCODER_ATTRIBUTION.url} target="_blank" rel="noreferrer" className="block px-2 pt-1 pb-0.5 text-right text-[9.5px] text-ink-4 hover:text-ink-3" onMouseDown={(e) => e.preventDefault()}>
            {GEOCODER_ATTRIBUTION.text}
          </a>
        )}
      </>
    );

  // a fixed slot (narrower beside the agent, an icon on a small map); while typing the field
  // widens over its neighbours instead of pushing them
  return (
    <div className={cx("relative h-7 shrink-0", agentOpen ? "w-[220px]" : "w-[320px]", "@max-[900px]:w-[170px] @max-[740px]:w-7")}>
      <PlaceHighlight />
      <Command shouldFilter={false} value={sel} onValueChange={setSel} loop={false} label="Search places" className="size-auto overflow-visible">
        <label className="absolute inset-y-0 left-0 z-10 flex w-full items-center gap-1.5 rounded-full border border-line-2 bg-paper/80 px-2.5 transition-[width] focus-within:w-[400px] focus-within:border-rose/50 focus-within:bg-paper @max-[740px]:px-[7px]">
          <Search size={13} className="shrink-0 text-ink-3" />
          <Cmdk.Input
            ref={input}
            value={q}
            onValueChange={(v) => {
              setQ(v);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") mapsArmed.current = true;
              if (e.key === "Escape") {
                e.preventDefault();
                if (q) setQ("");
                else leave();
              }
            }}
            placeholder={sandbox ? "Search this design" : "Search places"}
            aria-label="Search for a place, street or address"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4"
          />
          {!q && <kbd className="rounded-[3px] border border-line-2 px-1 font-mono text-[10px] text-ink-4 @max-[900px]:hidden">/</kbd>}
        </label>
        <div className={cx("kit-surface absolute top-9 left-0 z-50 w-[min(400px,calc(100cqw-120px))]", !listOpen && "hidden")} onMouseDown={(e) => e.preventDefault()}>
          <CommandList className="max-h-none p-1">{body}</CommandList>
        </div>
      </Command>
    </div>
  );
}
