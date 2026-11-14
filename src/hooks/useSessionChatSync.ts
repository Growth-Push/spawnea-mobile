import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { formatApiErrorMessage, SpawneaApiClient } from '../api/client';
import type {
  ApiResult,
  SessionHistoryResponse,
} from '../api/types';
import {
  applyHistoryFetchResult,
  clearAllUnresolvedSubmissions,
  combineSyncFailures,
  DEFAULT_CHAT_HISTORY_LIMIT,
  DEFAULT_CHAT_OUTPUT_LINES,
  didTranscriptCursorReset,
  mapChatFailure,
  mergeTranscriptItems,
  SessionChatSnapshot,
  SessionChatViewState,
} from '../chat/chatModel';
import { isDebugLoopbackAllowed } from '../config/runtime';
import { validateServerUrl } from '../config/validation';
import { getCredentialState } from '../storage/keyStorage';
import {
  SessionCredentialCache,
  TerminalAuthLock,
  UnlockedApiCredentials,
} from '../storage/sessionCredentialCache';
import { DEFAULT_SYNC_POLL_INTERVAL_MS } from './useSessionsSync';

export const DEFAULT_CHAT_POLL_INTERVAL_MS = DEFAULT_SYNC_POLL_INTERVAL_MS;
const POLL_POPUP_TICK_MS = 1000;
const MAX_FORWARD_PAGES = 5;
const FORWARD_PAGE_LIMIT = 50;

export type ChatSyncTrigger =
  | 'focus'
  | 'foreground'
  | 'manual'
  | 'poll'
  | 'post_send';

export interface SyncNavigationLike {
  addListener?: (event: 'focus' | 'blur', listener: () => void) => () => void;
  isFocused?: () => boolean;
}

export interface UseSessionChatSyncOptions {
  sessionId?: string;
  navigation?: SyncNavigationLike;
  apiClient: SpawneaApiClient;
  credentialCache: SessionCredentialCache;
  allowDebugLoopback?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
  promptSubtitle?: string;
  onClearPrivateUiState?: () => void;
}

export interface UseSessionChatSyncResult {
  viewState: SessionChatViewState;
  activeSnapshot: SessionChatSnapshot | null;
  isFocused: boolean;
  isForeground: boolean;
  hasUnlockedCredential: boolean;
  isAuthPaused: boolean;
  isManualRefreshing: boolean;
  isBackgroundRefreshing: boolean;
  badgePopupOpen: boolean;
  pollRemainingSeconds: number | null;
  handleManualRefresh: () => void;
  triggerPostSendRefresh: () => void;
  handleToggleBadgePopup: () => void;
}

function isForegroundAppState(state: string | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

function parseScreenCursorMeta(cursor?: string): {
  line: number | null;
  fingerprint: string | null;
} {
  if (!cursor) {
    return { line: null, fingerprint: null };
  }
  const match = /^line:(\d+)(?::fp:(.+))?$/.exec(cursor.trim());
  if (!match) {
    return { line: null, fingerprint: null };
  }
  const line = Number.parseInt(match[1], 10);
  return {
    line: Number.isFinite(line) && line >= 0 ? line : null,
    fingerprint: match[2]?.trim() || null,
  };
}

function didScreenPaginationRestart(
  previous: SessionHistoryResponse,
  next: SessionHistoryResponse,
): boolean {
  const prevMeta = parseScreenCursorMeta(previous.cursor);
  const nextMeta = parseScreenCursorMeta(next.cursor);

  if (next.cursor === 'line:0' || nextMeta.line === 0) {
    return true;
  }

  if (
    prevMeta.fingerprint !== null &&
    nextMeta.fingerprint !== null &&
    nextMeta.fingerprint !== prevMeta.fingerprint
  ) {
    return true;
  }

  if (
    (prevMeta.fingerprint === null) !== (nextMeta.fingerprint === null) &&
    (nextMeta.fingerprint !== null || nextMeta.line !== null)
  ) {
    return true;
  }

  if (
    prevMeta.line !== null &&
    nextMeta.line !== null &&
    nextMeta.line < prevMeta.line
  ) {
    return true;
  }

  if (previous.items.length > 0 && next.items.length > 0) {
    const existingIds = new Set(previous.items.map(item => item.id));
    if (next.items.some(item => existingIds.has(item.id))) {
      return true;
    }
  }

  return false;
}

async function fetchHistoryCycle(params: {
  apiClient: SpawneaApiClient;
  credentials: UnlockedApiCredentials;
  sessionId: string;
  previousSnapshot: SessionChatSnapshot | null;
  forceFullWindow: boolean;
  isPolling: boolean;
  isSupersededOrHidden: () => boolean;
}): Promise<
  | { ok: true; response: SessionHistoryResponse; usedCursor: boolean }
  | { ok: false; failure: Extract<ApiResult<unknown>, { ok: false }> }
  | { ok: 'superseded' }
> {
  const {
    apiClient,
    credentials,
    sessionId,
    previousSnapshot,
    forceFullWindow,
    isPolling,
    isSupersededOrHidden,
  } = params;

  const prevCursor =
    !forceFullWindow && previousSnapshot?.historyAvailable
      ? previousSnapshot.historyCursor
      : undefined;
  const usedCursor = Boolean(prevCursor);

  const firstRes = await apiClient.getSessionHistory(
    credentials,
    sessionId,
    usedCursor
      ? { limit: FORWARD_PAGE_LIMIT, cursor: prevCursor }
      : { limit: DEFAULT_CHAT_HISTORY_LIMIT },
    { isPolling },
  );
  if (isSupersededOrHidden()) {
    return { ok: 'superseded' };
  }
  if (!firstRes.ok) {
    return { ok: false, failure: firstRes };
  }

  let combined: SessionHistoryResponse = firstRes.data;
  const resetOnFirstPage =
    usedCursor &&
    combined.source === 'transcript' &&
    didTranscriptCursorReset({
      prevCursor,
      nextCursor: combined.cursor,
    });
  let effectiveUsedCursor = usedCursor && !resetOnFirstPage;

  if (!combined.available || !combined.hasMore || !combined.cursor) {
    return { ok: true, response: combined, usedCursor: effectiveUsedCursor };
  }

  // Drain bounded forward continuation pages when new history exceeded one page.
  let pagesFetched = 1;
  let nextCursor: string | undefined = combined.cursor;
  while (
    combined.hasMore &&
    nextCursor &&
    pagesFetched < MAX_FORWARD_PAGES
  ) {
    const pageRes = await apiClient.getSessionHistory(
      credentials,
      sessionId,
      { limit: FORWARD_PAGE_LIMIT, cursor: nextCursor },
      { isPolling },
    );
    if (isSupersededOrHidden()) {
      return { ok: 'superseded' };
    }
    if (!pageRes.ok) {
      return { ok: false, failure: pageRes };
    }
    pagesFetched += 1;
    const page = pageRes.data;
    if (!page.available) {
      combined = page;
      effectiveUsedCursor = false;
      break;
    }
    if (page.source !== combined.source) {
      combined = page;
      effectiveUsedCursor = false;
      break;
    }
    if (page.source === 'transcript') {
      if (
        didTranscriptCursorReset({
          prevCursor: combined.cursor,
          nextCursor: page.cursor,
        })
      ) {
        combined = {
          ...page,
          items: [...page.items],
        };
        effectiveUsedCursor = false;
      } else {
        combined = {
          ...page,
          items: mergeTranscriptItems(combined.items, page.items),
        };
      }
    } else if (didScreenPaginationRestart(combined, page)) {
      combined = {
        ...page,
        items: [...page.items],
      };
    } else {
      combined = {
        ...page,
        items: [...combined.items, ...page.items],
      };
    }
    if (!page.cursor || page.cursor === nextCursor) {
      break;
    }
    nextCursor = page.cursor;
  }

  return { ok: true, response: combined, usedCursor: effectiveUsedCursor };
}

/**
 * Focus-aware, foreground-only polling and credential-unlock hook for
 * SessionChatScreen, matching Dashboard/Sessions lock/background semantics.
 */
export function useSessionChatSync({
  sessionId,
  navigation: navigationProp,
  apiClient,
  credentialCache,
  allowDebugLoopback,
  pollIntervalMs = DEFAULT_CHAT_POLL_INTERVAL_MS,
  now = Date.now,
  promptSubtitle = 'Unlock your saved API key to view session chat',
  onClearPrivateUiState,
}: UseSessionChatSyncOptions): UseSessionChatSyncResult {
  const effectiveAllowDebugLoopback =
    allowDebugLoopback ?? isDebugLoopbackAllowed();
  const navigationContext = useContext(NavigationContext) as
    | SyncNavigationLike
    | undefined;
  const navigation = navigationProp ?? navigationContext;

  const [viewState, setViewState] = useState<SessionChatViewState>({
    status: 'loading',
    message: 'Checking saved configuration...',
  });
  const [isFocused, setIsFocused] = useState<boolean>(
    () => navigation?.isFocused?.() ?? true,
  );
  const [isForeground, setIsForeground] = useState<boolean>(() =>
    isForegroundAppState(AppState.currentState),
  );
  const [hasUnlockedCredential, setHasUnlockedCredential] = useState<boolean>(
    () => credentialCache.hasUnlockedKey(apiClient),
  );
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [badgePopupOpen, setBadgePopupOpen] = useState(false);
  const [popupTickMs, setPopupTickMs] = useState(() => now());
  const [hasScheduledPoll, setHasScheduledPoll] = useState(false);

  const onClearPrivateUiStateRef = useRef(onClearPrivateUiState);
  onClearPrivateUiStateRef.current = onClearPrivateUiState;

  const mountedRef = useRef(true);
  const isFocusedRef = useRef(navigation?.isFocused?.() ?? true);
  const appActiveRef = useRef(isForegroundAppState(AppState.currentState));
  const snapshotRef = useRef<SessionChatSnapshot | null>(null);
  const sessionIdRef = useRef<string | undefined>(sessionId);
  const lastGenerationRef = useRef<number>(apiClient.getCredentialGeneration());
  const autoUnlockDeclinedRef = useRef(false);
  const requestSeqRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextPollAtMsRef = useRef<number | null>(null);
  const pendingCooldownTriggerRef = useRef<ChatSyncTrigger | null>(null);
  const runSyncRef = useRef<(trigger: ChatSyncTrigger) => Promise<void>>(
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
      if (lock.reason !== 'biometric_lockout') {
        clearAllUnresolvedSubmissions(credentialCache);
      }
      clearPrivateUiState();
      pendingCooldownTriggerRef.current = null;
      setIsManualRefreshing(false);
      setIsBackgroundRefreshing(false);
      setHasUnlockedCredential(false);
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
    [clearPollTimer, clearPrivateUiState, credentialCache],
  );

  const schedulePoll = useCallback(
    (delayMs: number, trigger: ChatSyncTrigger = 'poll') => {
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
    async (trigger: ChatSyncTrigger) => {
      clearPollTimer();
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      const targetSessionId = sessionIdRef.current?.trim() ?? '';
      const generationAtStart = apiClient.getCredentialGeneration();

      const isSupersededOrHidden = () =>
        !mountedRef.current ||
        requestSeqRef.current !== seq ||
        apiClient.getCredentialGeneration() !== generationAtStart ||
        (sessionIdRef.current?.trim() ?? '') !== targetSessionId ||
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
        setHasUnlockedCredential(false);
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
          'Server URL and API key are not configured. Configure them in Settings to load this session.';
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        setHasUnlockedCredential(false);
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
        setHasUnlockedCredential(false);
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
        clearAllUnresolvedSubmissions(credentialCache);
        clearPrivateUiState();
      } else if (
        snapshotRef.current !== null &&
        snapshotRef.current.serverUrl !== normalizedUrl
      ) {
        snapshotRef.current = null;
        autoUnlockDeclinedRef.current = false;
        pendingCooldownTriggerRef.current = null;
        clearAllUnresolvedSubmissions(credentialCache);
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
        setHasUnlockedCredential(false);
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
        const resumeTrigger: ChatSyncTrigger =
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
          setHasUnlockedCredential(false);
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
            setHasUnlockedCredential(false);
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
          setHasUnlockedCredential(true);
          autoUnlockDeclinedRef.current = false;
        } finally {
          if (mountedRef.current && requestSeqRef.current === seq) {
            setIsManualRefreshing(false);
          }
        }
      } else {
        setHasUnlockedCredential(true);
      }

      if (!targetSessionId) {
        snapshotRef.current = null;
        setViewState({
          status: 'error',
          error: {
            kind: 'server_error',
            category: 'invalid_request',
            status: null,
            retryAfterSeconds: null,
            message:
              'No session selected. Choose a session from Dashboard or Sessions.',
          },
        });
        return;
      }

      if (trigger === 'manual') {
        setIsManualRefreshing(true);
      } else if (
        trigger === 'poll' ||
        trigger === 'post_send' ||
        snapshotRef.current !== null
      ) {
        setIsBackgroundRefreshing(true);
      } else {
        setViewState({
          status: 'loading',
          message: 'Loading session chat...',
        });
      }

      const isPolling = trigger === 'poll';
      const forceFullWindow = trigger === 'manual';

      try {
        const [detailRes, historyCycle, outputRes] = await Promise.all([
          apiClient.getSessionDetail(credentials, targetSessionId, {
            isPolling,
          }),
          fetchHistoryCycle({
            apiClient,
            credentials,
            sessionId: targetSessionId,
            previousSnapshot: snapshotRef.current,
            forceFullWindow,
            isPolling,
            isSupersededOrHidden,
          }),
          apiClient.getSessionOutput(
            credentials,
            targetSessionId,
            DEFAULT_CHAT_OUTPUT_LINES,
            { isPolling },
          ),
        ]);

        if (isSupersededOrHidden() || historyCycle.ok === 'superseded') {
          return;
        }

        if (detailRes.ok && historyCycle.ok && outputRes.ok) {
          const hasValidCreds =
            credentialCache.getCachedCredentials(apiClient, normalizedUrl) !==
            null;
          if (!hasValidCreds) {
            snapshotRef.current = null;
            setHasUnlockedCredential(false);
            clearPrivateUiState();
            setViewState({
              status: 'locked',
              reason: 'unlock_required',
              message:
                'Fingerprint unlock is required to access your saved API key.',
            });
            return;
          }

          const historyState = applyHistoryFetchResult(
            snapshotRef.current,
            historyCycle.response,
            historyCycle.usedCursor,
          );
          const nextSnapshot: SessionChatSnapshot = {
            session: detailRes.data.session,
            ...historyState,
            outputAvailable: outputRes.data.available,
            outputStatus: outputRes.data.status,
            outputText: outputRes.data.output,
            outputMessage: outputRes.data.message,
            lastFetchedAtMs: now(),
            serverUrl: normalizedUrl,
            credentialGeneration: generationAtStart,
          };
          snapshotRef.current = nextSnapshot;
          setViewState({ status: 'live', snapshot: nextSnapshot });
          schedulePoll(pollIntervalMs);
          return;
        }

        const failures: Array<Extract<ApiResult<unknown>, { ok: false }>> = [];
        if (!detailRes.ok) {
          failures.push(detailRes);
        }
        if (!historyCycle.ok) {
          failures.push(historyCycle.failure);
        }
        if (!outputRes.ok) {
          failures.push(outputRes);
        }

        const primaryFailure = combineSyncFailures(failures);
        const mapped = mapChatFailure(primaryFailure);

        if (mapped.error.kind === 'not_configured') {
          snapshotRef.current = null;
          setHasUnlockedCredential(false);
          clearPrivateUiState();
          setViewState({
            status: 'not_configured',
            reason: 'not_configured',
            message: mapped.error.message,
          });
          return;
        }

        const hasValidCreds =
          credentialCache.getCachedCredentials(apiClient, normalizedUrl) !==
          null;
        if (!hasValidCreds) {
          snapshotRef.current = null;
          setHasUnlockedCredential(false);
        }

        if (hasValidCreds && snapshotRef.current !== null) {
          setViewState({
            status: 'stale',
            snapshot: snapshotRef.current,
            staleReason: mapped.error.message,
            errorKind: mapped.error.kind,
            retryAfterSeconds: mapped.error.retryAfterSeconds,
          });
        } else {
          clearPrivateUiState();
          setViewState({
            status: 'error',
            error: mapped.error,
            notFound: mapped.notFound,
          });
        }

        if (mapped.error.kind === 'auth_rejected' || mapped.notFound) {
          return;
        }

        if (
          mapped.error.kind === 'rate_limited' &&
          mapped.error.retryAfterSeconds !== null &&
          mapped.error.retryAfterSeconds > 0
        ) {
          schedulePoll(
            Math.max(pollIntervalMs, mapped.error.retryAfterSeconds * 1000),
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
      now,
      pollIntervalMs,
      promptSubtitle,
      schedulePoll,
    ],
  );

  runSyncRef.current = runSync;

  useEffect(() => {
    const prevId = sessionIdRef.current;
    sessionIdRef.current = sessionId;
    if (prevId !== sessionId) {
      snapshotRef.current = null;
      clearPrivateUiState();
      if (isFocusedRef.current && appActiveRef.current) {
        setViewState({
          status: 'loading',
          message: 'Loading session chat...',
        });
        runSyncRef.current('focus').catch(() => undefined);
      }
    }
  }, [clearPrivateUiState, sessionId]);

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
      setHasUnlockedCredential(false);
      clearPrivateUiState();
      if (credentialCache.getTerminalAuthLock() !== null) {
        return;
      }
      setViewState(prev =>
        prev.status === 'live' || prev.status === 'stale'
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

    const unsubscribeFocus = navigation?.addListener?.('focus', () => {
      isFocusedRef.current = true;
      setIsFocused(true);
      setIsManualRefreshing(false);
      setIsBackgroundRefreshing(false);
      if (appActiveRef.current) {
        runSync('focus').catch(() => undefined);
      }
    });

    const unsubscribeBlur = navigation?.addListener?.('blur', () => {
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
      const nextActive = isForegroundAppState(nextState);
      const wasActive = appActiveRef.current;
      appActiveRef.current = nextActive;
      setIsForeground(nextActive);

      if (!nextActive) {
        requestSeqRef.current += 1;
        clearPollTimer();
        clearPrivateUiState();
        pendingCooldownTriggerRef.current = null;
        setIsManualRefreshing(false);
        setIsBackgroundRefreshing(false);
        setHasUnlockedCredential(false);
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
                  'Unlock with your fingerprint to view this session.',
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
    (viewState.status === 'live' || viewState.status === 'stale') &&
    credentialCache.getCachedCredentials(
      apiClient,
      viewState.snapshot.serverUrl,
    ) !== null
      ? viewState.snapshot
      : null;

  const handleManualRefresh = useCallback(() => {
    runSync('manual').catch(() => undefined);
  }, [runSync]);

  const triggerPostSendRefresh = useCallback(() => {
    runSync('post_send').catch(() => undefined);
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

  const isAuthPaused =
    apiClient.isPollingPausedForAuth() ||
    (viewState.status === 'stale' && viewState.errorKind === 'auth_rejected') ||
    (viewState.status === 'error' && viewState.error.kind === 'auth_rejected');

  return {
    viewState,
    activeSnapshot,
    isFocused,
    isForeground,
    hasUnlockedCredential,
    isAuthPaused,
    isManualRefreshing,
    isBackgroundRefreshing,
    badgePopupOpen,
    pollRemainingSeconds,
    handleManualRefresh,
    triggerPostSendRefresh,
    handleToggleBadgePopup,
  };
}
