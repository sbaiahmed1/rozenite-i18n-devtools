import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

/**
 * Fixture deliberately built to exercise all three panel tabs:
 *
 *  - `de` is missing `checkout.tax` and `profile.bio`  -> they FALL BACK to English
 *    silently. No missingKey event. Visible only in the Coverage tab.
 *  - `ar` is missing most keys and is RTL.
 *  - `checkout.absent` exists NOWHERE                  -> a real missingKey event.
 *  - `greeting` interpolates {{name}}; the app renders it without passing one
 *                                                      -> an interpolation miss.
 */
export const resources = {
  en: {
    translation: {
      greeting: 'Hello {{name}}, welcome back!',
      'nav.home': 'Home',
      'nav.settings': 'Settings',
      'checkout.total': 'Total',
      'checkout.tax': 'Tax',
      'profile.bio': 'Biography',
      'profile.name': 'Name',
    },
  },
  de: {
    translation: {
      greeting: 'Hallo {{name}}, willkommen zurück!',
      'nav.home': 'Startseite',
      'nav.settings': 'Einstellungen',
      'checkout.total': 'Gesamt',
      'profile.name': 'Name',
      // checkout.tax and profile.bio deliberately absent -> silent fallback
    },
  },
  ar: {
    translation: {
      greeting: 'مرحبا {{name}}',
      'nav.home': 'الرئيسية',
      // everything else absent
    },
  },
};

i18next.use(initReactI18next).init({
  lng: 'de',
  fallbackLng: 'en',
  resources,
  interpolation: { escapeValue: false },
});

export default i18next;
