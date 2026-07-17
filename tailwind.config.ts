import type { Config } from "tailwindcss";

/**
 * Design tokens for the "Bloomberg terminal meets Stripe" aesthetic:
 * near-black canvas, restrained electric accents, monospace numerals.
 * Colors are referenced throughout the UI as `bg-panel`, `text-accent`, etc.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#05070a", // page background — deeper than black-ish, terminal void
        panel: "#0b0f16", // card / panel surface
        panel2: "#111826", // raised surface (inputs, chips)
        line: "#1c2634", // hairline borders
        mute: "#5b6b80", // secondary / label text
        fg: "#c7d2e0", // primary text
        accent: "#2dd4bf", // electric teal — primary accent
        amber: "#f5a623", // warning / heat accent
        danger: "#ff5c73", // high-pain / risk accent
      },
      fontFamily: {
        // `mono` powers all numerals and the terminal chrome.
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      keyframes: {
        // Vertical sweep line used by the MRI-scan animation.
        sweep: {
          "0%": { transform: "translateY(-100%)", opacity: "0" },
          "50%": { opacity: "1" },
          "100%": { transform: "translateY(100%)", opacity: "0" },
        },
        blink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.2" } },
        rise: {
          "0%": { transform: "translateY(6px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        // Marching-ants dash offset — reads as "data flowing" along an active pipeline edge.
        "dash-flow": { to: { strokeDashoffset: "-20" } },
      },
      animation: {
        sweep: "sweep 2.2s ease-in-out infinite",
        blink: "blink 1s step-end infinite",
        rise: "rise 0.35s ease-out both",
        "dash-flow": "dash-flow 0.5s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
