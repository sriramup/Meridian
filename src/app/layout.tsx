import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const cormorant = Cormorant_Garamond({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-cormorant", display: "swap" });

export const metadata: Metadata = {
  title: "Meridian",
  description: "Model shade, trees and heat for real Austin streets, and see what each change does.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d1838" };

// Some browser extensions (Bitdefender's anti-tracker: bis_skin_checked, bis_register, __processed_*)
// tag every <div> before React hydrates, including Next's own hidden metadata boundary, which React
// then reports as a hydration mismatch. Strip those tags until the page has loaded.
const STRIP_EXTENSION_ATTRS = `(() => {
  const bad = (n) => n.startsWith("bis_") || n.startsWith("__processed_");
  const clean = (el) => { for (const a of [...el.attributes]) if (bad(a.name)) el.removeAttribute(a.name); };
  const mo = new MutationObserver((ms) => { for (const m of ms) if (m.type === "attributes" && m.attributeName && bad(m.attributeName)) m.target.removeAttribute(m.attributeName); else if (m.type === "childList") m.addedNodes.forEach((n) => n.nodeType === 1 && (clean(n), n.querySelectorAll("*").forEach(clean))); });
  mo.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  addEventListener("load", () => setTimeout(() => mo.disconnect(), 3000));
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${cormorant.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: STRIP_EXTENSION_ATTRS }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
