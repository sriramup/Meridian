"use client";

// Export and import as user actions (menus, command search): the file picker, the download and
// the notice that reports what happened. The formats themselves live in proposalIO.ts.

import { exportProposal, importProposalText, ProposalImportError } from "./proposalIO";
import { rt } from "./runtime";
import { useApp } from "./store";

/** download the active proposal (or every one) as JSON or CSV */
export function saveProposal(format: "json" | "csv", which: "active" | "all" = "active") {
  try {
    exportProposal(rt(), format, which);
  } catch (err) {
    useApp.getState().notify(`Could not export: ${(err as Error).message}`, "error");
  }
}

/** import a proposal file (JSON or CSV) as a new branch and say what came in */
export async function openProposalFile(f: File) {
  const R = rt();
  const st = useApp.getState();
  const word = R.meta.sandbox ? "design" : "proposal";
  try {
    const res = importProposalText(R, await f.text(), f.name);
    st.bumpWorld();
    st.bumpScenarios();
    const what = res.names.length > 1 ? `${res.names.length} ${word}s` : `“${res.names[0]}”`;
    st.notify(res.notes.length ? `Imported ${what}. Not carried by CSV: ${res.notes.join("; ")}` : `Imported ${what} as a new ${word}`, res.notes.length ? "warn" : "info");
  } catch (err) {
    st.notify(err instanceof ProposalImportError ? err.message : `Could not import ${f.name}: ${(err as Error).message}`, "error");
  }
}

/** ask for a proposal file, then import it */
export function pickProposalFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json,text/csv,.csv";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void openProposalFile(f);
  };
  input.click();
}
