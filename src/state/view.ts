"use client";

// View actions shared by the buttons, the keyboard and the search.

import { viewCenter } from "@/agent/resolve";
import { leaveStreetView, pedestrianAt } from "@/render/streetView";
import { useApp } from "./store";

/** step down into the street at the middle of the view (Street View), or back up above it */
export function togglePedestrian() {
  const st = useApp.getState();
  if (st.cameraMode === "pedestrian") {
    leaveStreetView();
    st.setCameraMode("orbit");
  } else {
    // a drawing tool in hand would turn clicks into points instead of steps
    if (st.tool !== "select") st.setTool("select");
    pedestrianAt(viewCenter());
    st.setCameraMode("pedestrian");
  }
}

export function toggleNight() {
  const st = useApp.getState();
  st.setTheme(st.theme === "model" ? "night" : "model");
}
