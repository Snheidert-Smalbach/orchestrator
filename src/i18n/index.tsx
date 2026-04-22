import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { en } from "./translations/en";
import { es } from "./translations/es";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Language = "en" | "es";

type Translations = typeof en;

// Recursive dot-notation key paths for type-safe t()
type Leaves<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : {
      [K in keyof T]: K extends string
        ? Leaves<T[K], `${Prefix}${Prefix extends "" ? "" : "."}${K}`>
        : never;
    }[keyof T];

export type TranslationKey = Leaves<Translations>;

type I18nContextValue = {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const LANG_STORAGE_KEY = "back-orchestrator.language";

const TRANSLATION_MAP: Record<Language, Record<string, unknown>> = {
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, key: string): string {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return key; // fallback to key itself
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : key;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, varKey: string) =>
    vars[varKey] !== undefined ? String(vars[varKey]) : `{${varKey}}`,
  );
}

function resolveInitialLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
  if (saved === "en" || saved === "es") return saved;
  const browser = navigator.language.toLowerCase();
  return browser.startsWith("es") ? "es" : "en";
}

// ─── Context ──────────────────────────────────────────────────────────────────

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  setLanguage: () => undefined,
  t: (key) => key,
});

// ─── Provider ─────────────────────────────────────────────────────────────────

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(resolveInitialLanguage);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>): string => {
      const translations = TRANSLATION_MAP[language];
      const fallback = TRANSLATION_MAP["en"];
      const value = getNestedValue(translations, key) || getNestedValue(fallback, key) || key;
      return interpolate(value, vars);
    },
    [language],
  );

  const value = useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTranslation() {
  return useContext(I18nContext);
}
