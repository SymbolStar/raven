"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isLocale,
  LOCALE_STORAGE_KEY,
  translate,
  type Locale,
  type MessageKey,
} from "@/lib/locale";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {
    // Safe default when a component renders outside LocaleProvider.
  },
  t: (key) => translate(DEFAULT_LOCALE, key),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    setLocaleState(isLocale(stored) ? stored : detectLocale(navigator.language));
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (nextLocale: Locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    setLocaleState(nextLocale);
  };

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t: (key) => translate(locale, key) }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
