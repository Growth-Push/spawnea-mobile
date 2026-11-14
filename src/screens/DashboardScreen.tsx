import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import {
  defaultApiClient,
  formatApiErrorMessage,
  SpawneaApiClient,
} from '../api/client';
import type { SessionSummary } from '../api/types';
import { isDebugLoopbackAllowed } from '../config/runtime';
import { validateServerUrl } from '../config/validation';
import {
  computeStatusSummary,
  DashboardErrorKind,
  DashboardSnapshot,
  DashboardViewState,
  formatAgeDuration,
  formatLastUpdatedTimestamp,
  mapApiFailureToDashboardError,
  partitionDashboardSessions,
} from '../dashboard/dashboardModel';
import { getCredentialState } from '../storage/keyStorage';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
  TerminalAuthLock,
} from '../storage/sessionCredentialCache';

export const DEFAULT_DASHBOARD_POLL_INTERVAL_MS = 10000;
const SNAPSHOT_AGE_TICK_MS = 1000;

export interface DashboardScreenProps {
  onOpenSettings: () => void;
  onOpenSessions?: () => void;
  onOpenSessionChat?: (sessionId: string) => void;
  apiClient?: SpawneaApiClient;
  credentialCache?: SessionCredentialCache;
  allowDebugLoopback?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
}

type SyncTrigger = 'focus' | 'foreground' | 'manual' | 'poll';

function connectionBadgeLabel(viewState: DashboardViewState): string {
  switch (viewState.status) {
    case 'live':
    case 'empty':
      return 'Live';
    case 'stale':
      switch (viewState.errorKind) {
        case 'auth_rejected':
          return 'Stale · Auth rejected';
        case 'rate_limited':
          return 'Stale · Rate limited';
        case 'offline':
          return 'Stale · Offline';
        case 'server_error':
          return 'Stale · Server error';
        case 'locked':
          return 'Stale · Locked';
        default:
          return 'Stale';
      }
    case 'loading':
      return 'Loading';
    case 'locked':
      return 'Locked';
    case 'not_configured':
      return viewState.reason === 'incomplete_config'
        ? 'Incomplete configuration'
        : 'Not configured';
    case 'error':
      switch (viewState.error.kind) {
        case 'auth_rejected':
          return 'Auth rejected (HTTP 401)';
        case 'rate_limited':
          return 'Rate limited (HTTP 429)';
        case 'offline':
          return 'Offline / unreachable';
        case 'server_error':
          return 'Server error';
        case 'not_configured':
          return 'Not configured';
      }
  }
}

function errorHeadingForKind(kind: DashboardErrorKind): string {
  switch (kind) {
    case 'auth_rejected':
      return 'Authentication rejected';
    case 'rate_limited':
      return 'Rate limited by server';
    case 'offline':
      return 'Server offline or unreachable';
    case 'server_error':
      return 'Server error';
    case 'not_configured':
      return 'Not configured';
  }
}

function statusPillStyle(status: string) {
  switch (status) {
    case 'needs_input':
      return styles.pillNeedsInput;
    case 'working':
    case 'starting':
      return styles.pillWorking;
    case 'error':
      return styles.pillError;
    case 'disconnected':
      return styles.pillDisconnected;
    default:
      return styles.pillNeutral;
  }
}

export function DashboardScreen({
  onOpenSettings,
  onOpenSessions,
  onOpenSessionChat,
  apiClient = defaultApiClient,
  credentialCache = defaultSessionCredentialCache,
  allowDebugLoopback,
  pollIntervalMs = DEFAULT_DASHBOARD_POLL_INTERVAL_MS,
  now = Date.now,
}: DashboardScreenProps): React.JSX.Element {
  const effectiveAllowDebugLoopback =
    allowDebugLoopback ?? isDebugLoopbackAllowed();
  const navigation = useContext(NavigationContext);

  const [viewState, setViewState] = useState<DashboardViewState>({
    status: 'loading',
    message: 'Checking saved configuration...',
  });
  const [configuredOrigin, setConfiguredOrigin] = useState<string | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [clockMs, setClockMs] = useState(() => now());

  const mountedRef = useRef(true);
  const isFocusedRef = useRef(navigation ? navigation.isFocused() : true);
  const appActiveRef = useRef(
    AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive',
  );
  const snapshotRef = useRef<DashboardSnapshot | null>(null);
  const lastGenerationRef = useRef<number>(apiClient.getCredentialGeneration());
  const autoUnlockDeclinedRef = useRef(false);
  const requestSeqRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCooldownTriggerRef = useRef<SyncTrigger | null>(null);
  const runSyncRef = useRef<(trigger: SyncTrigger) => Promise<void>>(
    async () => undefined,
  );

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const applyTerminalAuthLock = useCallback(
    (lock: TerminalAuthLock, bumpSeq: boolean) => {
      if (bumpSeq) {
        requestSeqRef.current += 1;
      }
      clearPollTimer();
      pendingCooldownTriggerRef.current = null;
      setIsManualRefreshing(false);
      setIsBackgroundRefreshing(false);
      autoUnlockDeclinedRef.current = true;

      if (
        lock.reason === 'not_configured' ||
        lock.reason === 'incomplete_config' ||
        lock.reason === 'invalid_url'
      ) {
        snapshotRef.current = null;
        setConfiguredOrigin(null);
        setViewState({
          status: 'not_configured',
          reason: lock.reason,
          message: lock.message,
        });
        return;
      }

      snapshotRef.current = null;
      setViewState({
        status: 'locked',
        reason: lock.reason,
        message: lock.message,
      });
    },
    [clearPollTimer],
  );

  const schedulePoll = useCallback(
    (delayMs: number, trigger: SyncTrigger = 'poll') => {
      clearPollTimer();
      if (!mountedRef.current || !isFocusedRef.current || !appActiveRef.current) {
        pendingCooldownTriggerRef.current = null;
        return;
      }
      pendingCooldownTriggerRef.current = trigger === 'poll' ? null : trigger;
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        const nextTrigger = pendingCooldownTriggerRef.current ?? 'poll';
        pendingCooldownTriggerRef.current = null;
        runSyncRef.current(nextTrigger).catch(() => undefined);
      }, Math.max(0, delayMs));
    },
    [clearPollTimer],
  );

  const runSync = useCallback(
    async (trigger: SyncTrigger) => {
      clearPollTimer();
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      const generationAtStart = apiClient.getCredentialGeneration();

      const isSupersededOrHidden = () =>
        !mountedRef.current ||
        requestSeqRef.current !== seq ||
        apiClient.getCredentialGeneration() !== generationAtStart ||
        !appActiveRef.current ||
        !isFocusedRef.current;

      if (!appActiveRef.current || !isFocusedRef.current) {
        return;
      }

      if (trigger === 'manual') {
        autoUnlockDeclinedRef.current = false;
      }

      let credState;
      try {
        credState = await getCredentialState();
      } catch {
        credState = {
          serverUrl: null,
          hasKey: false,
          incomplete: true,
        };
      }
      if (isSupersededOrHidden()) {
        return;
      }

      if (credState.incomplete) {
        const message =
          'Stored configuration is incomplete. Re-link your server URL and API key in Settings.';
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        setConfiguredOrigin(null);
        credentialCache.invalidateForTerminalAuth('incomplete_config', message);
        setViewState({
          status: 'not_configured',
          reason: 'incomplete_config',
          message,
        });
        return;
      }

      if (!credState.hasKey || credState.serverUrl === null) {
        const message =
          'Server URL and API key are not configured. Configure them in Settings to load live sessions.';
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        setConfiguredOrigin(null);
        credentialCache.invalidateForTerminalAuth('not_configured', message);
        setViewState({
          status: 'not_configured',
          reason: 'not_configured',
          message,
        });
        return;
      }

      const urlCheck = validateServerUrl(
        credState.serverUrl,
        effectiveAllowDebugLoopback,
      );
      if (!urlCheck.valid) {
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        setConfiguredOrigin(null);
        credentialCache.invalidateForTerminalAuth('invalid_url', urlCheck.message);
        setViewState({
          status: 'not_configured',
          reason: 'invalid_url',
          message: urlCheck.message,
        });
        return;
      }

      const normalizedUrl = urlCheck.normalizedUrl;
      setConfiguredOrigin(normalizedUrl);

      if (generationAtStart !== lastGenerationRef.current) {
        lastGenerationRef.current = generationAtStart;
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        pendingCooldownTriggerRef.current = null;
      } else if (
        snapshotRef.current !== null &&
        snapshotRef.current.serverUrl !== normalizedUrl
      ) {
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        pendingCooldownTriggerRef.current = null;
      }

      const terminalLock = credentialCache.getTerminalAuthLock();
      if (terminalLock !== null && trigger !== 'manual') {
        applyTerminalAuthLock(terminalLock, false);
        return;
      }

      let credentials = credentialCache.getCachedCredentials(
        apiClient,
        normalizedUrl,
      );
      if (!credentials) {
        snapshotRef.current = null;
      }

      if (trigger !== 'manual' && apiClient.isPollingPausedForAuth()) {
        pendingCooldownTriggerRef.current = null;
        const message = formatApiErrorMessage('polling_paused_auth', 401, null);
        const currentNowMs = now();
        setClockMs(currentNowMs);
        if (credentials && snapshotRef.current !== null) {
          setViewState({
            status: 'stale',
            snapshot: snapshotRef.current,
            staleReason: message,
            errorKind: 'auth_rejected',
            retryAfterSeconds: null,
          });
        } else {
          snapshotRef.current = null;
          setViewState({
            status: 'error',
            error: {
              kind: 'auth_rejected',
              category: 'polling_paused_auth',
              status: 401,
              retryAfterSeconds: null,
              message,
            },
          });
        }
        return;
      }

      const cooldownSeconds =
        apiClient.getRateLimitRemainingSeconds(normalizedUrl);
      if (cooldownSeconds > 0) {
        const message = formatApiErrorMessage(
          'rate_limited',
          429,
          cooldownSeconds,
        );
        const currentNowMs = now();
        setClockMs(currentNowMs);
        if (credentials && snapshotRef.current !== null) {
          setViewState({
            status: 'stale',
            snapshot: snapshotRef.current,
            staleReason: message,
            errorKind: 'rate_limited',
            retryAfterSeconds: cooldownSeconds,
          });
        } else {
          snapshotRef.current = null;
          setViewState({
            status: 'error',
            error: {
              kind: 'rate_limited',
              category: 'rate_limited',
              status: 429,
              retryAfterSeconds: cooldownSeconds,
              message,
            },
          });
        }
        const resumeTrigger: SyncTrigger =
          trigger === 'manual'
            ? 'manual'
            : trigger === 'poll'
              ? (pendingCooldownTriggerRef.current ?? 'poll')
              : pendingCooldownTriggerRef.current === 'manual'
                ? 'manual'
                : trigger;
        schedulePoll(cooldownSeconds * 1000, resumeTrigger);
        return;
      }

      pendingCooldownTriggerRef.current = null;

      if (!credentials) {
        snapshotRef.current = null;
        if (trigger === 'poll' || autoUnlockDeclinedRef.current) {
          const message =
            'Fingerprint unlock is required to access your saved API key.';
          setViewState({
            status: 'locked',
            reason: 'unlock_required',
            message,
          });
          return;
        }

        if (trigger === 'manual') {
          setIsManualRefreshing(true);
        } else if (snapshotRef.current === null) {
          setViewState({
            status: 'loading',
            message: 'Unlocking protected API key...',
          });
        }

        try {
          const unlockResult = await credentialCache.unlockAndGetCredentials({
            apiClient,
            allowDebugLoopback: effectiveAllowDebugLoopback,
            promptSubtitle:
              'Unlock your saved API key to load live Spawnea sessions',
          });
          if (isSupersededOrHidden()) {
            return;
          }

          if (!unlockResult.ok) {
            snapshotRef.current = null;
            if (
              unlockResult.reason === 'not_configured' ||
              unlockResult.reason === 'incomplete_config' ||
              unlockResult.reason === 'invalid_url'
            ) {
              setViewState({
                status: 'not_configured',
                reason: unlockResult.reason,
                message: unlockResult.message,
              });
              return;
            }

            autoUnlockDeclinedRef.current =
              unlockResult.reason !== 'credential_changed';
            setViewState({
              status: 'locked',
              reason: unlockResult.reason,
              message: unlockResult.message,
            });
            return;
          }

          credentials = unlockResult.credentials;
          autoUnlockDeclinedRef.current = false;
        } finally {
          if (mountedRef.current && requestSeqRef.current === seq) {
            setIsManualRefreshing(false);
          }
        }
      }

      if (trigger === 'manual') {
        setIsManualRefreshing(true);
      } else if (trigger === 'poll' || snapshotRef.current !== null) {
        setIsBackgroundRefreshing(true);
      } else {
        setViewState({
          status: 'loading',
          message: 'Loading live sessions...',
        });
      }

      try {
        const result = await apiClient.listSessions(credentials, {
          isPolling: trigger === 'poll',
        });
        if (isSupersededOrHidden()) {
          return;
        }

        const currentNowMs = now();
        setClockMs(currentNowMs);

        if (result.ok) {
          const nextSnapshot: DashboardSnapshot = {
            sessions: result.data.sessions,
            lastUpdatedAtMs: currentNowMs,
            serverUrl: normalizedUrl,
            credentialGeneration: generationAtStart,
          };
          const hasValidCreds =
            credentialCache.getCachedCredentials(apiClient, normalizedUrl) !==
            null;
          if (!hasValidCreds) {
            snapshotRef.current = null;
            setViewState({
              status: 'locked',
              reason: 'unlock_required',
              message:
                'Fingerprint unlock is required to access your saved API key.',
            });
            return;
          }
          snapshotRef.current = nextSnapshot;
          setViewState(
            nextSnapshot.sessions.length === 0
              ? { status: 'empty', snapshot: nextSnapshot }
              : { status: 'live', snapshot: nextSnapshot },
          );
          schedulePoll(pollIntervalMs);
          return;
        }

        const mappedError = mapApiFailureToDashboardError(result);
        if (mappedError.kind === 'not_configured') {
          snapshotRef.current = null;
          setViewState({
            status: 'not_configured',
            reason: 'not_configured',
            message: mappedError.message,
          });
          return;
        }

        const hasValidCreds =
          credentialCache.getCachedCredentials(apiClient, normalizedUrl) !==
          null;
        if (!hasValidCreds) {
          snapshotRef.current = null;
        }
        if (hasValidCreds && snapshotRef.current !== null) {
          setViewState({
            status: 'stale',
            snapshot: snapshotRef.current,
            staleReason: mappedError.message,
            errorKind: mappedError.kind,
            retryAfterSeconds: mappedError.retryAfterSeconds,
          });
        } else {
          setViewState({
            status: 'error',
            error: mappedError,
          });
        }

        if (mappedError.kind === 'auth_rejected') {
          return;
        }

        if (
          mappedError.kind === 'rate_limited' &&
          mappedError.retryAfterSeconds !== null &&
          mappedError.retryAfterSeconds > 0
        ) {
          schedulePoll(
            Math.max(pollIntervalMs, mappedError.retryAfterSeconds * 1000),
          );
          return;
        }

        schedulePoll(pollIntervalMs);
      } finally {
        if (mountedRef.current && requestSeqRef.current === seq) {
          setIsManualRefreshing(false);
          setIsBackgroundRefreshing(false);
        }
      }
    },
    [
      apiClient,
      applyTerminalAuthLock,
      clearPollTimer,
      credentialCache,
      effectiveAllowDebugLoopback,
      now,
      pollIntervalMs,
      schedulePoll,
    ],
  );

  runSyncRef.current = runSync;

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeTerminalAuth = credentialCache.onTerminalInvalidated(
      lock => {
        if (mountedRef.current) {
          applyTerminalAuthLock(lock, true);
        }
      },
    );
    const unsubscribeTerminalCleared = credentialCache.onTerminalLockCleared(
      () => {
        if (mountedRef.current) {
          autoUnlockDeclinedRef.current = false;
        }
      },
    );
    const unsubscribeCacheCleared = credentialCache.onCleared(() => {
      if (!mountedRef.current) {
        return;
      }
      snapshotRef.current = null;
      if (credentialCache.getTerminalAuthLock() !== null) {
        return;
      }
      setViewState(prev =>
        prev.status === 'live' ||
        prev.status === 'empty' ||
        prev.status === 'stale'
          ? {
              status: 'locked',
              reason: 'unlock_required',
              message:
                'Fingerprint unlock is required to access your saved API key.',
            }
          : prev,
      );
    });

    if (isFocusedRef.current && appActiveRef.current) {
      runSync('focus').catch(() => undefined);
    }

    const unsubscribeFocus = navigation?.addListener('focus', () => {
      isFocusedRef.current = true;
      setIsManualRefreshing(false);
      setIsBackgroundRefreshing(false);
      if (appActiveRef.current) {
        if (snapshotRef.current !== null) {
          setClockMs(now());
        }
        runSync('focus').catch(() => undefined);
      }
    });

    const unsubscribeBlur = navigation?.addListener('blur', () => {
      isFocusedRef.current = false;
      requestSeqRef.current += 1;
      clearPollTimer();
      pendingCooldownTriggerRef.current = null;
      setIsManualRefreshing(false);
      setIsBackgroundRefreshing(false);
    });

    const appStateSub = AppState.addEventListener('change', nextState => {
      const nextActive =
        nextState !== 'background' && nextState !== 'inactive';
      const wasActive = appActiveRef.current;
      appActiveRef.current = nextActive;

      if (!nextActive) {
        requestSeqRef.current += 1;
        clearPollTimer();
        pendingCooldownTriggerRef.current = null;
        setIsManualRefreshing(false);
        setIsBackgroundRefreshing(false);
        credentialCache.clear();
        autoUnlockDeclinedRef.current = false;
        snapshotRef.current = null;
        setViewState(prev =>
          prev.status === 'not_configured'
            ? prev
            : {
                status: 'locked',
                reason: 'backgrounded',
                message:
                  'Unlock with your fingerprint to load live sessions.',
              },
        );
        return;
      }

      if (!wasActive && nextActive && isFocusedRef.current) {
        autoUnlockDeclinedRef.current = false;
        if (snapshotRef.current !== null) {
          setClockMs(now());
        }
        runSync('foreground').catch(() => undefined);
      }
    });

    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      clearPollTimer();
      pendingCooldownTriggerRef.current = null;
      unsubscribeTerminalAuth();
      unsubscribeTerminalCleared();
      unsubscribeCacheCleared();
      unsubscribeFocus?.();
      unsubscribeBlur?.();
      appStateSub?.remove?.();
    };
  }, [
    applyTerminalAuthLock,
    clearPollTimer,
    credentialCache,
    navigation,
    now,
    runSync,
  ]);

  const activeSnapshot =
    (viewState.status === 'live' ||
      viewState.status === 'empty' ||
      viewState.status === 'stale') &&
    credentialCache.getCachedCredentials(
      apiClient,
      viewState.snapshot.serverUrl,
    ) !== null
      ? viewState.snapshot
      : null;

  const hasActiveSnapshot = activeSnapshot !== null;

  useEffect(() => {
    if (!hasActiveSnapshot) {
      return;
    }
    const timer = setInterval(() => {
      if (mountedRef.current && isFocusedRef.current && appActiveRef.current) {
        setClockMs(now());
      }
    }, SNAPSHOT_AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [hasActiveSnapshot, now]);

  const handleManualRefresh = useCallback(() => {
    runSync('manual').catch(() => undefined);
  }, [runSync]);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      onOpenSessionChat?.(sessionId);
    },
    [onOpenSessionChat],
  );

  const summary = useMemo(
    () =>
      activeSnapshot ? computeStatusSummary(activeSnapshot.sessions) : null,
    [activeSnapshot],
  );

  const { needsInput, otherSessions } = useMemo(
    () =>
      activeSnapshot
        ? partitionDashboardSessions(activeSnapshot.sessions)
        : { needsInput: [], otherSessions: [] },
    [activeSnapshot],
  );

  const lastUpdatedLabel = activeSnapshot
    ? `${formatLastUpdatedTimestamp(
        activeSnapshot.lastUpdatedAtMs,
      )} (${formatAgeDuration(clockMs - activeSnapshot.lastUpdatedAtMs)} ago)`
    : 'Not synced yet';

  const staleAgeLabel = activeSnapshot
    ? formatAgeDuration(clockMs - activeSnapshot.lastUpdatedAtMs)
    : '0s';

  const isStale = viewState.status === 'stale';
  const showRefreshButton =
    viewState.status !== 'not_configured' &&
    !(
      viewState.status === 'locked' &&
      viewState.reason === 'auth_invalidated'
    );

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      testID="dashboard-screen"
      refreshControl={
        <RefreshControl
          refreshing={isManualRefreshing}
          onRefresh={handleManualRefresh}
        />
      }>
      <View style={styles.statusCard} testID="dashboard-status-card">
        <View style={styles.statusHeaderRow}>
          <View
            style={[
              styles.connectionPill,
              viewState.status === 'live' || viewState.status === 'empty'
                ? styles.connectionLive
                : viewState.status === 'stale'
                ? styles.connectionStale
                : viewState.status === 'error'
                ? styles.connectionError
                : styles.connectionNeutral,
            ]}>
            <Text
              style={styles.connectionPillText}
              testID="dashboard-connection-status">
              {connectionBadgeLabel(viewState)}
            </Text>
          </View>
          {isBackgroundRefreshing && !isManualRefreshing ? (
            <Text style={styles.subtleText}>Updating...</Text>
          ) : null}
        </View>

        {configuredOrigin ? (
          <Text style={styles.serverText} testID="dashboard-server-url">
            Server: {configuredOrigin}
          </Text>
        ) : null}

        <Text style={styles.updatedText} testID="dashboard-last-updated">
          Last successful update: {lastUpdatedLabel}
        </Text>

        <View style={styles.actionsRow}>
          {showRefreshButton ? (
            <Pressable
              testID="dashboard-refresh-button"
              accessibilityRole="button"
              style={[
                styles.secondaryButton,
                isManualRefreshing && styles.buttonDisabled,
              ]}
              disabled={isManualRefreshing}
              onPress={handleManualRefresh}>
              <Text style={styles.secondaryButtonText}>
                {viewState.status === 'locked' ||
                (viewState.status === 'stale' &&
                  viewState.errorKind === 'locked')
                  ? 'Unlock & Refresh'
                  : isManualRefreshing
                  ? 'Refreshing...'
                  : 'Refresh'}
              </Text>
            </Pressable>
          ) : null}

          {onOpenSessions ? (
            <Pressable
              testID="dashboard-open-sessions-button"
              accessibilityRole="button"
              style={styles.secondaryButton}
              onPress={onOpenSessions}>
              <Text style={styles.secondaryButtonText}>Sessions</Text>
            </Pressable>
          ) : null}

          <Pressable
            testID="dashboard-open-settings-button"
            accessibilityRole="button"
            style={styles.secondaryButton}
            onPress={onOpenSettings}>
            <Text style={styles.secondaryButtonText}>Settings</Text>
          </Pressable>
        </View>
      </View>

      {isStale ? (
        <View style={styles.staleBanner} testID="dashboard-stale-banner">
          <Text style={styles.staleBannerHeading} testID="dashboard-stale-age">
            Stale data · Age: {staleAgeLabel}
          </Text>
          <Text style={styles.staleBannerBody} testID="dashboard-stale-reason">
            Showing last successful snapshot while live refresh is unavailable:{' '}
            {viewState.staleReason}
          </Text>
          {viewState.errorKind === 'auth_rejected' ? (
            <Pressable
              testID="dashboard-stale-settings-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={onOpenSettings}>
              <Text style={styles.primaryButtonText}>Open Settings</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {viewState.status === 'not_configured' ? (
        <View style={styles.card} testID="dashboard-not-configured-card">
          <Text style={styles.cardHeading}>
            {viewState.reason === 'incomplete_config'
              ? 'Incomplete configuration'
              : viewState.reason === 'invalid_url'
              ? 'Invalid server URL'
              : 'Not configured'}
          </Text>
          <Text style={styles.cardBody} testID="dashboard-config-status">
            {viewState.message}
          </Text>
          <Pressable
            testID="dashboard-config-open-settings-button"
            accessibilityRole="button"
            style={styles.primaryButton}
            onPress={onOpenSettings}>
            <Text style={styles.primaryButtonText}>Open Settings</Text>
          </Pressable>
        </View>
      ) : null}

      {viewState.status === 'locked' ? (
        <View style={styles.card} testID="dashboard-locked-card">
          <Text style={styles.cardHeading}>
            {viewState.reason === 'auth_invalidated'
              ? 'Re-link required'
              : 'Biometric unlock required'}
          </Text>
          <Text style={styles.cardBody} testID="dashboard-locked-message">
            {viewState.message}
          </Text>
          {viewState.reason === 'auth_invalidated' ||
          viewState.reason === 'no_biometrics_enrolled' ||
          viewState.reason === 'biometric_unavailable' ? (
            <Pressable
              testID="dashboard-locked-settings-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={onOpenSettings}>
              <Text style={styles.primaryButtonText}>Open Settings</Text>
            </Pressable>
          ) : (
            <Pressable
              testID="dashboard-unlock-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={handleManualRefresh}>
              <Text style={styles.primaryButtonText}>Unlock Dashboard</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {viewState.status === 'loading' ? (
        <View style={styles.card} testID="dashboard-loading-card">
          <ActivityIndicator size="small" color="#2563eb" />
          <Text style={styles.cardHeading}>Loading</Text>
          <Text style={styles.cardBody}>{viewState.message}</Text>
        </View>
      ) : null}

      {viewState.status === 'error' ? (
        <View style={styles.errorCard} testID="dashboard-error-card">
          <Text style={styles.cardHeading}>
            {errorHeadingForKind(viewState.error.kind)}
          </Text>
          <Text style={styles.cardBody} testID="dashboard-error-message">
            {viewState.error.message}
          </Text>
          {viewState.error.kind === 'auth_rejected' ? (
            <Pressable
              testID="dashboard-error-settings-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={onOpenSettings}>
              <Text style={styles.primaryButtonText}>
                Open Settings to Replace Key
              </Text>
            </Pressable>
          ) : (
            <Pressable
              testID="dashboard-error-retry-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={handleManualRefresh}>
              <Text style={styles.primaryButtonText}>Retry</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {activeSnapshot && summary ? (
        <>
          <View style={styles.card} testID="dashboard-summary-card">
            <View style={styles.summaryHeaderRow}>
              <Text style={styles.cardHeading}>
                Session Summary{isStale ? ' (Stale)' : ''}
              </Text>
              <Text
                style={styles.totalCountText}
                testID="dashboard-total-sessions">
                Total: {summary.total}
              </Text>
            </View>
            <View style={styles.statusGrid}>
              {summary.counts.map(item => (
                <View
                  key={item.status}
                  style={styles.statusChip}
                  testID={`status-count-row-${item.status}`}>
                  <Text style={styles.statusChipCount}>{item.count}</Text>
                  <Text style={styles.statusChipLabel}>{item.status}</Text>
                </View>
              ))}
            </View>
          </View>

          {activeSnapshot.sessions.length === 0 ? (
            isStale ? (
              <View style={styles.card} testID="dashboard-stale-empty-card">
                <Text style={styles.cardHeading}>
                  0 sessions (last known · current state unknown)
                </Text>
                <Text style={styles.cardBody}>
                  The last successful update at{' '}
                  {formatLastUpdatedTimestamp(activeSnapshot.lastUpdatedAtMs)}{' '}
                  reported 0 sessions. Current sessions are unknown while live
                  refresh is unavailable.
                </Text>
              </View>
            ) : (
              <View style={styles.card} testID="dashboard-empty-card">
                <Text style={styles.cardHeading}>0 sessions</Text>
                <Text style={styles.cardBody}>
                  No sessions are currently reported by this Spawnea server.
                </Text>
              </View>
            )
          ) : (
            <>
              <View
                style={
                  needsInput.length > 0
                    ? styles.needsInputSection
                    : styles.card
                }
                testID="dashboard-needs-input-section">
                <Text style={styles.cardHeading}>
                  Needs input ({needsInput.length})
                </Text>
                {needsInput.length === 0 ? (
                  <Text
                    style={styles.cardBody}
                    testID="dashboard-needs-input-empty">
                    0 sessions with status needs_input.
                  </Text>
                ) : (
                  <View style={styles.sessionList}>
                    {needsInput.map(session => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        emphasized
                        onPress={handleOpenSession}
                      />
                    ))}
                  </View>
                )}
              </View>

              {otherSessions.length > 0 ? (
                <View
                  style={styles.card}
                  testID="dashboard-other-sessions-section">
                  <View style={styles.summaryHeaderRow}>
                    <Text style={styles.cardHeading}>
                      Sessions ({otherSessions.length})
                    </Text>
                    {onOpenSessions ? (
                      <Pressable
                        testID="dashboard-view-all-sessions-button"
                        accessibilityRole="button"
                        onPress={onOpenSessions}>
                        <Text style={styles.linkText}>Open Sessions</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.sessionList}>
                    {otherSessions.map(session => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        emphasized={false}
                        onPress={handleOpenSession}
                      />
                    ))}
                  </View>
                </View>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

function SessionCard({
  session,
  emphasized,
  onPress,
}: {
  session: SessionSummary;
  emphasized: boolean;
  onPress: (sessionId: string) => void;
}): React.JSX.Element {
  const title = session.name.trim() || session.task.trim() || session.id;
  const showTaskSubtitle =
    session.task.trim().length > 0 && session.task.trim() !== title;

  return (
    <Pressable
      testID={`dashboard-session-card-${session.id}`}
      accessibilityRole="button"
      style={[
        styles.sessionCard,
        emphasized && styles.sessionCardNeedsInput,
      ]}
      onPress={() => onPress(session.id)}>
      <View style={styles.sessionCardHeader}>
        <Text style={styles.sessionTitle} numberOfLines={2}>
          {title}
        </Text>
        <View style={[styles.statusPill, statusPillStyle(session.status)]}>
          <Text style={styles.statusPillText}>{session.status}</Text>
        </View>
      </View>

      {showTaskSubtitle ? (
        <Text style={styles.sessionTask} numberOfLines={2}>
          {session.task}
        </Text>
      ) : null}

      <Text style={styles.sessionMeta}>
        Project: {session.project.name || session.project.id} · Host:{' '}
        {session.host.name || session.host.id}
      </Text>

      <Text
        style={styles.sessionIdText}
        testID={`dashboard-session-id-${session.id}`}>
        ID: {session.id}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  container: {
    padding: 16,
    paddingBottom: 28,
    gap: 14,
  },
  statusCard: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 8,
  },
  statusHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  connectionPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  connectionLive: {
    backgroundColor: '#ecfdf5',
    borderColor: '#6ee7b7',
  },
  connectionStale: {
    backgroundColor: '#fffbeb',
    borderColor: '#f59e0b',
  },
  connectionError: {
    backgroundColor: '#fef2f2',
    borderColor: '#fca5a5',
  },
  connectionNeutral: {
    backgroundColor: '#f1f5f9',
    borderColor: '#cbd5e1',
  },
  connectionPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
  },
  subtleText: {
    fontSize: 12,
    color: '#64748b',
  },
  serverText: {
    fontSize: 13,
    color: '#334155',
  },
  updatedText: {
    fontSize: 13,
    color: '#475569',
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  staleBanner: {
    backgroundColor: '#fffbeb',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#f59e0b',
    padding: 14,
    gap: 6,
  },
  staleBannerHeading: {
    fontSize: 15,
    fontWeight: '700',
    color: '#92400e',
  },
  staleBannerBody: {
    fontSize: 13,
    lineHeight: 19,
    color: '#78350f',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 10,
  },
  errorCard: {
    backgroundColor: '#fef2f2',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fca5a5',
    padding: 14,
    gap: 10,
  },
  needsInputSection: {
    backgroundColor: '#fffbeb',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#f59e0b',
    padding: 14,
    gap: 10,
  },
  cardHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#475569',
  },
  summaryHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  totalCountText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e293b',
  },
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusChip: {
    minWidth: 96,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  statusChipCount: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  statusChipLabel: {
    fontSize: 12,
    color: '#475569',
  },
  sessionList: {
    gap: 10,
  },
  sessionCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    padding: 12,
    gap: 6,
  },
  sessionCardNeedsInput: {
    backgroundColor: '#ffffff',
    borderColor: '#d97706',
    borderWidth: 1.5,
  },
  sessionCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  sessionTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pillNeedsInput: {
    backgroundColor: '#fef3c7',
  },
  pillWorking: {
    backgroundColor: '#dbeafe',
  },
  pillError: {
    backgroundColor: '#fee2e2',
  },
  pillDisconnected: {
    backgroundColor: '#e2e8f0',
  },
  pillNeutral: {
    backgroundColor: '#f1f5f9',
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
  },
  sessionTask: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 18,
  },
  sessionMeta: {
    fontSize: 12,
    color: '#475569',
  },
  sessionIdText: {
    fontSize: 12,
    color: '#64748b',
  },
  primaryButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  linkText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2563eb',
  },
});
