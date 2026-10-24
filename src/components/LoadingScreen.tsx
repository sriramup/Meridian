"use client";

import { useApp } from "@/state/store";

export function LoadingScreen() {
  const progress = useApp((s) => s.progress);
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.error);
  return (
    <div className="absolute inset-0 grid place-items-center bg-paper">
      <div className="w-[300px]">
        <Wordmark />
        <div className="mt-6 h-px w-full bg-line-2">
          <div className="h-px bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {status === "error" && <p className="mt-4 text-[12px] text-bad">{error}</p>}
      </div>
    </div>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden className="text-gold">
        <path d="M2 14.5 3.2 5l4.3 4L10 2.5 12.5 9l4.3-4L18 14.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M2.6 16.5h14.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span className="font-display text-[19px] leading-none font-semibold tracking-[0.2em]">MERIDIAN</span>
    </span>
  );
}
