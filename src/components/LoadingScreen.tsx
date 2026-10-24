"use client";

import { useApp } from "@/state/store";

export function LoadingScreen() {
  const progress = useApp((s) => s.progress);
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.error);
  const label = useApp((s) => s.progressLabel);
  return (
    <div className="absolute inset-0 grid place-items-center bg-paper" style={{ backgroundImage: "var(--grain), radial-gradient(90% 80% at 50% 40%, #fbf5e6 0%, #f3e6c9 70%, #e9d7b1 100%)" }}>
      <div className="flex w-[320px] flex-col items-center text-center">
        <Wordmark className="origin-center scale-[1.9]" />
        <p className="mt-7 font-display text-[17px] leading-snug text-ink-3">Draw a town, then watch its shade, heat, water and traffic.</p>
        <div className="mt-6 h-1.5 w-full overflow-hidden rounded-full border border-line-2 bg-paper-2">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="mt-2 h-4 text-[11px] text-ink-4">{status === "error" ? "" : label}</p>
        {status === "error" && <p className="mt-2 text-[12px] text-bad">{error}</p>}
      </div>
    </div>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {/* a compass star on its meridian */}
      <svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden className="shrink-0">
        <circle r="8.2" fill="none" stroke="var(--color-gold)" strokeWidth="1" strokeDasharray="1.2 1.6" />
        <path d="M0 -9.5V9.5" stroke="var(--color-gold)" strokeWidth="0.9" strokeLinecap="round" />
        <path d="M0 -7 1.9 -1.9 7 0 1.9 1.9 0 7 -1.9 1.9 -7 0 -1.9 -1.9Z" fill="var(--color-accent)" stroke="var(--color-ink-2)" strokeWidth="0.8" strokeLinejoin="round" />
        <circle r="1.1" fill="var(--color-ink-2)" />
      </svg>
      <span className="font-brand text-[22px] leading-none text-ink">Meridian</span>
    </span>
  );
}
