import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
// One source of truth for both halves of the devtool: the runtime tabs read these through
// i18next's store, and the Files tab reads the same JSONs from disk via the Metro wrapper.
import en from './locales/en.json';
import de from './locales/de.json';
import ar from './locales/ar.json';

export const resources = {
  en: { translation: en },
  de: { translation: de },
  ar: { translation: ar },
};

i18next.use(initReactI18next).init({
  lng: 'de',
  fallbackLng: 'en',
  resources,
  interpolation: { escapeValue: false },
});

export default i18next;
