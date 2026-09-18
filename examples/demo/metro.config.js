// Expo SDK 57 pattern: getDefaultConfig from expo/metro-config, then wrap.
// Both wrappers return async config factories, which Metro supports, and both compose in
// either order. NOTE: withRozenite's `enabled` defaults to FALSE.
const { getDefaultConfig } = require('expo/metro-config');
const { withRozenite } = require('@rozenite/metro');
const { withRozeniteI18nScan } = require('rozenite-i18n-devtools/metro');

const config = getDefaultConfig(__dirname);

module.exports = withRozeniteI18nScan(
  withRozenite(config, {
    enabled: process.env.NODE_ENV !== 'production',
  }),
  { locales: './locales', src: '.', ref: 'en' },
);
