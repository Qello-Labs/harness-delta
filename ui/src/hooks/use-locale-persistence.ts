import { useEffect } from 'react';
import type { Locale } from '../types';
export function useLocalePersistence(locale: Locale) {
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem('harness-delta.locale', locale);
    } catch {
      /* Preference is optional. */
    }
  }, [locale]);
}
