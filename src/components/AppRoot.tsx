"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { cityFromUrl, presetOf } from "@/state/cities";
import { restoreDesign } from "@/state/persist";
import { loadCity, loadSandbox } from "@/state/runtime";
import { useApp } from "@/state/store";
import { LoadingScreen } from "./LoadingScreen";

const Shell = dynamic(() => import("./Shell").then((m) => m.Shell), { ssr: false });

export function AppRoot() {
  const status = useApp((s) => s.status);
  // the app is client-only (WebGL, workers); rendering nothing on the server leaves no markup for
  // browser extensions to rewrite before hydration
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (useApp.getState().status !== "idle") return;
    useApp.setState({ status: "loading", progress: 0, progressLabel: "Connecting" });
    // the blank canvas by default; ?city=austin (or the city menu) loads a measured city
    const city = cityFromUrl();
    const preset = presetOf(city)!;
    const onProgress = (p: number, label: string) => useApp.setState({ progress: p, progressLabel: label });
    // the canvas opens clean (no analysis overlay over an empty site)
    (preset.kind === "sandbox" ? loadSandbox(preset.climate!, onProgress).then(() => (useApp.setState((s) => ({ overlay: null, showChanges: false, layers: { ...s.layers, transit: true } })), restoreDesign())) : loadCity(city, onProgress))
      .then(() => useApp.setState({ status: "ready" }))
      .catch((e: Error) => useApp.setState({ status: "error", error: e.message }));
  }, []);
  return (
    <main className="fixed inset-0 overflow-hidden">
      {!mounted ? null : status === "ready" ? <Shell /> : <LoadingScreen />}
    </main>
  );
}
