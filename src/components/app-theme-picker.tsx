import { MoonStar, Palette, SunMedium } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ThemeDefinition, ThemeFamily, ThemeMode } from "../lib/app-shell";
import { useTranslation } from "../i18n";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

type Props = {
  activeTheme: ThemeDefinition;
  themeMode: ThemeMode;
  themeFamily: ThemeFamily;
  themes: ThemeDefinition[];
  onThemeModeChange: (mode: ThemeMode) => void;
  onThemeFamilyChange: (family: ThemeFamily) => void;
};

export function AppThemePicker({
  activeTheme,
  themeMode,
  themeFamily,
  themes,
  onThemeModeChange,
  onThemeFamilyChange,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  const modeLabel = themeMode === "dark" ? t("theme.dark") : t("theme.light");

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="secondary"
        size="icon"
        onClick={() => setOpen((current) => !current)}
        title={t("theme.buttonTitle", { theme: activeTheme.label, mode: modeLabel })}
      >
        <Palette className="h-4 w-4" />
      </Button>

      {open ? (
        <Card className="absolute right-0 top-full z-20 mt-2 w-[260px] p-2" tone="muted">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[9px] uppercase tracking-[0.2em] text-textSoft">{t("theme.label")}</p>
              <p className="mt-0.5 text-[10px] text-textMuted">
                {activeTheme.label} {modeLabel}
              </p>
            </div>
            <div className="surface-chip inline-flex overflow-hidden">
              <Button
                type="button"
                variant={themeMode === "light" ? "default" : "ghost"}
                size="sm"
                className="border-r border-line shadow-none"
                onClick={() => onThemeModeChange("light")}
              >
                <SunMedium className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                variant={themeMode === "dark" ? "default" : "ghost"}
                size="sm"
                className="shadow-none"
                onClick={() => onThemeModeChange("dark")}
              >
                <MoonStar className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-1">
            {themes.map((theme) => {
              const isSelected = theme.id === themeFamily;
              return (
                <button
                  key={theme.id}
                  type="button"
                  className={[
                    "ui-theme-option",
                    isSelected ? "ui-theme-option--active" : "",
                  ].join(" ")}
                  onClick={() => {
                    onThemeFamilyChange(theme.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex items-center gap-1">
                    {theme.preview.map((color) => (
                      <span
                        key={`${theme.id}-${color}`}
                        className="h-2.5 w-2.5 border border-ink/15"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </span>
                  <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-textStrong">
                    {theme.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-textSoft">
                    {t(theme.description as Parameters<typeof t>[0])}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
