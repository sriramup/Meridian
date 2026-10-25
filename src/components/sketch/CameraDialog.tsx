"use client";

import { Camera, CameraOff, RotateCcw, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Kbd, Spinner } from "@/components/ui/kit";

type Phase = { k: "starting" } | { k: "live" } | { k: "captured"; url: string; blob: Blob } | { k: "denied" } | { k: "unavailable"; message: string };

/**
 * Take a photo of a whiteboard or paper sketch: a live camera preview (the back camera on phones),
 * Capture → Retake / Use photo. A blocked permission or a missing camera gets its own clear state.
 * Space captures; Enter uses the photo.
 */
export function CameraDialog({ open, onOpenChange, onUse }: { open: boolean; onOpenChange: (o: boolean) => void; onUse: (blob: Blob) => void }) {
  const [phase, setPhase] = useState<Phase>({ k: "starting" });
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    for (const t of stream.current?.getTracks() ?? []) t.stop();
    stream.current = null;
  }, []);

  const start = useCallback(async () => {
    setPhase({ k: "starting" });
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setPhase({ k: "unavailable", message: "This browser can't use a camera here (it needs a secure https:// page). Upload a photo instead." });
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      stream.current = s;
      const v = video.current;
      if (v) {
        v.srcObject = s;
        await v.play().catch(() => undefined);
      }
      setPhase({ k: "live" });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") setPhase({ k: "denied" });
      else if (name === "NotFoundError" || name === "OverconstrainedError") setPhase({ k: "unavailable", message: "No camera was found on this device. Upload a photo of the sketch instead." });
      else setPhase({ k: "unavailable", message: "The camera couldn't be started (it may be in use by another app). Close other apps using it, or upload a photo instead." });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void start();
    return () => {
      stop();
      setPhase((p) => {
        if (p.k === "captured") URL.revokeObjectURL(p.url);
        return { k: "starting" };
      });
    };
  }, [open, start, stop]);

  const capture = useCallback(() => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob(
      (b) => {
        if (!b) return;
        stop();
        setPhase({ k: "captured", blob: b, url: URL.createObjectURL(b) });
      },
      "image/jpeg",
      0.92,
    );
  }, [stop]);

  const retake = () => {
    if (phase.k === "captured") URL.revokeObjectURL(phase.url);
    void start();
  };
  const use = () => {
    if (phase.k !== "captured") return;
    onUse(phase.blob);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        aria-describedby="camera-help"
        onKeyDown={(e) => {
          if (e.target instanceof HTMLButtonElement) return;
          if (e.key === " " && phase.k === "live") {
            e.preventDefault();
            capture();
          } else if (e.key === "Enter" && phase.k === "captured") {
            e.preventDefault();
            use();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Photograph a sketch</DialogTitle>
          <DialogDescription id="camera-help">Hold the camera square above the whiteboard or paper so the whole plan fills the frame.</DialogDescription>
        </DialogHeader>
        <div className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-[8px] border border-line-2 bg-[#2e1c0e]">
          <video ref={video} playsInline muted aria-label="Camera preview" className={phase.k === "live" || phase.k === "starting" ? "size-full object-contain" : "hidden"} />
          {phase.k === "captured" && <img src={phase.url} alt="Captured photo" className="size-full object-contain" />}
          {phase.k === "starting" && (
            <div className="absolute inset-0 grid place-items-center text-[12.5px] text-[#f4e6c7]">
              <span className="flex items-center gap-2">
                <Spinner size={14} label="Starting camera" /> Starting the camera…
              </span>
            </div>
          )}
          {phase.k === "denied" && (
            <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-paper-2 p-6 text-center">
              <CameraOff className="size-6 text-bad" />
              <div className="text-[13.5px] font-medium text-ink">Camera access is blocked</div>
              <p className="max-w-[360px] text-[12px] leading-snug text-ink-3">Allow the camera for this site in your browser’s address bar (the camera icon or site settings), then try again. Or close this and upload a photo.</p>
              <Button size="sm" onClick={() => void start()}>
                Try again
              </Button>
            </div>
          )}
          {phase.k === "unavailable" && (
            <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-paper-2 p-6 text-center">
              <CameraOff className="size-6 text-ink-3" />
              <div className="text-[13.5px] font-medium text-ink">No camera available</div>
              <p className="max-w-[360px] text-[12px] leading-snug text-ink-3">{phase.message}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          {phase.k === "live" && (
            <Button variant="primary" onClick={capture} className="gap-1.5" autoFocus>
              <Camera className="size-3.5" /> Capture <Kbd size="xs">Space</Kbd>
            </Button>
          )}
          {phase.k === "captured" && (
            <>
              <Button onClick={retake} className="gap-1.5">
                <RotateCcw className="size-3.5" /> Retake
              </Button>
              <Button variant="primary" onClick={use} className="gap-1.5" autoFocus>
                <Check className="size-3.5" /> Use photo
              </Button>
            </>
          )}
          {(phase.k === "denied" || phase.k === "unavailable") && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
