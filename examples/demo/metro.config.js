// Expo SDK 57 pattern: getDefaultConfig from expo/metro-config, then wrap.
// withRozenite returns an async config factory, which Metro supports.
// NOTE: `enabled` defaults to FALSE — without this the plugin silently never loads.
const { getDefaultConfig } = require('expo/metro-config');
const { withRozenite } = require('@rozenite/metro');

const config = getDefaultConfig(__dirname);

module.exports = withRozenite(config, {
  enabled: process.env.NODE_ENV !== 'production',
});
