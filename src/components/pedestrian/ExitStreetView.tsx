"use client";

// The one on-screen control at street level: back up to the map. (How to move is in the Help
// guide; the cursor and the arrows on the ground explain themselves.)

import { ArrowLeft } from "lucide-react";
import { Button, Kbd } from "@/components/ui/kit";
import { useApp } from "@/state/store";
import { togglePedestrian } from "@/state/view";

export function ExitStreetView() {
  const walking = useApp((s) => s.cameraMode === "pedestrian");
  if (!walking) return null;
  return (
    <Button size="sm" onClick={togglePedestrian} className="chrome pointer-events-auto rounded-full pr-1.5 pl-2.5" title="Back to the map">
      <ArrowLeft />
      Exit street view
      <Kbd size="xs">Esc</Kbd>
    </Button>
  );
}
