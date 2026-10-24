"use client";

// View actions shared by the buttons, the keyboard and the search.

import { viewCenter } from "@/agent/resolve";
import { flyTo, pedestrianAt } from "@/render/camera";
import { useApp } from "./store";

/** step down into the street at the middle of the view, or back up above it */
export function togglePedestrian() {
  const st = useApp.getState();
  if (st.cameraMode === "pedestrian") {
    st.setCameraMode("orbit");
    flyTo(viewCenter(), { zoom: 17, pitch: 60 });
  } else {
    pedestrianAt(viewCenter());
    st.setCameraMode("pedestrian");
  }
}

export function toggleNight() {
  const st = useApp.getState();
  st.setTheme(st.theme === "model" ? "night" : "model");
}
