import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        panel: "rgb(var(--color-panel) / <alpha-value>)",
        panelSoft: "rgb(var(--color-panel-soft) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        accentWarm: "rgb(var(--color-accent-warm) / <alpha-value>)",
        line: "rgb(var(--color-line) / <alpha-value>)",
        textStrong: "rgb(var(--color-text-strong) / <alpha-value>)",
        textMuted: "rgb(var(--color-text-muted) / <alpha-value>)",
        textSoft: "rgb(var(--color-text-soft) / <alpha-value>)",
        ok: "rgb(var(--color-ok) / <alpha-value>)",
        warn: "rgb(var(--color-warn) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        info: "rgb(var(--color-info) / <alpha-value>)"
      },
      boxShadow: {
        glow: "0 18px 48px rgb(var(--shadow-color) / 0.18)"
      },
      fontFamily: {
        sans: ["var(--font-sans)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"]
      }
    }
  },
  plugins: []
} satisfies Config;
