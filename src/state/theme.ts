// The interface theme: Cartography (the parchment atlas, the default) or Dark. Kept per browser in
// localStorage and applied as <html data-theme>; the layout sets it before the first paint
// (THEME_BOOT) so the page never flashes the other theme.

import { create } from "zustand";

export type ThemeId = "cartography" | "dark";

export const THEMES: { id: ThemeId; name: string; blurb: string }[] = [
  { id: "cartography", name: "Cartography", blurb: "Parchment, ink and engraved type" },
  { id: "dark", name: "Dark", blurb: "Clean neutral panels, easy on the eyes" },
];

const KEY = "meridian.theme";

function stored(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" ? "dark" : "cartography";
  } catch {
    return "cartography";
  }
}

export const useTheme = create<{ theme: ThemeId }>(() => ({ theme: typeof window === "undefined" ? "cartography" : stored() }));

export function setTheme(theme: ThemeId) {
  useTheme.setState({ theme });
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this page
  }
}

/** inline in <head>: apply the saved theme before anything paints */
export const THEME_BOOT = `try{document.documentElement.dataset.theme=localStorage.getItem(${JSON.stringify(KEY)})==="dark"?"dark":"cartography"}catch(e){}`;
