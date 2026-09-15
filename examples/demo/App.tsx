import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { createI18nextAdapter, useRozeniteI18nPlugin } from 'rozenite-i18n-devtools';
import i18n from './i18n';

// Built once, outside the component: rebuilding it every render would re-install the
// observers on every keystroke.
const adapter = createI18nextAdapter({ i18n });

// Demo-only: expose handles so the DevTools CDP session can assert on the adapter
// from the running Hermes runtime. Not something a real app would do.
(globalThis as any).__i18n = i18n;
(globalThis as any).__adapter = adapter;

/**
 * A screen whose translations are called during RENDER, which is how a real app is
 * written. Mounting it is enough — every key below is requested immediately, so the
 * missing ones surface without anyone tapping anything.
 *
 * `checkout.shipping`, `checkout.vat` and `checkout.promoCode` exist in no locale.
 */
function CheckoutScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.screen}>
      <Text style={styles.screenTitle}>{t('checkout.heading')}</Text>
      <Text style={styles.screenRow}>{t('checkout.total')}</Text>
      <Text style={styles.screenRow}>{t('checkout.tax')}</Text>
      <Text style={styles.screenRow}>{t('checkout.shipping')}</Text>
      <Text style={styles.screenRow}>{t('checkout.vat')}</Text>
      <Text style={styles.screenRow}>{t('checkout.promoCode', { code: undefined })}</Text>
    </View>
  );
}

export default function App() {
  useRozeniteI18nPlugin({ adapter });

  const { t } = useTranslation();
  const [screen, setScreen] = useState<'home' | 'checkout'>('home');
  const [log, setLog] = useState<string[]>([]);
  const push = (s: string) => setLog((l) => [s, ...l].slice(0, 8));

  const lng = i18n.language;

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1}>i18n DevTools demo</Text>
        <Text style={styles.sub}>
          active locale: <Text style={styles.mono}>{lng}</Text>
        </Text>

        <Text style={styles.label}>Navigate</Text>
        <Text style={styles.hint}>
          The Checkout screen renders missing keys directly in its body — no tapping. Open it
          and they appear in the Missing tab on their own.
        </Text>
        <View style={styles.row}>
          {(['home', 'checkout'] as const).map((s) => (
            <Pressable
              key={s}
              style={[styles.btn, screen === s && styles.btnActive]}
              onPress={() => setScreen(s)}
            >
              <Text style={styles.btnText}>{s}</Text>
            </Pressable>
          ))}
        </View>

        {screen === 'checkout' && <CheckoutScreen />}

        {/* Renders "Hallo {{name}}, willkommen zurück!" — no `name` passed, so this is
            an interpolation miss. i18next does NOT log it, even with debug: true. */}
        <Text style={styles.card}>{t('greeting')}</Text>

        <Text style={styles.label}>Locale</Text>
        <View style={styles.row}>
          {['en', 'de', 'ar'].map((l) => (
            <Pressable
              key={l}
              style={[styles.btn, lng === l && styles.btnActive]}
              onPress={() => i18n.changeLanguage(l)}
            >
              <Text style={styles.btnText}>{l}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Trigger a real missing key</Text>
        <Text style={styles.hint}>
          Resolves in no locale at all → fires missingKey → appears in the Missing tab.
        </Text>
        <Pressable
          style={styles.btn}
          onPress={() => push(`checkout.absent -> ${t('checkout.absent')}`)}
        >
          <Text style={styles.btnText}>t('checkout.absent')</Text>
        </Pressable>

        <Text style={styles.label}>Trigger a silent fallback</Text>
        <Text style={styles.hint}>
          Present in en, absent in de → renders English, fires NOTHING. Only the Coverage tab
          can see it.
        </Text>
        <View style={styles.row}>
          <Pressable style={styles.btn} onPress={() => push(`checkout.tax -> ${t('checkout.tax')}`)}>
            <Text style={styles.btnText}>t('checkout.tax')</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={() => push(`profile.bio -> ${t('profile.bio')}`)}>
            <Text style={styles.btnText}>t('profile.bio')</Text>
          </Pressable>
        </View>

        <Text style={styles.label}>Resolves normally</Text>
        <View style={styles.row}>
          <Pressable style={styles.btn} onPress={() => push(`nav.home -> ${t('nav.home')}`)}>
            <Text style={styles.btnText}>t('nav.home')</Text>
          </Pressable>
          <Pressable
            style={styles.btn}
            onPress={() => push(`checkout.total -> ${t('checkout.total')}`)}
          >
            <Text style={styles.btnText}>t('checkout.total')</Text>
          </Pressable>
        </View>

        {log.length > 0 && (
          <>
            <Text style={styles.label}>Output</Text>
            {log.map((l, i) => (
              <Text key={i} style={styles.logLine}>
                {l}
              </Text>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#12151a' },
  content: { padding: 20, paddingTop: 64, gap: 6 },
  h1: { fontSize: 22, fontWeight: '700', color: '#e8ecf1' },
  sub: { fontSize: 13, color: '#8794a2', marginBottom: 14 },
  mono: { fontFamily: 'Courier', color: '#6fa8dc' },
  card: {
    backgroundColor: '#1b222b',
    color: '#e8ecf1',
    padding: 14,
    borderRadius: 8,
    fontSize: 15,
    marginBottom: 6,
  },
  label: {
    color: '#8794a2',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 18,
    fontWeight: '600',
  },
  hint: { color: '#6b7585', fontSize: 12, lineHeight: 17, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  btn: {
    backgroundColor: '#232c37',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 6,
    marginTop: 4,
  },
  btnActive: { backgroundColor: '#2c6ca8' },
  btnText: { color: '#e8ecf1', fontSize: 13, fontWeight: '500' },
  logLine: { color: '#8fb377', fontSize: 12, fontFamily: 'Courier', marginTop: 3 },
  screen: {
    marginTop: 12,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#1b222b',
    borderWidth: 1,
    borderColor: '#2c6ca8',
    gap: 6,
  },
  screenTitle: { color: '#e8ecf1', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  screenRow: { color: '#b6c0cb', fontSize: 14 },
});
