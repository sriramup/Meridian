"use client";

import * as T from "@radix-ui/react-tabs";
import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn, focusRing } from "./cn";

type Variant = "segmented" | "underline";
const Ctx = createContext<Variant>("segmented");

export const Tabs = T.Root;

export const TabsList = forwardRef<ElementRef<typeof T.List>, ComponentPropsWithoutRef<typeof T.List> & { variant?: Variant }>(function TabsList(
  { className, variant = "segmented", ...props },
  ref,
) {
  return (
    <Ctx.Provider value={variant}>
      <T.List
        ref={ref}
        className={cn(
          "inline-flex items-center",
          variant === "segmented" ? "h-7 gap-[2px] rounded-[6px] border border-line bg-paper-2/80 p-[2px]" : "h-8 gap-3 border-b border-line",
          className,
        )}
        {...props}
      />
    </Ctx.Provider>
  );
});

export const TabsTrigger = forwardRef<ElementRef<typeof T.Trigger>, ComponentPropsWithoutRef<typeof T.Trigger>>(function TabsTrigger({ className, ...props }, ref) {
  const variant = useContext(Ctx);
  return (
    <T.Trigger
      ref={ref}
      className={cn(
        "inline-flex cursor-default select-none items-center justify-center gap-1.5 whitespace-nowrap text-[12px] font-medium leading-none transition-colors disabled:opacity-40 [&_svg[width='24']:not([class*='size-'])]:size-3.5",
        focusRing,
        variant === "segmented"
          ? "h-full rounded-[4px] px-2.5 text-ink-3 hover:text-ink aria-selected:bg-[#f8eed6] aria-selected:text-rose aria-selected:shadow-[0_1px_2px_rgb(88_60_28/0.22)]"
          : "relative -mb-px h-full border-b-2 border-transparent px-0.5 text-ink-3 hover:text-ink aria-selected:border-rose aria-selected:text-ink",
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<ElementRef<typeof T.Content>, ComponentPropsWithoutRef<typeof T.Content>>(function TabsContent({ className, ...props }, ref) {
  return <T.Content ref={ref} className={cn("outline-none", className)} {...props} />;
});
