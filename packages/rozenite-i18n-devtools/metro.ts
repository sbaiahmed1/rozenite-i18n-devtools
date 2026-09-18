/**
 * Metro entry point: `require('rozenite-i18n-devtools/metro')` in metro.config.js.
 * Node-only — never imported by the app or the panel.
 */
export { withRozeniteI18nScan, createScanRequestHandler, SCAN_ROUTE } from './src/node/with-i18n-scan';
export type { WithI18nScanOptions } from './src/node/with-i18n-scan';
export type { ScanReport } from './src/node/scan-core';
