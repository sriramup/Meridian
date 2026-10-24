"use client";

import * as S from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { monthDate, useApp } from "@/state/store";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** the modelled month (sun path and typical weather of its mean day), with month-by-month steppers */
export function MonthSelect() {
  const date = useApp((s) => s.date);
  const setDate = useApp((s) => s.setDate);
  const m = +date.slice(0, 2) - 1;
  const step = "grid h-7 w-6 place-items-center rounded-[5px] text-ink-3 hover:bg-paper-3 hover:text-ink";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button onClick={() => setDate(monthDate(m - 1))} className={step} aria-label="Previous month">
        <ChevronLeft size={14} />
      </button>
      <S.Root value={String(m)} onValueChange={(v) => setDate(monthDate(+v))}>
        <S.Trigger aria-label="Month" className="inline-flex h-7 w-[64px] items-center justify-center gap-1 rounded-[5px] border border-line-2 bg-paper text-[12.5px] font-medium text-ink outline-none hover:border-accent/60 focus-visible:border-accent data-[state=open]:border-accent">
          <S.Value />
          <S.Icon className="text-ink-3">
            <ChevronDown size={12} />
          </S.Icon>
        </S.Trigger>
        <S.Portal>
          <S.Content position="popper" side="top" sideOffset={6} align="center" className="chrome z-50 min-w-[var(--radix-select-trigger-width)] p-1">
            <S.Viewport className="grid grid-cols-3 gap-0.5">
              {MONTHS.map((x, i) => (
                <S.Item key={x} value={String(i)} className="relative flex h-7 cursor-default items-center justify-center rounded-[4px] px-2.5 text-[12.5px] text-ink outline-none select-none data-[highlighted]:bg-paper-3 data-[state=checked]:font-semibold">
                  <S.ItemText>{x}</S.ItemText>
                  <S.ItemIndicator className="absolute right-0.5">
                    <Check size={10} className="text-rose" />
                  </S.ItemIndicator>
                </S.Item>
              ))}
            </S.Viewport>
          </S.Content>
        </S.Portal>
      </S.Root>
      <button onClick={() => setDate(monthDate(m + 1))} className={step} aria-label="Next month">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
