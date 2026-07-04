/**
 * Root layout. Loads the fonts (mono for the terminal chrome + numerals, a clean sans for
 * body) as CSS variables consumed by tailwind.config.ts, and sets page metadata.
 */
import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Opportunity MRI — scan any industry for hidden opportunity",
  description:
    "Opportunity MRI scans an industry for structural inefficiencies, labor shortages, software gaps, and AI-native business opportunities. A playful exploration engine — scores are heuristic.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
