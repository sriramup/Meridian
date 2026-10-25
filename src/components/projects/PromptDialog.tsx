"use client";

// One name prompt for the app (kit Dialog), opened from anywhere with `promptText`, which resolves
// to the trimmed text, or null when cancelled.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input } from "../ui/kit";

interface Ask {
  title: string;
  body?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirm: string;
  resolve: (v: string | null) => void;
}

const usePrompt = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function promptText(opts: Omit<Ask, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    usePrompt.getState().ask?.resolve(null);
    usePrompt.setState({ ask: { ...opts, resolve } });
  });
}

export function PromptDialog() {
  const ask = usePrompt((s) => s.ask);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!ask) return;
    setText(ask.value ?? "");
    // select the suggested name so typing replaces it
    const t = setTimeout(() => input.current?.select(), 30);
    return () => clearTimeout(t);
  }, [ask]);
  const answer = (v: string | null) => {
    ask?.resolve(v);
    usePrompt.setState({ ask: null });
  };
  const ok = text.trim().length > 0;
  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && answer(null)}>
      <DialogContent size="sm" onOpenAutoFocus={(e) => (e.preventDefault(), input.current?.focus())}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) answer(text.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{ask?.title}</DialogTitle>
            {ask?.body && <DialogDescription>{ask.body}</DialogDescription>}
          </DialogHeader>
          <Input ref={input} size="md" value={text} maxLength={80} placeholder={ask?.placeholder} aria-label={ask?.label ?? ask?.title} onChange={(e) => setText(e.target.value)} data-testid="prompt-input" />
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => answer(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!ok}>
              {ask?.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
