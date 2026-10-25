"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/kit";
import { memo } from "react";
import { monthDate, useApp } from "@/state/store";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** the modelled month (sun path and typical weather of its mean day), with month-by-month steppers */
export const MonthSelect = memo(function MonthSelect() {
  const date = useApp((s) => s.date);
  const setDate = useApp((s) => s.setDate);
  const m = +date.slice(0, 2) - 1;
  const step = "grid h-7 w-6 place-items-center rounded-[5px] text-ink-3 hover:bg-paper-3 hover:text-ink";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button onClick={() => setDate(monthDate(m - 1))} className={step} aria-label="Previous month">
        <ChevronLeft size={14} />
      </button>
      <Select value={String(m)} onValueChange={(v) => setDate(monthDate(+v))}>
        {/* the month and its chevron centred together as one unit */}
        <SelectTrigger aria-label="Month" title="Sun path and typical weather" className="w-[62px] justify-center gap-1 px-1.5 font-medium [&>span]:flex-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent side="top" align="center" className="min-w-[var(--radix-select-trigger-width)]">
          {MONTHS.map((x, i) => (
            <SelectItem key={x} value={String(i)}>
              {x}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button onClick={() => setDate(monthDate(m + 1))} className={step} aria-label="Next month">
        <ChevronRight size={14} />
      </button>
    </div>
  );
});
