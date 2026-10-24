/// <reference lib="webworker" />
import { Engine, type EngineInit, type SimJob } from "./engine";

let engine: Engine | null = null;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { type: "init"; init: EngineInit } | { type: "run"; job: SimJob };
  try {
    if (msg.type === "init") {
      const t = performance.now();
      engine = new Engine(msg.init);
      ctx.postMessage({ type: "ready", ms: performance.now() - t });
      return;
    }
    if (!engine) throw new Error("engine not initialised");
    const job = msg.job;
    const t = performance.now();
    let last = 0;
    const { result, transfer } = engine.run(job, (p) => {
      const now = performance.now();
      if (now - last > 120) {
        last = now;
        ctx.postMessage({ type: "progress", id: job.id, p });
      }
    });
    ctx.postMessage({ type: "result", id: job.id, result, ms: performance.now() - t }, transfer);
  } catch (e) {
    const err = e as Error;
    ctx.postMessage({ type: "error", id: (msg as { job?: SimJob }).job?.id, error: err.message, stack: err.stack });
  }
};
