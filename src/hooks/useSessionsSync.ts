import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { formatApiErrorMessage, SpawneaApiClient } from '../api/client';
import { isDebugLoopbackAllowed } from '../config/runtime';
import { validateServerUrl } from '../config/validation';
import {
  DashboardSnapshot,
  DashboardViewState,
  mapApiFailureToDashboardError,
} from '../dashboard/dashboardModel';
import { getCredentialState } from '../storage/keyStorage';
import {
  SessionCredentialCache,
  TerminalAuthLock,
} from '../storage/sessionCredentialCache';

export const DEFAULT_SYNC_POLL_INTERVAL_MS = 10000;
const POLL_POPUP_TICK_MS = 1000;

export type SyncTrigger = 'focus' | 'foreground' | 'manual' | 'poll';

export interface UseSessionsSyncOptions {
  apiClient: SpawneaApiClient;
  credentialCache: SessionCredentialCache;
  allowDebugLoopback?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
  promptSubtitle?: string;
  onClearPrivateUiState?: () => void;
}

export interface UseSessionsSyncResult {
  viewState: DashboardViewState;
  activeSnapshot: DashboardSnapshot | null;
  isFocused: boolean;
  isManualRefreshing: boolean;
  isBackgroundRefreshing: boolean;
  badgePopupOpen: boolean;
  pollRemainingSeconds: number | null;
  handleManualRefresh: () => void;
  handleToggleBadgePopup: () => void;
}

/**
 * Shared foreground-only, focus-aware session polling and credential-unlock hook
 * used by DashboardScreen and SessionsScreen so both tabs share identical
 * security, lock/background clearing, rate-limit, and auth-error semantics.
 */
export function useSessionsSync({
  apiClient,
  credentialCache,
  allowDebugLoopback,
  pollIntervalMs = DEFAULT_SYNC_POLL_INTERVAL_MS,
  now = Date.now,
  promptSubtitle = 'Unlock your saved API key to load live Spawnea sessions',
  onClearPrivateUiState,
}: UseSessionsSyncOptions): UseSessionsSyncResult {
  const effectiveAllowDebugLoopback =
    allowDebugLoopback ?? isDebugLoopbackAllowed();
  const navigation = useContext(NavigationContext);

  const [viewState, setViewState] = useState<DashboardViewState>({
    status: 'loading',
    message: 'Checking saved configuration...',
  });
  const [isFocused, setIsFocused] = useState<boolean>(() =>
    navigation ? navigation.isFocused() : true,
  );
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [badgePopupOpen, setBadgePopupOpen] = useState(false);
  const [popupTickMs, setPopupTickMs] = useState(() => now());
  const [hasScheduledPoll, setHasScheduledPoll] = useState(false);

  const onClearPrivateUiStateRef = useRef(onClearPrivateUiState);
  onClearPrivateUiStateRef.current = onClearPrivateUiState;

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
  const nextPollAtMsRef = useRef<number | null>(null);
  const pendingCooldownTriggerRef = useRef<SyncTrigger | null>(null);
  const runSyncRef = useRef<(trigger: SyncTrigger) => Promise<void>>(
    async () => undefined,
  );

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    nextPollAtMsRef.current = null;
    setHasScheduledPoll(false);
  }, []);

  const clearPrivateUiState = useCallback(() => {
    setBadgePopupOpen(false);
    onClearPrivateUiStateRef.current?.();
  }, []);

  const applyTerminalAuthLock = useCallback(
    (lock: TerminalAuthLock, bumpSeq: boolean) => {
      if (bumpSeq) {
        requestSeqRef.current += 1;
      }
      clearPollTimer();
      clearPrivateUiState();
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
    [clearPollTimer, clearPrivateUiState],
  );

  const schedulePoll = useCallback(
    (delayMs: number, trigger: SyncTrigger = 'poll') => {
      clearPollTimer();
      if (!mountedRef.current || !isFocusedRef.current || !appActiveRef.current) {
        pendingCooldownTriggerRef.current = null;
        return;
      }
      const clampedDelayMs = Math.max(0, delayMs);
      nextPollAtMsRef.current = now() + clampedDelayMs;
      setHasScheduledPoll(true);
      pendingCooldownTriggerRef.current = trigger === 'poll' ? null : trigger;
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        nextPollAtMsRef.current = null;
        setHasScheduledPoll(false);
        const nextTrigger = pendingCooldownTriggerRef.current ?? 'poll';
        pendingCooldownTriggerRef.current = null;
        runSyncRef.current(nextTrigger).catch(() => undefined);
      }, clampedDelayMs);
    },
    [clearPollTimer, now],
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
        clearPrivateUiState();
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
        clearPrivateUiState();
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
        clearPrivateUiState();
        credentialCache.invalidateForTerminalAuth('invalid_url', urlCheck.message);
        setViewState({
          status: 'not_configured',
          reason: 'invalid_url',
          message: urlCheck.message,
        });
        return;
      }

      const normalizedUrl = urlCheck.normalizedUrl;

      if (generationAtStart !== lastGenerationRef.current) {
        lastGenerationRef.current = generationAtStart;
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        pendingCooldownTriggerRef.current = null;
        clearPrivateUiState();
      } else if (
        snapshotRef.current !== null &&
        snapshotRef.current.serverUrl !== normalizedUrl
      ) {
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        pendingCooldownTriggerRef.current = null;
        clearPrivateUiState();
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
          clearPrivateUiState();
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
          clearPrivateUiState();
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
          clearPrivateUiState();
          setViewState({
            status: 'locked',
            reason: 'unlock_required',
            message,
          });
          return;
        }

        if (trigger === 'manual') {
          setIsManualRefreshing(true);
        } else {
          setViewState({
            status: 'loading',
            message: 'Unlocking protected API key...',
          });
        }

        try {
          const unlockResult = await credentialCache.unlockAndGetCredentials({
            apiClient,
            allowDebugLoopback: effectiveAllowDebugLoopback,
            promptSubtitle,
          });
          if (isSupersededOrHidden()) {
            return;
          }

          if (!unlockResult.ok) {
            snapshotRef.current = null;
            clearPrivateUiState();
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

        if (result.ok) {
          const nextSnapshot: DashboardSnapshot = {
            sessions: result.data.sessions,
            serverUrl: normalizedUrl,
            credentialGeneration: generationAtStart,
          };
          const hasValidCreds =
            credentialCache.getCachedCredentials(apiClient, normalizedUrl) !==
            null;
          if (!hasValidCreds) {
            snapshotRef.current = null;
            clearPrivateUiState();
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
          clearPrivateUiState();
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
          clearPrivateUiState();
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
      clearPrivateUiState,
      credentialCache,
      effectiveAllowDebugLoopback,
      pollIntervalMs,
      promptSubtitle,
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
      clearPrivateUiState();
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
      setIsFocused(true);
      setIsManualRefreshing(false);
      setIsBackgroundRefreshing(false);
      if (appActiveRef.current) {
        runSync('focus').catch(() => undefined);
      }
    });

    const unsubscribeBlur = navigation?.addListener('blur', () => {
      isFocusedRef.current = false;
      setIsFocused(false);
      requestSeqRef.current += 1;
      clearPollTimer();
      setBadgePopupOpen(false);
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
        clearPrivateUiState();
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
    clearPrivateUiState,
    credentialCache,
    navigation,
    runSync,
  ]);

  useEffect(() => {
    if (!badgePopupOpen || !hasScheduledPoll) {
      return;
    }
    setPopupTickMs(now());
    const timer = setInterval(() => {
      if (mountedRef.current && isFocusedRef.current && appActiveRef.current) {
        setPopupTickMs(now());
      }
    }, POLL_POPUP_TICK_MS);
    return () => clearInterval(timer);
  }, [badgePopupOpen, hasScheduledPoll, now]);

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

  const handleManualRefresh = useCallback(() => {
    runSync('manual').catch(() => undefined);
  }, [runSync]);

  const handleToggleBadgePopup = useCallback(() => {
    if (nextPollAtMsRef.current === null) {
      setBadgePopupOpen(false);
      return;
    }
    setPopupTickMs(now());
    setBadgePopupOpen(prev => !prev);
  }, [now]);

  const pollRemainingSeconds =
    badgePopupOpen &&
    hasScheduledPoll &&
    nextPollAtMsRef.current !== null
      ? Math.max(0, Math.ceil((nextPollAtMsRef.current - popupTickMs) / 1000))
      : null;

  return {
    viewState,
    activeSnapshot,
    isFocused,
    isManualRefreshing,
    isBackgroundRefreshing,
    badgePopupOpen,
    pollRemainingSeconds,
    handleManualRefresh,
    handleToggleBadgePopup,
  };
}
