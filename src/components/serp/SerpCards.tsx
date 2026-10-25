"use client";

// Result cards for the SerpApi tools in the agents pane: web research (answer, facts, numbered
// sources with domains) and Google Maps discovery (places with rating stars, reviews, open now and
// walking time; "Show on map" and an opt-in "Add as destinations" that imports them for the
// walk-access model as one undoable change).

import { Check, ExternalLink, Globe, MapPin, MapPinned, Plus, Star } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { ToolCallView } from "@/agent/types";
import { Button, Tooltip } from "@/components/ui/kit";
import { fmtLen } from "@/lib/units";
import { applyOp } from "@/state/actions";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { importedPoi, importPlaces } from "@/serp/discover";
import { useSerp, type LocalPlace, type PlaceSet } from "@/serp/store";
import { showOnMap } from "@/serp/view";
import type { SerpCard, WebResult } from "@/serp/types";
import { cx } from "../ui";

/** every SerpApi card in a run's steps, newest last */
export function SerpCards({ steps }: { steps: { kind: string; call?: ToolCallView }[] }) {
  const cards = steps.flatMap((s) => (s.kind === "tool" && s.call?.status === "done" && s.call.display?.serp ? [{ id: s.call.id, card: s.call.display.serp as SerpCard }] : []));
  if (!cards.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {cards.map(({ id, card }) => (card.kind === "web" ? <WebCard key={id} data={card.data} cached={card.cached} /> : <PlacesCard key={id} set={card.set} walkMinutes={card.walk_minutes} />))}
    </div>
  );
}

function Shell({ icon, title, meta, children }: { icon: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section data-serp-card className="overflow-hidden rounded-[9px] border border-line bg-[#f8eed6]/70 shadow-[0_1px_1px_rgb(88_60_28/0.06)]">
      <header className="flex items-center gap-1.5 border-b border-line/70 px-2.5 py-1.5">
        <span className="grid size-4 shrink-0 place-items-center text-rose">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-2">{title}</span>
        {meta && <span className="shrink-0 text-[10.5px] text-ink-4">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

const Cite = ({ n, url }: { n?: number; url?: string }) =>
  n ? (
    <a href={url} target="_blank" rel="noreferrer" className="ml-0.5 align-super text-[9.5px] font-semibold text-rose hover:underline">
      [{n}]
    </a>
  ) : null;

export const WebCard = memo(function WebCard({ data, cached }: { data: WebResult; cached?: boolean }) {
  const [all, setAll] = useState(false);
  const label = data.engine === "google_news" ? "Google News" : data.engine === "google_scholar" ? "Google Scholar" : "Google";
  const src = all ? data.sources : data.sources.slice(0, 4);
  const urlOf = (n?: number) => data.sources.find((s) => s.n === n)?.url;
  return (
    <Shell icon={<Globe size={13} strokeWidth={1.9} />} title={<>{label} · “{data.query}”</>} meta={cached ? "cached" : undefined}>
      <div className="space-y-2 px-2.5 py-2">
        {data.answer && (
          <p className="text-[12.5px] leading-snug text-ink">
            {data.answer.text}
            <Cite n={data.answer.n} url={data.answer.url} />
          </p>
        )}
        {data.entity && (
          <div>
            <div className="text-[12.5px] font-semibold text-ink">
              {data.entity.title}
              {data.entity.type && <span className="font-normal text-ink-4"> · {data.entity.type}</span>}
              <Cite n={data.entity.n} url={data.entity.url} />
            </div>
            {data.entity.facts.length > 0 && (
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                {data.entity.facts.slice(0, 6).map((f) => (
                  <div key={f.label} className="min-w-0">
                    <dt className="truncate text-[10.5px] text-ink-4">{f.label}</dt>
                    <dd className="truncate text-[12px] font-medium text-ink" title={f.value}>
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
        {src.length > 0 ? (
          <ol className="space-y-1.5">
            {src.map((s) => (
              <li key={s.n} className="flex gap-1.5">
                <span className="tabular mt-px w-4 shrink-0 text-right text-[10.5px] font-semibold text-rose">{s.n}</span>
                <div className="min-w-0 flex-1">
                  <a href={s.url} target="_blank" rel="noreferrer" className="group flex items-center gap-1 text-[12px] leading-tight text-ink hover:text-rose">
                    <span className="truncate">{s.title}</span>
                    <ExternalLink size={10} className="shrink-0 text-ink-4 opacity-0 group-hover:opacity-100" />
                  </a>
                  <div className="truncate text-[10.5px] text-ink-4">
                    {s.domain}
                    {s.date && <> · {s.date}</>}
                  </div>
                  {s.snippet && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-3">{s.snippet}</p>}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          !data.answer && !data.entity && <p className="text-[12px] text-ink-4">No results.</p>
        )}
        {data.sources.length > 4 && (
          <button onClick={() => setAll(!all)} className="pl-5 text-[11px] text-ink-4 hover:text-ink-2">
            {all ? "Fewer sources" : `All ${data.sources.length} sources`}
          </button>
        )}
      </div>
    </Shell>
  );
});

/** rating as five stars, filled to the rating */
export function Stars({ rating, size = 10 }: { rating: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  const row = (cls: string) => (
    <span className={cx("flex", cls)}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} size={size} strokeWidth={0} fill="currentColor" />
      ))}
    </span>
  );
  return (
    <span className="relative inline-flex align-[-1px]" aria-label={`${rating} out of 5 stars`}>
      {row("text-line")}
      <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct}%` }}>
        {row("text-gold")}
      </span>
    </span>
  );
}

export function PlaceRow({ p, index, walkMinutes, onClick, active }: { p: LocalPlace; index: number; walkMinutes?: number; onClick?: () => void; active?: boolean }) {
  const within = walkMinutes ? p.walk_min <= walkMinutes : undefined;
  return (
    <button
      onClick={onClick}
      className={cx("flex w-full items-start gap-2 rounded-[6px] px-1.5 py-1.5 text-left outline-none hover:bg-paper-3/50 focus-visible:ring-2 focus-visible:ring-rose/40", active && "bg-paper-3/60")}
    >
      <span className={cx("tabular mt-px grid size-[18px] shrink-0 place-items-center rounded-full text-[10px] font-semibold", within === false ? "bg-paper-3 text-ink-3" : "bg-rose text-paper")}>{index}</span>
      {p.thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="mt-px size-9 shrink-0 rounded-[5px] object-cover ring-1 ring-line" onError={(e) => (e.currentTarget.style.display = "none")} />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-ink">{p.title}</span>
          {p.price && <span className="shrink-0 text-[10.5px] text-ink-4">{p.price}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-3">
          {p.rating !== undefined && (
            <span className="inline-flex items-center gap-1">
              <span className="tabular font-medium text-ink-2">{p.rating.toFixed(1)}</span>
              <Stars rating={p.rating} />
              {p.reviews !== undefined && <span className="tabular text-ink-4">({p.reviews.toLocaleString("en-US")})</span>}
            </span>
          )}
          {p.type && <span className="truncate text-ink-4">{p.type}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
          <span className={cx("tabular font-medium", within === false ? "text-ink-3" : "text-ink-2")}>
            {Math.max(1, Math.round(p.walk_min))} min walk
          </span>
          <span className="tabular text-ink-4">{fmtLen(p.walk_m)}</span>
          {p.open_now === true && <span className="text-good">Open now</span>}
          {p.open_now === false && <span className="text-ink-4">Closed</span>}
          {!p.inside && <span className="text-ink-4">· outside study area</span>}
        </span>
      </span>
    </button>
  );
}

export const PlacesCard = memo(function PlacesCard({ set, walkMinutes }: { set: PlaceSet; walkMinutes?: number }) {
  const [all, setAll] = useState(false);
  const shown = useSerp((s) => s.shown === set.id);
  const focus = useSerp((s) => s.focus);
  useApp((s) => s.worldVersion);
  const R = rtMaybe();
  const importable = useMemo(() => set.places.filter((p) => p.inside), [set]);
  const imported = R ? importable.filter((p) => importedPoi(R.world, p)).length : 0;
  const within = walkMinutes ? set.places.filter((p) => p.walk_min <= walkMinutes).length : null;
  const list = all ? set.places : set.places.slice(0, 5);
  return (
    <Shell
      icon={<MapPin size={13} strokeWidth={1.9} />}
      title={
        <>
          Google Maps · “{set.query}” <span className="font-normal text-ink-4">near {set.origin.label}</span>
        </>
      }
      meta={set.cached ? "cached" : undefined}
    >
      {within !== null && (
        <div className={cx("border-b border-line/60 px-2.5 py-1.5 text-[11.5px]", within ? "text-ink-2" : "text-warn")}>
          <span className="font-semibold">{within}</span> of {set.places.length} within a {walkMinutes}-minute walk
        </div>
      )}
      <div className="px-1 py-1">
        {set.places.length ? (
          list.map((p) => <PlaceRow key={p.id} p={p} index={set.places.indexOf(p) + 1} walkMinutes={walkMinutes} active={shown && focus === p.id} onClick={() => showOnMap(set, p.id)} />)
        ) : (
          <p className="px-1.5 py-1 text-[12px] text-ink-4">No places found.</p>
        )}
        {set.places.length > 5 && (
          <button onClick={() => setAll(!all)} className="px-1.5 pb-1 text-[11px] text-ink-4 hover:text-ink-2">
            {all ? "Fewer" : `All ${set.places.length} places`}
          </button>
        )}
      </div>
      {set.places.length > 0 && (
        <footer className="flex items-center gap-1.5 border-t border-line/70 px-2 py-1.5">
          <Button size="xs" variant={shown ? "outline" : "default"} onClick={() => showOnMap(set)} className="gap-1">
            <MapPinned className="size-3" /> {shown ? "On map" : "Show on map"}
          </Button>
          {importable.length > 0 &&
            (imported >= importable.length ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-good">
                <Check size={12} /> Counted in walk access
              </span>
            ) : (
              <Tooltip content="Add these Google Maps places as destinations for the walk-access model (one change; undo removes it)" side="top">
                <Button
                  size="xs"
                  variant="ghost"
                  className="gap-1 text-ink-3"
                  onClick={() => {
                    const W = rtMaybe()?.world;
                    if (W) applyOp(importPlaces(W, importable, "user", set.at));
                  }}
                >
                  <Plus className="size-3" /> Add as destinations
                </Button>
              </Tooltip>
            ))}
          <span className="ml-auto text-[10px] text-ink-4">via SerpApi</span>
        </footer>
      )}
    </Shell>
  );
});
