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
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {useListenSession, type SessionPhase} from './src/useListenSession';
import type {ClaimResult} from './src/verifyContent';
import {
  checkOverlayPermission,
  expandWidget,
  openVendorAutoStartSettings,
  requestOverlayPermission,
  startFloatingWidget,
  stopFloatingWidget,
  subscribeFloatingWidgetTap,
} from './src/audioCapture';
import {t, type LangCode, LANG_LABELS, SUPPORTED_LANGS} from './src/i18n';

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

const AppStatusBar = React.memo(function StatusBarView({
  theme,
  backgroundColor,
}: {
  theme: ThemeMode;
  backgroundColor: string;
}) {
  return (
    <StatusBar
      barStyle={theme === 'dark' ? 'light-content' : 'dark-content'}
      backgroundColor={backgroundColor}
    />
  );
});

function App(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [lang, setLang] = useState<LangCode>('id');
  const tokens = theme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;

  const {state, startAutoSession, cancelSession, resetSession, checkHeadphones} =
    useListenSession();

  const [floatingWidgetEnabled, setFloatingWidgetEnabled] = useState(false);
  const [showAutoStartTip, setShowAutoStartTip] = useState(true);
  // Latest language captured for the widget-tap subscription without
  // re-subscribing on every language toggle.
  const langRef = useRef(lang);
  langRef.current = lang;
  // Read inside the bubble-tap subscription, which is registered once.
  const autoRef = useRef(state.auto);
  autoRef.current = state.auto;
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
            // The widget exists to check what is playing, so turning it on is
            // the start signal — no separate tap to begin listening.
            startAutoSession(langRef.current);
          }
        }
      }
    });

    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [checkHeadphones, startAutoSession]);

  // Bubble tap → start auto-listening, or just open the card if it is already
  // running. Stopping is deliberately not on the bubble: it is one tap away
  // from the card and would be far too easy to hit by accident.
  useEffect(() => {
    const sub = subscribeFloatingWidgetTap(() => {
      if (autoRef.current) {
        expandWidget();
      } else {
        startAutoSession(langRef.current);
      }
    });
    return () => {
      sub?.remove();
    };
  }, [startAutoSession]);

  const handleEnableWidget = async () => {
    const granted = await checkOverlayPermission();
    if (granted) {
      startFloatingWidget();
      setFloatingWidgetEnabled(true);
      startAutoSession(langRef.current);
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
      <AppStatusBar theme={theme} backgroundColor={tokens.surface} />

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
                {t('tagline', lang)}
              </Text>
            </View>
          </View>

          <View style={styles.headerControls}>
            {/* Language Selector - Compact */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={[
                styles.langSelector,
                {
                  backgroundColor: tokens.surfaceRaised,
                  borderColor: tokens.borderHairline,
                },
              ]}
              contentContainerStyle={styles.langSelectorContent}>
              {SUPPORTED_LANGS.map((l) => (
                <TouchableOpacity
                  key={l}
                  activeOpacity={0.7}
                  onPress={() => setLang(l)}
                  style={[
                    styles.langBtn,
                    lang === l && {
                      backgroundColor: tokens.focus,
                      borderColor: tokens.focus,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.langBtnText,
                      {color: lang === l ? '#FFFFFF' : tokens.inkMuted},
                    ]}>
                    {LANG_LABELS[l]}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

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
                {t('dark', lang)}
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
                      transform: [{translateX: theme === 'light' ? 10 : 2}],
                    },
                  ]}
                />
              </View>
              <Text
                style={[
                  styles.themeLabel,
                  {color: theme === 'light' ? tokens.ink : tokens.inkMuted},
                ]}>
                {t('light', lang)}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Main Content */}
      <View style={styles.content}>
        {state.result && state.result.claims.length > 0 ? (
          // Verdicts stay on screen while auto-listen keeps running, so the
          // feed grows instead of being replaced every window.
          <ResultsView
            result={state.result}
            tokens={tokens}
            lang={lang}
            auto={state.auto}
            statusText={state.statusText}
            windowsProcessed={state.windowsProcessed}
            error={state.error}
            onStop={cancelSession}
            onReset={resetSession}
          />
        ) : (
          <LaunchView
            phase={state.phase}
            auto={state.auto}
            windowsProcessed={state.windowsProcessed}
            statusText={state.statusText}
            amplitude={state.amplitude}
            headphonesConnected={state.headphonesConnected}
            error={state.error}
            tokens={tokens}
            lang={lang}
            onListen={() => startAutoSession(lang)}
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
          {t('open_article_or_video', lang)}
        </Text>
      </View>
    </SafeAreaView>
  );
}

// Launch Panel View

interface LaunchViewProps {
  phase: SessionPhase;
  /** Auto-listen is running: the mic stays open and windows keep arriving. */
  auto: boolean;
  /** Audio windows checked so far — the only proof of life when nothing is claimed. */
  windowsProcessed: number;
  statusText: string;
  amplitude: number;
  headphonesConnected: boolean;
  error: string | null;
  tokens: ColorTokens;
  lang: LangCode;
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
  auto,
  windowsProcessed,
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
  const isActive = phase === 'recording';
  const isProcessing = phase === 'transcribing' || phase === 'verifying';

  let dotColor = tokens.verdictTrueAccent;
  let statusTitle = t('proxy_connected', lang);
  let statusDetail = t('proxy_connected_detail', lang);

  if (headphonesConnected && phase === 'idle') {
    dotColor = tokens.verdictMisleadingAccent;
    statusTitle = t('headphones_detected', lang);
    statusDetail = t('headphones_detected_detail', lang);
  } else if (error) {
    dotColor = tokens.verdictFalseAccent;
    statusTitle = t('service_error', lang);
    statusDetail = error;
  } else if (auto) {
    dotColor = tokens.verdictFalseAccent;
    statusTitle = t('auto_checking', lang);
    // Most short clips contain no verifiable claim, so without this counter a
    // working session and a dead one look identical.
    statusDetail =
      (statusText || t('listening_continuously', lang)) +
      (windowsProcessed > 0
        ? ` · ${t('clips_checked', lang, {count: windowsProcessed})}`
        : '');
  } else if (isActive) {
    dotColor = tokens.verdictFalseAccent;
    statusTitle = t('listening_to_audio', lang);
    statusDetail = statusText || t('capturing_mic', lang);
  } else if (isProcessing) {
    dotColor = tokens.verdictMisleadingAccent;
    statusTitle = t('verifying_content', lang);
    statusDetail = statusText || t('analyzing_claims', lang);
  }

  let buttonText = t('start_auto_fact_check', lang);
  if (auto) {
    // Stop must stay reachable no matter which stage of the cycle is running.
    buttonText = t('stop_auto_check', lang);
  } else if (isActive) {
    buttonText = t('stop_listening', lang);
  } else if (isProcessing) {
    buttonText = t('checking_content', lang);
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
          {t('current_mode', lang)}
        </Text>
        <Text style={[styles.modeCardTitle, {color: tokens.ink}]}>
          {auto
            ? t('auto_fact_checker', lang)
            : isActive
            ? t('listening_to_playback', lang)
            : isProcessing
            ? t('analyzing_claims_mode', lang)
            : t('audio_fact_checker', lang)}
        </Text>
        <Text style={[styles.modeCardDescription, {color: tokens.inkMuted}]}>
          {t('auto_fact_checker_desc', lang)}
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
            {t('floating_widget', lang)}
          </Text>
          {floatingWidgetEnabled && (
            <View
              style={[
                styles.widgetStatusChip,
                {backgroundColor: tokens.verdictTrueAccent + '22'},
              ]}>
              <Text
                style={[styles.widgetStatusText, {color: tokens.verdictTrueInk}]}>
                {t('widget_active', lang)}
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.modeCardDescription, {color: tokens.inkMuted}]}>
          {t('floating_widget_desc', lang)}
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
              ? t('hide_widget', lang)
              : t('enable_floating_widget', lang)}
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
              {t('auto_start_tip', lang)}
            </Text>
            <View style={styles.autoStartActions}>
              <TouchableOpacity
                onPress={onOpenAutoStartSettings}
                activeOpacity={0.7}
                style={styles.autoStartLinkBtn}>
                <Text style={[styles.autoStartLink, {color: tokens.focus}]}>
                  {t('open_settings', lang)}
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
            {t('try_again_btn', lang)}
          </Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[
            styles.btnPrimary,
            {
              backgroundColor: isActive || auto ? tokens.verdictFalseAccent : tokens.ink,
              borderColor: isActive || auto ? tokens.verdictFalseAccent : tokens.ink,
              opacity: headphonesConnected && phase === 'idle' ? 0.45 : 1,
            },
          ]}
          disabled={headphonesConnected && phase === 'idle'}
          onPress={auto || isActive ? onCancel : isProcessing ? undefined : onListen}
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
  lang: LangCode;
  auto: boolean;
  statusText: string;
  windowsProcessed: number;
  error: string | null;
  onStop: () => void;
  onReset: () => void;
}

function ResultsView({
  result,
  tokens,
  lang,
  auto,
  statusText,
  windowsProcessed,
  error,
  onStop,
  onReset,
}: ResultsViewProps) {
  const {claims, rawTranscript} = result;

  return (
    <ScrollView
      style={styles.resultsScroll}
      contentContainerStyle={styles.resultsContent}
      showsVerticalScrollIndicator={false}>
      {/* Live banner: results keep arriving while this is shown. */}
      {auto && (
        <View
          style={[
            styles.connectionStatus,
            {
              backgroundColor: tokens.surfaceRaised,
              borderColor: tokens.borderHairline,
            },
          ]}>
          <View
            style={[styles.statusDot, {backgroundColor: tokens.verdictFalseAccent}]}
          />
          <View style={styles.statusTextContainer}>
            <Text style={[styles.connectionTitle, {color: tokens.ink}]}>
              {t('still_listening', lang)}
            </Text>
            <Text style={[styles.connectionDetail, {color: tokens.inkMuted}]}>
              {(statusText || t('new_claims_added', lang)) +
                (windowsProcessed > 0
                  ? ` · ${t('clips_checked', lang, {count: windowsProcessed})}`
                  : '')}
            </Text>
          </View>
        </View>
      )}

      {/* A failure that stopped the run must not be hidden by earlier results. */}
      {!auto && error && (
        <View
          style={[
            styles.card,
            {backgroundColor: tokens.surface, borderColor: tokens.verdictFalseAccent},
          ]}>
          <Text style={[styles.cardSectionLabel, {color: tokens.verdictFalseInk}]}>
            {t('auto_check_stopped', lang)}
          </Text>
          <Text style={[styles.cardSubtext, {color: tokens.inkMuted}]}>{error}</Text>
        </View>
      )}

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
          {t('transcript', lang)}
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
            {t('no_verifiable_claims', lang)}
          </Text>
          <Text style={[styles.cardSubtext, {color: tokens.inkMuted}]}>
            {t('no_verifiable_claims_detail', lang)}
          </Text>
        </View>
      ) : (
        claims.map((item, index) => (
          <ClaimCard key={index} item={item} index={index} tokens={tokens} lang={lang} />
        ))
      )}

      {/* Stop while auto-listening, reset once it has stopped. */}
      <TouchableOpacity
        style={[
          styles.btnPrimary,
          {
            backgroundColor: auto ? tokens.verdictFalseAccent : tokens.ink,
            borderColor: auto ? tokens.verdictFalseAccent : tokens.ink,
            marginTop: 12,
          },
        ]}
        onPress={auto ? onStop : onReset}
        activeOpacity={0.8}>
        <Text style={[styles.btnPrimaryText, {color: tokens.surface}]}>
          {auto
            ? t('stop_auto_check_btn', lang)
            : t('start_new_check', lang)}
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
  lang,
}: {
  item: ClaimResult;
  index: number;
  tokens: ColorTokens;
  lang: LangCode;
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
          {t('claim', lang)} {index + 1}
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
            {t('confidence', lang)}
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
              {t('sources_label', lang)}
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
    flexWrap: 'wrap',
    gap: 10,
  },
  headerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  themeLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  themeSwitch: {
    width: 24,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: 'center',
  },
  themeSlider: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  // Language Selector - Compact
  langSelector: {
    borderRadius: 8,
    borderWidth: 1,
    maxHeight: 28,
  },
  langSelectorContent: {
    paddingHorizontal: 3,
    paddingVertical: 3,
    gap: 2,
    alignItems: 'center',
  },
  langBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  langBtnText: {
    fontSize: 9,
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
