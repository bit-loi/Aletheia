/**
 * App.tsx: Main Aletheia Mobile application.
 *
 * Single screen app matching the Chrome extension UI:
 * 1. Dark and Light theme switching
 * 2. Header with logo and theme toggle slider
 * 3. Connection status bar with indicator dot
 * 4. Mode card and primary action button
 * 5. Results view with verdict badges and source links
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  AppState,
  Image,
  Linking,
  LogBox,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

LogBox.ignoreAllLogs();
import {useListenSession, type SessionPhase} from './src/useListenSession';
import type {ClaimResult} from './src/verifyContent';
import {
  checkOverlayPermission,
  openVendorAutoStartSettings,
  requestOverlayPermission,
  startFloatingWidget,
  stopFloatingWidget,
  subscribeFloatingWidgetTap,
} from './src/audioCapture';

// Theme Definitions matching shared/tokens.js

type ThemeMode = 'dark' | 'light';

interface ColorTokens {
  surface: string;
  surfaceRaised: string;
  ink: string;
  inkMuted: string;
  borderHairline: string;
  borderStrong: string;
  glassHighlight: string;
  focus: string;
  
  verdictTrueAccent: string;
  verdictTrueInk: string;
  verdictFalseAccent: string;
  verdictFalseInk: string;
  verdictMisleadingAccent: string;
  verdictMisleadingInk: string;
  verdictUnverifiedAccent: string;
  verdictUnverifiedInk: string;
}

const DARK_TOKENS: ColorTokens = {
  surface: '#0B0B0D',
  surfaceRaised: '#141418',
  ink: '#FAFAFA',
  inkMuted: '#A1A1AA',
  borderHairline: 'rgba(255, 255, 255, 0.16)',
  borderStrong: 'rgba(255, 255, 255, 0.92)',
  glassHighlight: 'rgba(255, 255, 255, 0.22)',
  focus: '#7DB8FF',

  verdictTrueAccent: '#10B981',
  verdictTrueInk: '#34D399',
  verdictFalseAccent: '#EF4444',
  verdictFalseInk: '#F87171',
  verdictMisleadingAccent: '#F59E0B',
  verdictMisleadingInk: '#FBBF24',
  verdictUnverifiedAccent: '#71717A',
  verdictUnverifiedInk: '#A1A1AA',
};

const LIGHT_TOKENS: ColorTokens = {
  surface: '#FFFFFF',
  surfaceRaised: '#F4F4F5',
  ink: '#18181B',
  inkMuted: '#52525B',
  borderHairline: 'rgba(0, 0, 0, 0.14)',
  borderStrong: 'rgba(0, 0, 0, 0.88)',
  glassHighlight: 'rgba(255, 255, 255, 0.90)',
  focus: '#0B63CE',

  verdictTrueAccent: '#059669',
  verdictTrueInk: '#047857',
  verdictFalseAccent: '#DC2626',
  verdictFalseInk: '#B91C1C',
  verdictMisleadingAccent: '#D97706',
  verdictMisleadingInk: '#B45309',
  verdictUnverifiedAccent: '#71717A',
  verdictUnverifiedInk: '#52525B',
};

function App(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [lang, setLang] = useState<'id' | 'en'>('id');
  const tokens = theme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;

  const {state, startSession, cancelSession, resetSession, checkHeadphones} =
    useListenSession();

  const [floatingWidgetEnabled, setFloatingWidgetEnabled] = useState(false);
  const [showAutoStartTip, setShowAutoStartTip] = useState(true);
  // Latest language captured for the widget-tap subscription without
  // re-subscribing on every language toggle.
  const langRef = useRef(lang);
  langRef.current = lang;
  // Set when the user taps "Enable floating widget" and we had to leave the
  // app for Settings; cleared once the grant is detected on return.
  const pendingOverlayEnableRef = useRef(false);

  useEffect(() => {
    checkHeadphones();
    const interval = setInterval(checkHeadphones, 3000);

    // Overlay permission may already be granted from an earlier session.
    checkOverlayPermission().then(granted => {
      if (granted) setFloatingWidgetEnabled(true);
    });

    const subscription = AppState.addEventListener('change', async nextState => {
      if (nextState === 'active') {
        checkHeadphones();
        // User came back from Settings after tapping "Enable floating
        // widget": if the overlay permission is now granted, start the
        // widget foreground service immediately — no second button press.
        if (pendingOverlayEnableRef.current) {
          const granted = await checkOverlayPermission();
          if (granted) {
            pendingOverlayEnableRef.current = false;
            startFloatingWidget();
            setFloatingWidgetEnabled(true);
          }
        }
      }
    });

    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [checkHeadphones]);

  // Bubble tap → run the existing Listen session (same flow as the button).
  useEffect(() => {
    const sub = subscribeFloatingWidgetTap(() => {
      startSession(langRef.current);
    });
    return () => {
      sub?.remove();
    };
  }, [startSession]);

  const handleEnableWidget = async () => {
    const granted = await checkOverlayPermission();
    if (granted) {
      startFloatingWidget();
      setFloatingWidgetEnabled(true);
      return;
    }
    // Open Settings; the AppState listener starts the service on return.
    pendingOverlayEnableRef.current = true;
    await requestOverlayPermission();
  };

  const handleHideWidget = () => {
    stopFloatingWidget();
    setFloatingWidgetEnabled(false);
  };

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <SafeAreaView style={[styles.container, {backgroundColor: tokens.surface}]}>
      <StatusBar
        barStyle={theme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={tokens.surface}
      />

      {/* Popup Header */}
      <View style={[styles.header, {borderBottomColor: tokens.borderHairline}]}>
        <View style={styles.logoRow}>
          <View style={styles.logoInfo}>
            <Image
              source={require('./src/assets/logo.png')}
              style={[styles.logoImage, {borderColor: tokens.borderHairline}]}
            />
            <View>
              <Text style={[styles.title, {color: tokens.ink}]}>Aletheia</Text>
              <Text style={[styles.tagline, {color: tokens.inkMuted}]}>
                AI FACT CHECKER
              </Text>
            </View>
          </View>

          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            {/* Language Segmented Control */}
            <View
              style={[
                styles.segmentedControl,
                {
                  backgroundColor: tokens.surfaceRaised,
                  borderColor: tokens.borderHairline,
                  marginRight: 8,
                },
              ]}>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setLang('id')}
                style={[
                  styles.segmentBtn,
                  lang === 'id' && {backgroundColor: '#FFFFFF'},
                ]}>
                <Text
                  style={[
                    styles.segmentText,
                    {color: lang === 'id' ? '#000000' : tokens.inkMuted},
                  ]}>
                  ID
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setLang('en')}
                style={[
                  styles.segmentBtn,
                  lang === 'en' && {backgroundColor: '#FFFFFF'},
                ]}>
                <Text
                  style={[
                    styles.segmentText,
                    {color: lang === 'en' ? '#000000' : tokens.inkMuted},
                  ]}>
                  EN
                </Text>
              </TouchableOpacity>
            </View>

            {/* Theme Toggle */}
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={toggleTheme}
              style={[
                styles.themeToggleContainer,
                {
                  backgroundColor: tokens.surfaceRaised,
                  borderColor: tokens.borderHairline,
                },
              ]}>
              <Text
                style={[
                  styles.themeLabel,
                  {color: theme === 'dark' ? tokens.ink : tokens.inkMuted},
                ]}>
                DARK
              </Text>
              <View
                style={[
                  styles.themeSwitch,
                  {
                    backgroundColor: tokens.surface,
                    borderColor: tokens.borderHairline,
                  },
                ]}>
                <View
                  style={[
                    styles.themeSlider,
                    {
                      backgroundColor: tokens.ink,
                      transform: [{translateX: theme === 'light' ? 12 : 2}],
                    },
                  ]}
                />
              </View>
              <Text
                style={[
                  styles.themeLabel,
                  {color: theme === 'light' ? tokens.ink : tokens.inkMuted},
                ]}>
                LIGHT
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Main Content */}
      <View style={styles.content}>
        {state.phase === 'done' && state.result ? (
          <ResultsView
            result={state.result}
            tokens={tokens}
            onReset={resetSession}
          />
        ) : (
          <LaunchView
            phase={state.phase}
            statusText={state.statusText}
            amplitude={state.amplitude}
            headphonesConnected={state.headphonesConnected}
            error={state.error}
            tokens={tokens}
            lang={lang}
            onListen={() => startSession(lang)}
            onCancel={cancelSession}
            onRetry={resetSession}
            floatingWidgetEnabled={floatingWidgetEnabled}
            showAutoStartTip={showAutoStartTip}
            onEnableWidget={handleEnableWidget}
            onHideWidget={handleHideWidget}
            onDismissAutoStartTip={() => setShowAutoStartTip(false)}
            onOpenAutoStartSettings={openVendorAutoStartSettings}
          />
        )}
      </View>

      {/* Footer */}
      <View style={[styles.footer, {borderTopColor: tokens.borderHairline}]}>
        <Text style={[styles.footerText, {color: tokens.inkMuted}]}>
          {lang === 'en'
            ? 'Open an article or video, then start a check.'
            : 'Buka artikel atau video, lalu mulai verifikasi.'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

// Launch Panel View

interface LaunchViewProps {
  phase: SessionPhase;
  statusText: string;
  amplitude: number;
  headphonesConnected: boolean;
  error: string | null;
  tokens: ColorTokens;
  lang: 'id' | 'en';
  onListen: () => void;
  onCancel: () => void;
  onRetry: () => void;
  floatingWidgetEnabled: boolean;
  showAutoStartTip: boolean;
  onEnableWidget: () => void;
  onHideWidget: () => void;
  onDismissAutoStartTip: () => void;
  onOpenAutoStartSettings: () => void;
}

function LaunchView({
  phase,
  statusText,
  headphonesConnected,
  error,
  tokens,
  lang,
  onListen,
  onCancel,
  onRetry,
  floatingWidgetEnabled,
  showAutoStartTip,
  onEnableWidget,
  onHideWidget,
  onDismissAutoStartTip,
  onOpenAutoStartSettings,
}: LaunchViewProps) {
  const isEn = lang === 'en';
  const isActive = phase === 'recording';
  const isProcessing = phase === 'transcribing' || phase === 'verifying';

  let dotColor = tokens.verdictTrueAccent;
  let statusTitle = isEn ? 'Connected to proxy' : 'Proxy aman terhubung';
  let statusDetail = isEn ? 'Shared services ready' : 'Layanan bersama siap digunakan';

  if (headphonesConnected && phase === 'idle') {
    dotColor = tokens.verdictMisleadingAccent;
    statusTitle = isEn ? 'Headphones detected' : 'Headphone terdeteksi';
    statusDetail = isEn ? 'Unplug headphones to allow microphone audio capture' : 'Lepaskan headphone agar audio dapat ditangkap mikrofon';
  } else if (error) {
    dotColor = tokens.verdictFalseAccent;
    statusTitle = isEn ? 'Service error' : 'Error layanan';
    statusDetail = error;
  } else if (isActive) {
    dotColor = tokens.verdictFalseAccent;
    statusTitle = isEn ? 'Listening to audio' : 'Mendengarkan audio';
    statusDetail = statusText || (isEn ? 'Capturing microphone stream' : 'Menangkap aliran suara mikrofon');
  } else if (isProcessing) {
    dotColor = tokens.verdictMisleadingAccent;
    statusTitle = isEn ? 'Verifying content' : 'Memeriksa konten';
    statusDetail = statusText || (isEn ? 'Analyzing claims against trusted sources' : 'Menganalisis klaim terhadap sumber terpercaya');
  }

  let buttonText = isEn ? 'START FACT CHECK' : 'MULAI VERIFIKASI';
  if (isActive) {
    buttonText = isEn ? 'STOP LISTENING' : 'BERHENTI MENDENGARKAN';
  } else if (isProcessing) {
    buttonText = isEn ? 'CHECKING CONTENT' : 'MEMERIKSA KONTEN';
  }

  return (
    <ScrollView style={styles.launchScroll} contentContainerStyle={styles.launchContainer}>
      {/* Connection Status Card */}
      <View
        style={[
          styles.connectionStatus,
          {
            backgroundColor: tokens.surfaceRaised,
            borderColor: tokens.borderHairline,
          },
        ]}>
        <View style={[styles.statusDot, {backgroundColor: dotColor}]} />
        <View style={styles.statusTextContainer}>
          <Text style={[styles.connectionTitle, {color: tokens.ink}]}>
            {statusTitle}
          </Text>
          <Text style={[styles.connectionDetail, {color: tokens.inkMuted}]}>
            {statusDetail}
          </Text>
        </View>
      </View>

      {/* Mode Card */}
      <View
        style={[
          styles.modeCard,
          {
            backgroundColor: tokens.surface,
            borderColor: tokens.borderHairline,
          },
        ]}>
        <Text style={[styles.modeCardLabel, {color: tokens.inkMuted}]}>
          {isEn ? 'CURRENT MODE' : 'MODE SAAT INI'}
        </Text>
        <Text style={[styles.modeCardTitle, {color: tokens.ink}]}>
          {isActive
            ? (isEn ? 'Listening to playback' : 'Mendengarkan audio')
            : isProcessing
            ? (isEn ? 'Analyzing claims' : 'Menganalisis klaim')
            : (isEn ? 'Audio fact checker' : 'Pemeriksa fakta audio')}
        </Text>
        <Text style={[styles.modeCardDescription, {color: tokens.inkMuted}]}>
          {isEn
            ? 'Aletheia automatically extracts factual statements from playing media and verifies them against trusted sources.'
            : 'Aletheia secara otomatis mengekstrak pernyataan faktual dari media yang diputar dan memverifikasinya terhadap sumber terpercaya.'}
        </Text>
      </View>

      {/* Floating Widget Card */}
      <View
        style={[
          styles.modeCard,
          {backgroundColor: tokens.surface, borderColor: tokens.borderHairline},
        ]}>
        <View style={styles.widgetHeaderRow}>
          <Text style={[styles.modeCardLabel, {color: tokens.inkMuted}]}>
            {isEn ? 'FLOATING WIDGET' : 'WIDGET MELAYANG'}
          </Text>
          {floatingWidgetEnabled && (
            <View
              style={[
                styles.widgetStatusChip,
                {backgroundColor: tokens.verdictTrueAccent + '22'},
              ]}>
              <Text
                style={[styles.widgetStatusText, {color: tokens.verdictTrueInk}]}>
                {isEn ? 'ACTIVE' : 'AKTIF'}
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.modeCardDescription, {color: tokens.inkMuted}]}>
          {isEn
            ? 'A draggable bubble floats over other apps. Tap it to fact-check what you hear.'
            : 'Bubble yang dapat digeser melayang di atas aplikasi lain. Ketuk untuk memeriksa fakta yang Anda dengar.'}
        </Text>
        <TouchableOpacity
          style={[
            styles.widgetButton,
            {
              backgroundColor: tokens.surfaceRaised,
              borderColor: tokens.borderHairline,
            },
          ]}
          onPress={floatingWidgetEnabled ? onHideWidget : onEnableWidget}
          activeOpacity={0.8}>
          <Text style={[styles.widgetButtonText, {color: tokens.ink}]}>
            {floatingWidgetEnabled
              ? isEn
                ? 'HIDE WIDGET'
                : 'SEMBUNYIKAN WIDGET'
              : isEn
              ? 'ENABLE FLOATING WIDGET'
              : 'AKTIFKAN WIDGET MELAYANG'}
          </Text>
        </TouchableOpacity>

        {/* One-time, best-effort vendor auto-start suggestion */}
        {showAutoStartTip && (
          <View
            style={[
              styles.autoStartTip,
              {
                backgroundColor: tokens.surfaceRaised,
                borderColor: tokens.borderHairline,
              },
            ]}>
            <Text style={[styles.autoStartTipText, {color: tokens.inkMuted}]}>
              {isEn
                ? 'For best reliability on this device, allow auto-start.'
                : 'Untuk keandalan terbaik di perangkat ini, izinkan auto-start.'}
            </Text>
            <View style={styles.autoStartActions}>
              <TouchableOpacity
                onPress={onOpenAutoStartSettings}
                activeOpacity={0.7}
                style={styles.autoStartLinkBtn}>
                <Text style={[styles.autoStartLink, {color: tokens.focus}]}>
                  {isEn ? 'OPEN SETTINGS' : 'BUKA PENGATURAN'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onDismissAutoStartTip}
                activeOpacity={0.7}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Text style={[styles.autoStartDismiss, {color: tokens.inkMuted}]}>
                  ✕
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* Action Button */}
      {error ? (
        <TouchableOpacity
          style={[styles.btnPrimary, {backgroundColor: tokens.ink, borderColor: tokens.ink}]}
          onPress={onRetry}
          activeOpacity={0.8}>
          <Text style={[styles.btnPrimaryText, {color: tokens.surface}]}>
            {isEn ? 'TRY AGAIN' : 'COBA LAGI'}
          </Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[
            styles.btnPrimary,
            {
              backgroundColor: isActive ? tokens.verdictFalseAccent : tokens.ink,
              borderColor: isActive ? tokens.verdictFalseAccent : tokens.ink,
              opacity: headphonesConnected && phase === 'idle' ? 0.45 : 1,
            },
          ]}
          disabled={headphonesConnected && phase === 'idle'}
          onPress={isActive ? onCancel : isProcessing ? undefined : onListen}
          activeOpacity={0.8}>
          <Text style={[styles.btnPrimaryText, {color: tokens.surface}]}>
            {buttonText}
          </Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

// Results View

interface ResultsViewProps {
  result: {claims: ClaimResult[]; rawTranscript: string};
  tokens: ColorTokens;
  onReset: () => void;
}

function ResultsView({result, tokens, onReset}: ResultsViewProps) {
  const {claims, rawTranscript} = result;

  return (
    <ScrollView
      style={styles.resultsScroll}
      contentContainerStyle={styles.resultsContent}
      showsVerticalScrollIndicator={false}>
      {/* Transcript Card */}
      <View
        style={[
          styles.card,
          {
            backgroundColor: tokens.surfaceRaised,
            borderColor: tokens.borderHairline,
          },
        ]}>
        <Text style={[styles.cardSectionLabel, {color: tokens.inkMuted}]}>
          TRANSCRIPT
        </Text>
        <Text style={[styles.transcriptText, {color: tokens.ink}]}>
          {rawTranscript.length > 500
            ? rawTranscript.slice(0, 500) + '...'
            : rawTranscript}
        </Text>
      </View>

      {/* Claims */}
      {claims.length === 0 ? (
        <View
          style={[
            styles.card,
            {
              backgroundColor: tokens.surface,
              borderColor: tokens.borderHairline,
            },
          ]}>
          <Text style={[styles.cardTitle, {color: tokens.ink}]}>
            No verifiable claims found
          </Text>
          <Text style={[styles.cardSubtext, {color: tokens.inkMuted}]}>
            The audio did not contain clear factual claims that can be verified against sources.
          </Text>
        </View>
      ) : (
        claims.map((item, index) => (
          <ClaimCard key={index} item={item} index={index} tokens={tokens} />
        ))
      )}

      {/* Reset Button */}
      <TouchableOpacity
        style={[styles.btnPrimary, {backgroundColor: tokens.ink, borderColor: tokens.ink, marginTop: 12}]}
        onPress={onReset}
        activeOpacity={0.8}>
        <Text style={[styles.btnPrimaryText, {color: tokens.surface}]}>
          START NEW CHECK
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// Claim Card Component

function ClaimCard({
  item,
  index,
  tokens,
}: {
  item: ClaimResult;
  index: number;
  tokens: ColorTokens;
}) {
  const verdictStyle = getVerdictColors(item.verdict.verdict, tokens);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: tokens.surface,
          borderColor: tokens.borderHairline,
        },
      ]}>
      <View style={styles.claimHeader}>
        <Text style={[styles.claimIndex, {color: tokens.inkMuted}]}>
          CLAIM {index + 1}
        </Text>
        <View
          style={[
            styles.verdictBadge,
            {backgroundColor: verdictStyle.bg},
          ]}>
          <Text style={[styles.verdictBadgeText, {color: verdictStyle.fg}]}>
            {item.verdict.verdict.toUpperCase()}
          </Text>
        </View>
      </View>

      <Text style={[styles.claimText, {color: tokens.ink}]}>
        "{item.claim}"
      </Text>

      <View style={[styles.verdictDetails, {borderTopColor: tokens.borderHairline}]}>
        <View style={styles.confidenceRow}>
          <Text style={[styles.detailLabel, {color: tokens.inkMuted}]}>
            CONFIDENCE:
          </Text>
          <Text
            style={[
              styles.confidenceText,
              {
                color:
                  item.verdict.confidence === 'High'
                    ? tokens.verdictTrueInk
                    : item.verdict.confidence === 'Medium'
                    ? tokens.verdictMisleadingInk
                    : tokens.inkMuted,
              },
            ]}>
            {item.verdict.confidence}
          </Text>
        </View>

        <Text style={[styles.explanationText, {color: tokens.inkMuted}]}>
          {item.verdict.explanation}
        </Text>

        {item.verdict.key_sources.length > 0 && (
          <View style={styles.sourcesContainer}>
            <Text style={[styles.detailLabel, {color: tokens.inkMuted}]}>
              SOURCES:
            </Text>
            {item.verdict.key_sources.map((url, i) => (
              <TouchableOpacity
                key={i}
                onPress={() => Linking.openURL(url).catch(() => {})}>
                <Text
                  style={[styles.sourceLink, {color: tokens.focus}]}
                  numberOfLines={1}>
                  {url}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function getVerdictColors(verdict: string, tokens: ColorTokens) {
  switch (verdict) {
    case 'True':
      return {bg: tokens.verdictTrueAccent + '22', fg: tokens.verdictTrueInk};
    case 'False':
      return {bg: tokens.verdictFalseAccent + '22', fg: tokens.verdictFalseInk};
    case 'Misleading':
      return {bg: tokens.verdictMisleadingAccent + '22', fg: tokens.verdictMisleadingInk};
    default:
      return {bg: tokens.verdictUnverifiedAccent + '22', fg: tokens.verdictUnverifiedInk};
  }
}

// Styles

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'android' ? 36 : 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logoInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  logoImage: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  tagline: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: 2,
  },

  // Theme Toggle
  themeToggleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
  },
  themeLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  themeSwitch: {
    width: 28,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
  },
  themeSlider: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },

  // Language Segmented Control
  segmentedControl: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    padding: 2,
  },
  segmentBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  segmentText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  content: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 11,
    textAlign: 'center',
  },

  // Launch Panel
  launchScroll: {
    flex: 1,
  },
  widgetHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  widgetStatusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  widgetStatusText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  widgetButton: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  widgetButtonText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  autoStartTip: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  autoStartTipText: {
    fontSize: 11,
    lineHeight: 16,
  },
  autoStartActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  autoStartLinkBtn: {
    paddingVertical: 2,
  },
  autoStartLink: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textDecorationLine: 'underline',
  },
  autoStartDismiss: {
    fontSize: 13,
    paddingHorizontal: 4,
  },
  launchContainer: {
    padding: 16,
    gap: 12,
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
  },
  statusTextContainer: {
    flex: 1,
  },
  connectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  connectionDetail: {
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  modeCard: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  modeCardLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  modeCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginTop: 6,
  },
  modeCardDescription: {
    fontSize: 13,
    marginTop: 6,
    lineHeight: 18,
  },
  btnPrimary: {
    width: '100%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimaryText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },

  // Results
  resultsScroll: {
    flex: 1,
  },
  resultsContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  cardSectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 6,
  },
  cardSubtext: {
    fontSize: 13,
    lineHeight: 18,
  },
  transcriptText: {
    fontSize: 13,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  claimHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  claimIndex: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  verdictBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  verdictBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  claimText: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  verdictDetails: {
    borderTopWidth: 1,
    paddingTop: 10,
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  detailLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginRight: 6,
  },
  confidenceText: {
    fontSize: 12,
    fontWeight: '700',
  },
  explanationText: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  sourcesContainer: {
    marginTop: 4,
  },
  sourceLink: {
    fontSize: 12,
    marginTop: 4,
    textDecorationLine: 'underline',
  },
});

export default App;
