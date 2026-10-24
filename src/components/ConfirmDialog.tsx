"use client";

// One confirmation dialog for the app (kit Dialog), opened from anywhere with `confirmAction`,
// which resolves true when the person confirms.

import { create } from "zustand";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/kit";

interface Ask {
  title: string;
  body?: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function confirmAction(opts: Omit<Ask, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    // a newer question replaces an unanswered one (which counts as cancelled)
    useConfirm.getState().ask?.resolve(false);
    useConfirm.setState({ ask: { ...opts, resolve } });
  });
}

export function ConfirmDialog() {
  const ask = useConfirm((s) => s.ask);
  const answer = (ok: boolean) => {
    ask?.resolve(ok);
    useConfirm.setState({ ask: null });
  };
  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && answer(false)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{ask?.title}</DialogTitle>
          {ask?.body && <DialogDescription>{ask.body}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => answer(false)}>
            {ask?.cancel ?? "Cancel"}
          </Button>
          <Button variant={ask?.danger ? "danger" : "primary"} size="sm" autoFocus onClick={() => answer(true)}>
            {ask?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
