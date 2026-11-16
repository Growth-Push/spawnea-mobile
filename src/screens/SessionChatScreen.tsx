import { NavigationContext } from '@react-navigation/native';
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
  Keyboard,
  LayoutChangeEvent,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { defaultApiClient, SpawneaApiClient } from '../api/client';
import type { SessionHistoryItem } from '../api/types';
import {
  clearUnresolvedSubmission,
  ComposerSubmission,
  createClientRequestId,
  DELIVERED_BANNER_DURATION_MS,
  evaluateRetryGate,
  evaluateSendGate,
  formatFetchTime,
  formatItemTimestamp,
  getInFlightSubmissionRequestId,
  getUnresolvedSubmission,
  groupHistoryItemsByTurn,
  isScrollNearBottom,
  mapSendFailureToSubmission,
  mapSendResponseToSubmission,
  MAX_CHAT_DRAFT_CHARS,
  saveUnresolvedSubmission,
  setUnresolvedSubmissionInFlight,
  sliceOutputTail,
  subscribeUnresolvedSubmission,
  UNKNOWN_RETRY_GUIDANCE,
  UnresolvedSubmissionRecord,
  UnresolvedSubmissionScopeKey,
} from '../chat/chatModel';
import {
  BackArrowIcon,
  BranchIcon,
  ChevronIcon,
  HarnessIcon,
  HostIcon,
  ProjectIcon,
  SendIcon,
  SpawneaMarkIcon,
  ToolIcon,
} from '../dashboard/DashboardIcons';
import { formatSessionTitle } from '../dashboard/dashboardModel';
import {
  badgeVisuals,
  connectionBadgeLabel,
  errorHeadingForKind,
  StatusChip,
} from '../dashboard/sessionUi';
import {
  DEFAULT_CHAT_POLL_INTERVAL_MS,
  useSessionChatSync,
} from '../hooks/useSessionChatSync';
import {
  formatHarnessName,
  formatHostName,
  formatProjectName,
} from '../sessions/sessionsModel';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../storage/sessionCredentialCache';

interface SessionChatNavigationProp {
  canGoBack?: () => boolean;
  goBack?: () => void;
  navigate?: (screen: string) => void;
  getParent?: () => SessionChatNavigationProp | undefined;
  setParams?: (params: { sessionId?: string }) => void;
  addListener?: (event: 'focus' | 'blur', listener: () => void) => () => void;
  isFocused?: () => boolean;
}

export interface SessionChatScreenProps {
  route?: {
    params?: {
      sessionId?: string;
    };
  };
  navigation?: SessionChatNavigationProp;
  sessionId?: string;
  onOpenSettings?: () => void;
  apiClient?: SpawneaApiClient;
  credentialCache?: SessionCredentialCache;
  allowDebugLoopback?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
}

function formatHistorySourceLabel(source: 'transcript' | 'screen'): string {
  return source === 'transcript' ? 'Transcript' : 'Screen';
}

let screenInstanceSeq = 0;

/**
 * Shared bottom-pinned auto-follow controller for scrollable transcripts and terminal views.
 * Positions at the end on initial layout and follows content updates (including same-height
 * content replacements) only while pinned near the bottom and not actively dragged.
 */
function useBottomFollowScroll(params: {
  contentKey: string | null;
  enabled: boolean;
  bottomThresholdPx?: number;
  layoutDeltaThresholdPx: number;
  mountedRef: React.MutableRefObject<boolean>;
  now: () => number;
}) {
  const {
    contentKey,
    enabled,
    bottomThresholdPx,
    layoutDeltaThresholdPx,
    mountedRef,
    now,
  } = params;
  const scrollViewRef = useRef<React.ComponentRef<typeof ScrollView> | null>(
    null,
  );
  const isPinnedToBottomRef = useRef(true);
  const hasInitialScrolledRef = useRef(false);
  const lastAutoScrolledHeightRef = useRef(0);
  const lastAutoScrolledContentKeyRef = useRef<string | null>(null);
  const userDraggingRef = useRef(false);
  const suppressAutoUnpinUntilRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const followRafRef = useRef<number | null>(null);
  const followTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const contentKeyRef = useRef(contentKey);
  contentKeyRef.current = contentKey;

  const cancelPendingFollow = useCallback(() => {
    if (
      followRafRef.current !== null &&
      typeof cancelAnimationFrame === 'function'
    ) {
      cancelAnimationFrame(followRafRef.current);
    }
    followRafRef.current = null;
    if (followTimeoutsRef.current.length > 0) {
      for (const timer of followTimeoutsRef.current) {
        clearTimeout(timer);
      }
      followTimeoutsRef.current = [];
    }
  }, []);

  const reset = useCallback(() => {
    cancelPendingFollow();
    hasInitialScrolledRef.current = false;
    isPinnedToBottomRef.current = true;
    lastAutoScrolledHeightRef.current = 0;
    lastAutoScrolledContentKeyRef.current = null;
    userDraggingRef.current = false;
    suppressAutoUnpinUntilRef.current = 0;
  }, [cancelPendingFollow]);

  useEffect(() => {
    if (!enabled) {
      reset();
    }
  }, [enabled, reset]);

  useEffect(() => () => cancelPendingFollow(), [cancelPendingFollow]);

  const applyNativeScrollToBottom = useCallback(() => {
    const scrollView = scrollViewRef.current;
    if (
      !mountedRef.current ||
      !scrollView ||
      !enabledRef.current ||
      !isPinnedToBottomRef.current ||
      userDraggingRef.current
    ) {
      return;
    }
    suppressAutoUnpinUntilRef.current = now() + 400;
    const contentHeight = contentHeightRef.current;
    const viewportHeight = viewportHeightRef.current;
    if (contentHeight > viewportHeight && viewportHeight > 0) {
      scrollView.scrollTo?.({
        y: Math.max(0, contentHeight - viewportHeight),
        animated: false,
      });
    }
    scrollView.scrollToEnd?.({ animated: false });
  }, [mountedRef, now]);

  const scrollToBottomNow = useCallback(
    (contentHeight?: number) => {
      if (
        !scrollViewRef.current ||
        !enabledRef.current ||
        userDraggingRef.current
      ) {
        return;
      }
      hasInitialScrolledRef.current = true;
      if (typeof contentHeight === 'number' && contentHeight > 0) {
        contentHeightRef.current = contentHeight;
        lastAutoScrolledHeightRef.current = contentHeight;
      }
      lastAutoScrolledContentKeyRef.current = contentKeyRef.current;
      cancelPendingFollow();
      applyNativeScrollToBottom();
      // Android Fabric can commit child layout a frame later; retry briefly while still pinned.
      if (typeof requestAnimationFrame === 'function') {
        followRafRef.current = requestAnimationFrame(() => {
          followRafRef.current = null;
          applyNativeScrollToBottom();
        });
      }
      followTimeoutsRef.current = [
        setTimeout(() => {
          applyNativeScrollToBottom();
        }, 80),
        setTimeout(() => {
          applyNativeScrollToBottom();
        }, 280),
      ];
    },
    [applyNativeScrollToBottom, cancelPendingFollow],
  );

  // Follow updates whose total pixel height/width stays identical (e.g. rolling tail lines).
  useEffect(() => {
    if (
      !enabled ||
      contentKey === null ||
      !hasInitialScrolledRef.current ||
      !isPinnedToBottomRef.current ||
      userDraggingRef.current
    ) {
      return;
    }
    if (contentKey !== lastAutoScrolledContentKeyRef.current) {
      scrollToBottomNow(contentHeightRef.current);
    }
  }, [contentKey, enabled, scrollToBottomNow]);

  const updatePinnedStateFromMetrics = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      if (layoutMeasurement?.height && layoutMeasurement.height > 0) {
        viewportHeightRef.current = layoutMeasurement.height;
      }
      if (contentSize?.height && contentSize.height > 0) {
        contentHeightRef.current = contentSize.height;
      }
      isPinnedToBottomRef.current = isScrollNearBottom({
        offsetY: contentOffset?.y ?? 0,
        viewportHeight: viewportHeightRef.current,
        contentHeight: contentHeightRef.current,
        ...(bottomThresholdPx !== undefined
          ? { thresholdPx: bottomThresholdPx }
          : {}),
      });
    },
    [bottomThresholdPx],
  );

  const handleScrollBeginDrag = useCallback(() => {
    userDraggingRef.current = true;
    suppressAutoUnpinUntilRef.current = 0;
    cancelPendingFollow();
  }, [cancelPendingFollow]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!hasInitialScrolledRef.current) {
        return;
      }
      if (userDraggingRef.current || now() >= suppressAutoUnpinUntilRef.current) {
        updatePinnedStateFromMetrics(event);
      }
    },
    [now, updatePinnedStateFromMetrics],
  );

  const handleScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      userDraggingRef.current = false;
      updatePinnedStateFromMetrics(event);
    },
    [updatePinnedStateFromMetrics],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = event.nativeEvent.layout.height;
      const prevHeight = viewportHeightRef.current;
      viewportHeightRef.current = nextHeight;
      if (
        nextHeight > 0 &&
        enabledRef.current &&
        isPinnedToBottomRef.current &&
        !userDraggingRef.current &&
        contentHeightRef.current > nextHeight &&
        (!hasInitialScrolledRef.current ||
          prevHeight === 0 ||
          Math.abs(nextHeight - prevHeight) > layoutDeltaThresholdPx)
      ) {
        scrollToBottomNow(contentHeightRef.current);
      }
    },
    [layoutDeltaThresholdPx, scrollToBottomNow],
  );

  const handleContentSizeChange = useCallback(
    (_width: number, contentHeight: number) => {
      contentHeightRef.current = contentHeight;
      if (!enabledRef.current || contentHeight <= 0) {
        return;
      }
      if (!hasInitialScrolledRef.current) {
        scrollToBottomNow(contentHeight);
        return;
      }
      if (
        isPinnedToBottomRef.current &&
        !userDraggingRef.current &&
        (Math.abs(contentHeight - lastAutoScrolledHeightRef.current) > 2 ||
          contentKeyRef.current !== lastAutoScrolledContentKeyRef.current)
      ) {
        scrollToBottomNow(contentHeight);
      }
    },
    [scrollToBottomNow],
  );

  return {
    scrollViewRef,
    reset,
    handleLayout,
    handleContentSizeChange,
    handleScrollBeginDrag,
    handleScroll,
    handleScrollEnd,
  };
}

export function SessionChatScreen({
  route,
  navigation: navigationProp,
  sessionId: directSessionId,
  onOpenSettings,
  apiClient = defaultApiClient,
  credentialCache = defaultSessionCredentialCache,
  allowDebugLoopback,
  pollIntervalMs = DEFAULT_CHAT_POLL_INTERVAL_MS,
  now = Date.now,
}: SessionChatScreenProps): React.JSX.Element {
  const safeAreaInsets = useContext(SafeAreaInsetsContext);
  const topInset = safeAreaInsets?.top ?? 0;
  const bottomInset = safeAreaInsets?.bottom ?? 0;

  const navigationContext = useContext(NavigationContext) as
    | SessionChatNavigationProp
    | undefined;
  const navigation = navigationProp ?? navigationContext;
  const routeSessionId = route?.params?.sessionId;
  const rawSessionId = directSessionId ?? routeSessionId;

  const [expandedToolGroups, setExpandedToolGroups] = useState<
    Record<string, boolean>
  >({});
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [outputWrapEnabled, setOutputWrapEnabled] = useState(false);

  const [draftText, setDraftText] = useState('');
  const [draftRequestId, setDraftRequestId] = useState(() =>
    createClientRequestId(now()),
  );
  const [submission, setSubmission] = useState<ComposerSubmission | null>(null);
  const [keyboardBottomPadding, setKeyboardBottomPadding] = useState(0);
  const screenRootRef = useRef<React.ComponentRef<typeof View> | null>(null);
  const resetScrollFollowRef = useRef<(() => void) | null>(null);
  const submitLockRef = useRef(false);
  const mountedRef = useRef(true);
  const sessionEpochRef = useRef(0);
  const screenInstanceIdRef = useRef<string>('');
  if (!screenInstanceIdRef.current) {
    screenInstanceSeq += 1;
    screenInstanceIdRef.current = `chat-screen-${screenInstanceSeq}`;
  }
  const submissionStatusRef = useRef<ComposerSubmission['status'] | null>(null);
  submissionStatusRef.current = submission?.status ?? null;
  const currentSessionIdRef = useRef<string | undefined>(rawSessionId);
  currentSessionIdRef.current = rawSessionId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionEpochRef.current += 1;
      submitLockRef.current = false;
    };
  }, []);

  useEffect(() => {
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent =
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener?.(showEvent, event => {
      const keyboardHeight = event?.endCoordinates?.height ?? 0;
      const keyboardScreenY = event?.endCoordinates?.screenY ?? 0;
      const fallbackPadding = Math.max(
        0,
        Math.ceil(keyboardHeight - bottomInset + 4),
      );
      setKeyboardBottomPadding(fallbackPadding);

      if (screenRootRef.current?.measureInWindow && keyboardScreenY > 0) {
        screenRootRef.current.measureInWindow((_x, y, _width, height) => {
          if (mountedRef.current && height > 0) {
            const overlap = Math.max(
              0,
              Math.ceil(y + height - keyboardScreenY + 4),
            );
            setKeyboardBottomPadding(overlap);
          }
        });
      }
    });

    const hideSub = Keyboard.addListener?.(hideEvent, () => {
      if (mountedRef.current) {
        setKeyboardBottomPadding(0);
      }
    });

    return () => {
      showSub?.remove?.();
      hideSub?.remove?.();
    };
  }, [bottomInset]);

  const clearPrivateUiState = useCallback(() => {
    sessionEpochRef.current += 1;
    resetScrollFollowRef.current?.();
    setExpandedToolGroups({});
    setOutputModalOpen(false);
    setOutputWrapEnabled(false);
    setDraftText('');
    submissionStatusRef.current = null;
    setSubmission(null);
    setKeyboardBottomPadding(0);
    submitLockRef.current = false;
    setDraftRequestId(createClientRequestId(now()));
  }, [now]);

  // Reset composer and expansion state when switching to a different session ID.
  const prevSessionIdRef = useRef<string | undefined>(rawSessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== rawSessionId) {
      prevSessionIdRef.current = rawSessionId;
      clearPrivateUiState();
    }
  }, [clearPrivateUiState, rawSessionId]);

  const {
    viewState,
    activeSnapshot,
    isFocused,
    isForeground,
    hasUnlockedCredential,
    isAuthPaused,
    isManualRefreshing,
    isBackgroundRefreshing,
    pollRemainingSeconds,
    handleManualRefresh,
    triggerPostSendRefresh,
    handleToggleBadgePopup,
  } = useSessionChatSync({
    sessionId: rawSessionId,
    navigation: navigationProp,
    apiClient,
    credentialCache,
    allowDebugLoopback,
    pollIntervalMs,
    now,
    promptSubtitle: 'Unlock your saved API key to view session chat',
    onClearPrivateUiState: clearPrivateUiState,
  });

  const activeSnapshotServerUrl = activeSnapshot?.serverUrl;
  const activeSnapshotCredGen = activeSnapshot?.credentialGeneration;
  const trimmedSessionId = rawSessionId?.trim() ?? '';
  const restoreScopeKey = useMemo<UnresolvedSubmissionScopeKey | null>(() => {
    if (
      !hasUnlockedCredential ||
      !trimmedSessionId ||
      !activeSnapshotServerUrl ||
      activeSnapshotCredGen === undefined
    ) {
      return null;
    }
    return {
      sessionId: trimmedSessionId,
      serverUrl: activeSnapshotServerUrl,
      credentialGeneration: activeSnapshotCredGen,
    };
  }, [
    activeSnapshotCredGen,
    activeSnapshotServerUrl,
    hasUnlockedCredential,
    trimmedSessionId,
  ]);

  const syncRecordToScreen = useCallback(
    (
      record: UnresolvedSubmissionRecord | null,
      scopeKey: UnresolvedSubmissionScopeKey,
    ) => {
      if (!mountedRef.current) {
        return;
      }
      if (!record) {
        if (
          submissionStatusRef.current === 'pending' ||
          submissionStatusRef.current === 'unknown'
        ) {
          submitLockRef.current = false;
          submissionStatusRef.current = null;
          setSubmission(null);
          setDraftText('');
          setDraftRequestId(createClientRequestId(now()));
        }
        return;
      }
      let nextSubmission = record.submission;
      if (nextSubmission.status === 'pending') {
        const inFlightId = getInFlightSubmissionRequestId(
          credentialCache,
          scopeKey,
        );
        if (inFlightId !== nextSubmission.clientRequestId) {
          nextSubmission = {
            ...nextSubmission,
            status: 'unknown',
            message: `Delivery outcome is unknown (app was interrupted before confirmation completed). ${UNKNOWN_RETRY_GUIDANCE}`,
          };
          saveUnresolvedSubmission(
            credentialCache,
            {
              ...scopeKey,
              submission: nextSubmission,
            },
            { originInstanceId: screenInstanceIdRef.current },
          );
        }
      }
      setDraftText(nextSubmission.submittedText);
      setDraftRequestId(nextSubmission.clientRequestId);
      submissionStatusRef.current = nextSubmission.status;
      setSubmission(prev => {
        if (
          prev &&
          prev.clientRequestId === nextSubmission.clientRequestId &&
          prev.status === nextSubmission.status &&
          prev.message === nextSubmission.message
        ) {
          return prev;
        }
        return nextSubmission;
      });
    },
    [credentialCache, now],
  );

  useEffect(() => {
    if (!restoreScopeKey) {
      return;
    }

    syncRecordToScreen(
      getUnresolvedSubmission(credentialCache, restoreScopeKey),
      restoreScopeKey,
    );

    return subscribeUnresolvedSubmission(
      credentialCache,
      restoreScopeKey,
      (record, event) => {
        if (!mountedRef.current) {
          return;
        }
        if (!record) {
          submitLockRef.current = false;
          setSubmission(prev =>
            prev && (prev.status === 'pending' || prev.status === 'unknown')
              ? null
              : prev,
          );
          setDraftText('');
          setDraftRequestId(createClientRequestId(now()));
          if (event.resolvedDelivered) {
            triggerPostSendRefresh();
          }
          return;
        }
        syncRecordToScreen(record, restoreScopeKey);
      },
      screenInstanceIdRef.current,
    );
  }, [
    credentialCache,
    now,
    restoreScopeKey,
    syncRecordToScreen,
    triggerPostSendRefresh,
  ]);

  useEffect(() => {
    if (!isFocused || !restoreScopeKey) {
      return;
    }
    syncRecordToScreen(
      getUnresolvedSubmission(credentialCache, restoreScopeKey),
      restoreScopeKey,
    );
  }, [credentialCache, isFocused, restoreScopeKey, syncRecordToScreen]);

  const handleBack = useCallback(() => {
    if (navigation?.canGoBack?.()) {
      navigation.goBack?.();
      return;
    }
    const parentNav = navigation?.getParent?.();
    if (parentNav?.canGoBack?.()) {
      parentNav.goBack?.();
      return;
    }
    navigation?.navigate?.('SessionsList');
  }, [navigation]);

  const handleToggleToolGroup = useCallback((groupKey: string) => {
    setExpandedToolGroups(prev => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  }, []);

  const handleOpenOutputModal = useCallback(() => {
    setOutputWrapEnabled(false);
    setOutputModalOpen(true);
  }, []);

  const handleCloseOutputModal = useCallback(() => {
    setOutputModalOpen(false);
  }, []);

  const handleToggleOutputWrap = useCallback(() => {
    setOutputWrapEnabled(prev => !prev);
  }, []);

  const handleDraftChange = useCallback(
    (nextText: string) => {
      if (submission?.status === 'unknown' || submission?.status === 'pending') {
        return;
      }
      if (submission?.status === 'failed') {
        submissionStatusRef.current = null;
        setSubmission(null);
        setDraftRequestId(createClientRequestId(now()));
      }
      setDraftText(nextText);
    },
    [now, submission],
  );

  const dispatchMessage = useCallback(
    async (
      messageText: string,
      requestId: string,
      retryFromStatus?: 'failed' | 'unknown',
    ) => {
      if (submitLockRef.current) {
        return;
      }
      if (isAuthPaused || apiClient.isPollingPausedForAuth()) {
        return;
      }
      const targetSessionId = rawSessionId?.trim();
      if (!targetSessionId || !activeSnapshot) {
        return;
      }
      const dispatchEpoch = sessionEpochRef.current;
      const dispatchGeneration = apiClient.getCredentialGeneration();
      const dispatchServerUrl = activeSnapshot.serverUrl;

      const credentials = credentialCache.getCachedCredentials(
        apiClient,
        dispatchServerUrl,
      );
      if (!credentials) {
        return;
      }

      const trimmed = messageText.trim();
      if (!trimmed || trimmed.length > MAX_CHAT_DRAFT_CHARS) {
        return;
      }

      const dispatchScopeKey: UnresolvedSubmissionScopeKey = {
        sessionId: targetSessionId,
        serverUrl: dispatchServerUrl,
        credentialGeneration: dispatchGeneration,
      };
      const existingUnresolved = getUnresolvedSubmission(
        credentialCache,
        dispatchScopeKey,
      );
      if (
        existingUnresolved &&
        existingUnresolved.submission.clientRequestId !== requestId
      ) {
        syncRecordToScreen(existingUnresolved, dispatchScopeKey);
        return;
      }
      if (getInFlightSubmissionRequestId(credentialCache, dispatchScopeKey)) {
        if (existingUnresolved) {
          syncRecordToScreen(existingUnresolved, dispatchScopeKey);
        }
        return;
      }

      const pendingSubmission: ComposerSubmission = {
        status: 'pending',
        clientRequestId: requestId,
        submittedText: trimmed,
        message: 'Sending prompt to session...',
      };
      submitLockRef.current = true;
      setUnresolvedSubmissionInFlight(
        credentialCache,
        dispatchScopeKey,
        requestId,
      );
      saveUnresolvedSubmission(
        credentialCache,
        { ...dispatchScopeKey, submission: pendingSubmission },
        { originInstanceId: screenInstanceIdRef.current },
      );
      submissionStatusRef.current = pendingSubmission.status;
      setSubmission(pendingSubmission);

      let settledInStore = false;
      try {
        const result = await apiClient.sendMessage(
          credentials,
          targetSessionId,
          {
            message: trimmed,
            clientRequestId: requestId,
          },
        );

        const terminalLock = credentialCache.getTerminalAuthLock();
        const scopeStillValid =
          apiClient.getCredentialGeneration() === dispatchGeneration &&
          (terminalLock === null || terminalLock.reason === 'biometric_lockout');

        if (!scopeStillValid) {
          settledInStore = true;
          clearUnresolvedSubmission(credentialCache, dispatchScopeKey, {
            originInstanceId: screenInstanceIdRef.current,
          });
          return;
        }

        const nextSubmission = result.ok
          ? mapSendResponseToSubmission(result.data, requestId, trimmed)
          : mapSendFailureToSubmission(result, requestId, trimmed, {
              preserveUnknown: retryFromStatus === 'unknown',
            });

        if (nextSubmission.status === 'unknown') {
          saveUnresolvedSubmission(
            credentialCache,
            { ...dispatchScopeKey, submission: nextSubmission },
            { originInstanceId: screenInstanceIdRef.current },
          );
        } else {
          clearUnresolvedSubmission(credentialCache, dispatchScopeKey, {
            originInstanceId: screenInstanceIdRef.current,
            resolvedDelivered: nextSubmission.status === 'delivered',
          });
        }
        settledInStore = true;
        if (
          getInFlightSubmissionRequestId(credentialCache, dispatchScopeKey) ===
          requestId
        ) {
          setUnresolvedSubmissionInFlight(
            credentialCache,
            dispatchScopeKey,
            null,
          );
        }

        const stillSameSessionAndUnlocked =
          mountedRef.current &&
          (currentSessionIdRef.current?.trim() ?? '') === targetSessionId &&
          credentialCache.getCachedCredentials(apiClient, dispatchServerUrl) !==
            null;

        if (!stillSameSessionAndUnlocked) {
          if (
            mountedRef.current &&
            sessionEpochRef.current === dispatchEpoch &&
            (currentSessionIdRef.current?.trim() ?? '') === targetSessionId &&
            !credentialCache.getCachedCredentials(apiClient, dispatchServerUrl)
          ) {
            clearPrivateUiState();
          }
          return;
        }

        if (sessionEpochRef.current !== dispatchEpoch) {
          // Re-read the shared store because originInstanceId suppresses
          // self-notifications when a new session epoch (e.g. background -> unlock)
          // restored the pending submission on this same screen instance. If the
          // store has no record (definitive failure or delivery), fall through to
          // apply this dispatch's actual outcome instead of wiping it.
          const latestRecord = getUnresolvedSubmission(
            credentialCache,
            dispatchScopeKey,
          );
          if (latestRecord) {
            syncRecordToScreen(latestRecord, dispatchScopeKey);
            return;
          }
        }

        submissionStatusRef.current = nextSubmission.status;
        setSubmission(nextSubmission);
        if (nextSubmission.status === 'delivered') {
          setDraftText('');
          setDraftRequestId(createClientRequestId(now()));
          triggerPostSendRefresh();
        } else if (
          nextSubmission.status === 'failed' &&
          (!retryFromStatus || sessionEpochRef.current !== dispatchEpoch)
        ) {
          // Keep the failed draft text so user can edit or discard cleanly.
          setDraftText(trimmed);
        }
      } finally {
        if (
          getInFlightSubmissionRequestId(credentialCache, dispatchScopeKey) ===
          requestId
        ) {
          setUnresolvedSubmissionInFlight(
            credentialCache,
            dispatchScopeKey,
            null,
          );
        }
        if (
          !settledInStore &&
          apiClient.getCredentialGeneration() === dispatchGeneration
        ) {
          const fallbackUnknown: ComposerSubmission = {
            status: 'unknown',
            clientRequestId: requestId,
            submittedText: trimmed,
            message: `Delivery outcome is unknown because sending did not complete cleanly. ${UNKNOWN_RETRY_GUIDANCE}`,
          };
          saveUnresolvedSubmission(
            credentialCache,
            {
              ...dispatchScopeKey,
              submission: fallbackUnknown,
            },
            { originInstanceId: screenInstanceIdRef.current },
          );
          if (
            mountedRef.current &&
            (currentSessionIdRef.current?.trim() ?? '') === targetSessionId &&
            credentialCache.getCachedCredentials(
              apiClient,
              dispatchServerUrl,
            ) !== null
          ) {
            syncRecordToScreen(
              getUnresolvedSubmission(credentialCache, dispatchScopeKey),
              dispatchScopeKey,
            );
          }
        }
        if (sessionEpochRef.current === dispatchEpoch) {
          submitLockRef.current = false;
        }
      }
    },
    [
      activeSnapshot,
      apiClient,
      clearPrivateUiState,
      credentialCache,
      isAuthPaused,
      now,
      rawSessionId,
      syncRecordToScreen,
      triggerPostSendRefresh,
    ],
  );

  const sendGate = useMemo(
    () =>
      evaluateSendGate({
        isForeground,
        hasUnlockedCredential,
        isAuthPaused,
        session: activeSnapshot?.session ?? null,
        submissionStatus: submission?.status ?? null,
        conflictDifferentPrompt: submission?.conflictDifferentPrompt,
        draftText,
      }),
    [
      activeSnapshot?.session,
      draftText,
      hasUnlockedCredential,
      isAuthPaused,
      isForeground,
      submission?.conflictDifferentPrompt,
      submission?.status,
    ],
  );

  const retryGate = useMemo(
    () =>
      evaluateRetryGate({
        submission,
        isForeground,
        hasUnlockedCredential,
        isAuthPaused,
        session: activeSnapshot?.session ?? null,
      }),
    [
      activeSnapshot?.session,
      hasUnlockedCredential,
      isAuthPaused,
      isForeground,
      submission,
    ],
  );

  const handlePressSend = useCallback(() => {
    if (!sendGate.allowed) {
      return;
    }
    dispatchMessage(draftText, draftRequestId).catch(() => undefined);
  }, [dispatchMessage, draftRequestId, draftText, sendGate.allowed]);

  const handleRetrySubmission = useCallback(() => {
    if (
      !submission ||
      !retryGate.allowed ||
      (submission.status !== 'failed' && submission.status !== 'unknown')
    ) {
      return;
    }
    dispatchMessage(
      submission.submittedText,
      submission.clientRequestId,
      submission.status,
    ).catch(() => undefined);
  }, [dispatchMessage, retryGate.allowed, submission]);

  const handleDiscardSubmission = useCallback(() => {
    if (submission?.status === 'pending' || submitLockRef.current) {
      return;
    }
    if (restoreScopeKey) {
      clearUnresolvedSubmission(credentialCache, restoreScopeKey, {
        originInstanceId: screenInstanceIdRef.current,
      });
    }
    setSubmission(null);
    setDraftText('');
    setDraftRequestId(createClientRequestId(now()));
  }, [credentialCache, now, restoreScopeKey, submission?.status]);

  useEffect(() => {
    if (submission?.status !== 'delivered') {
      return;
    }
    if (!isFocused) {
      submissionStatusRef.current = null;
      setSubmission(prev => (prev?.status === 'delivered' ? null : prev));
      return;
    }
    const activeDelivered = submission;
    const timer = setTimeout(() => {
      if (!mountedRef.current) {
        return;
      }
      setSubmission(prev => {
        if (prev === activeDelivered) {
          submissionStatusRef.current = null;
          return null;
        }
        return prev;
      });
    }, DELIVERED_BANNER_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isFocused, submission]);

  const turnGroups = useMemo(
    () =>
      activeSnapshot && activeSnapshot.historyAvailable
        ? groupHistoryItemsByTurn(activeSnapshot.historyItems)
        : [],
    [activeSnapshot],
  );

  const outputTail = useMemo(
    () =>
      activeSnapshot && activeSnapshot.outputAvailable
        ? sliceOutputTail(activeSnapshot.outputText, true)
        : null,
    [activeSnapshot],
  );

  const session = activeSnapshot?.session ?? null;
  const sessionTitle = session ? formatSessionTitle(session) : 'Session / Chat';
  const trimmedTask = session ? session.task.trim() : '';
  const showTaskSubtitle =
    Boolean(session) && trimmedTask.length > 0 && trimmedTask !== sessionTitle;
  const branchLabel = session?.worktree?.branch?.trim() || null;

  const latestHistoryItem =
    activeSnapshot && activeSnapshot.historyItems.length > 0
      ? activeSnapshot.historyItems[activeSnapshot.historyItems.length - 1]
      : null;
  const scrollContentKey = activeSnapshot
    ? [
        activeSnapshot.session.id,
        activeSnapshot.historyItems.length,
        latestHistoryItem?.id ?? '',
        latestHistoryItem?.text.length ?? 0,
        (activeSnapshot.outputText ?? '').length,
        submission?.status && submission.status !== 'delivered'
          ? submission.status
          : '',
      ].join(':')
    : null;

  const outputInlineText =
    activeSnapshot &&
    activeSnapshot.outputAvailable &&
    outputTail &&
    outputTail.totalLines > 0
      ? outputTail.visibleText
      : null;

  const chatScroll = useBottomFollowScroll({
    contentKey: scrollContentKey,
    enabled: Boolean(activeSnapshot),
    layoutDeltaThresholdPx: 8,
    mountedRef,
    now,
  });
  const outputInlineScroll = useBottomFollowScroll({
    contentKey: outputInlineText,
    enabled: outputInlineText !== null,
    bottomThresholdPx: 24,
    layoutDeltaThresholdPx: 4,
    mountedRef,
    now,
  });
  resetScrollFollowRef.current = () => {
    chatScroll.reset();
    outputInlineScroll.reset();
  };

  const isStale = viewState.status === 'stale';
  const badgeStyle = badgeVisuals(viewState);
  const badgeLabel = connectionBadgeLabel(viewState);

  return (
    <View
      ref={screenRootRef}
      style={[
        styles.screenRoot,
        {
          paddingTop: topInset,
          paddingBottom: Math.max(bottomInset, keyboardBottomPadding),
        },
      ]}
      testID="session-chat-screen">
      {isFocused ? <StatusBar barStyle="light-content" /> : null}

      <View style={styles.headerBlock} testID="session-chat-header">
        <View style={styles.headerTopRow}>
          <Pressable
            testID="session-chat-back-button"
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.backButton}
            onPress={handleBack}>
            <BackArrowIcon color="#f0f6fc" size={18} />
          </Pressable>

          <View style={styles.headerTitleCol}>
            <Text
              style={styles.headerTitle}
              numberOfLines={1}
              ellipsizeMode="tail"
              testID="session-chat-title">
              {sessionTitle}
            </Text>
            {session ? (
              <View style={styles.headerMetaRow}>
                <StatusChip status={session.status} />
                <View style={styles.metaChip}>
                  <HarnessIcon color="#a78bfa" size={11} />
                  <Text style={styles.metaText}>
                    {formatHarnessName(session)}
                  </Text>
                </View>
                <View style={styles.metaChip}>
                  <HostIcon color="#8b949e" size={11} />
                  <Text style={styles.metaText}>{formatHostName(session)}</Text>
                </View>
                <View style={styles.metaChip}>
                  <ProjectIcon color="#93c5fd" size={11} />
                  <Text style={styles.metaText}>
                    {formatProjectName(session)}
                  </Text>
                </View>
                {branchLabel ? (
                  <View style={[styles.metaChip, styles.metaBranchChip]}>
                    <BranchIcon color="#93c5fd" size={11} />
                    <Text style={styles.metaBranchText}>{branchLabel}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {showTaskSubtitle ? (
              <Text
                style={styles.headerTask}
                numberOfLines={1}
                ellipsizeMode="tail"
                testID="session-chat-task">
                {trimmedTask}
              </Text>
            ) : null}
          </View>

          <Pressable
            testID="session-chat-connection-badge"
            accessibilityRole="button"
            accessibilityLabel={`Connection status: ${badgeLabel}`}
            onPress={handleToggleBadgePopup}
            style={[styles.connectionBadge, badgeStyle.container]}>
            <View
              style={[styles.connectionDot, { backgroundColor: badgeStyle.dot }]}
            />
            <Text
              style={[styles.connectionBadgeText, { color: badgeStyle.text }]}
              testID="session-chat-connection-status">
              {badgeLabel}
            </Text>
            {isBackgroundRefreshing && !isManualRefreshing ? (
              <ActivityIndicator
                size="small"
                color={badgeStyle.text}
                style={styles.badgeSpinner}
              />
            ) : null}
          </Pressable>
        </View>

        {pollRemainingSeconds !== null ? (
          <View
            style={styles.pollPopup}
            testID="session-chat-poll-countdown-popup">
            <Text
              style={styles.pollPopupText}
              testID="session-chat-poll-countdown-text">
              Refresh in {pollRemainingSeconds} s
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.bodyWrap}>
        {submission?.status === 'delivered' ? (
          <View
            pointerEvents="box-none"
            style={styles.topDeliveredBannerWrap}
            testID="session-chat-delivered-top-banner">
            <SubmissionBanner
              submission={submission}
              retryAllowed={retryGate.allowed}
              retryBlockedReason={retryGate.reason}
              onRetry={handleRetrySubmission}
              onDiscard={handleDiscardSubmission}
              onOpenSettings={onOpenSettings}
            />
          </View>
        ) : null}

        <ScrollView
          ref={chatScroll.scrollViewRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onLayout={chatScroll.handleLayout}
          onContentSizeChange={chatScroll.handleContentSizeChange}
          onScrollBeginDrag={chatScroll.handleScrollBeginDrag}
          onScroll={chatScroll.handleScroll}
          onScrollEndDrag={chatScroll.handleScrollEnd}
          onMomentumScrollEnd={chatScroll.handleScrollEnd}
          testID="session-chat-scroll"
          refreshControl={
            <RefreshControl
              refreshing={isManualRefreshing}
              onRefresh={handleManualRefresh}
              colors={['#a78bfa', '#34d399']}
              progressBackgroundColor="#161b22"
              tintColor="#a78bfa"
            />
          }>
        {viewState.status === 'not_configured' ? (
          <View style={styles.card} testID="session-chat-not-configured-card">
            <Text style={styles.cardHeading}>
              {viewState.reason === 'incomplete_config'
                ? 'Incomplete configuration'
                : viewState.reason === 'invalid_url'
                  ? 'Invalid server URL'
                  : 'Not configured'}
            </Text>
            <Text style={styles.cardBody} testID="session-chat-config-status">
              {viewState.message}
            </Text>
            {onOpenSettings ? (
              <Pressable
                testID="session-chat-open-settings-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={onOpenSettings}>
                <Text style={styles.primaryButtonText}>Open Settings</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {viewState.status === 'locked' ? (
          <View style={styles.card} testID="session-chat-locked-card">
            <Text style={styles.cardHeading}>
              {viewState.reason === 'auth_invalidated'
                ? 'Re-link required'
                : 'Biometric unlock required'}
            </Text>
            <Text style={styles.cardBody} testID="session-chat-locked-message">
              {viewState.message}
            </Text>
            {(viewState.reason === 'auth_invalidated' ||
              viewState.reason === 'no_biometrics_enrolled' ||
              viewState.reason === 'biometric_unavailable') &&
            onOpenSettings ? (
              <Pressable
                testID="session-chat-locked-settings-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={onOpenSettings}>
                <Text style={styles.primaryButtonText}>Open Settings</Text>
              </Pressable>
            ) : (
              <Pressable
                testID="session-chat-unlock-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={handleManualRefresh}>
                <Text style={styles.primaryButtonText}>Unlock Session</Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {viewState.status === 'loading' ? (
          <View style={styles.card} testID="session-chat-loading-card">
            <ActivityIndicator size="small" color="#a78bfa" />
            <Text style={styles.cardHeading}>Loading</Text>
            <Text style={styles.cardBody}>{viewState.message}</Text>
          </View>
        ) : null}

        {viewState.status === 'error' ? (
          <View style={styles.errorCard} testID="session-chat-error-card">
            <Text style={styles.errorCardHeading}>
              {viewState.notFound
                ? 'Session not found'
                : errorHeadingForKind(viewState.error.kind)}
            </Text>
            <Text
              style={styles.errorCardBody}
              testID="session-chat-error-message">
              {viewState.error.message}
            </Text>
            {viewState.error.kind === 'auth_rejected' && onOpenSettings ? (
              <Pressable
                testID="session-chat-error-settings-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={onOpenSettings}>
                <Text style={styles.primaryButtonText}>
                  Open Settings to Replace Key
                </Text>
              </Pressable>
            ) : (
              <Pressable
                testID="session-chat-error-retry-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={handleManualRefresh}>
                <Text style={styles.primaryButtonText}>Retry</Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {isStale && activeSnapshot ? (
          <View style={styles.staleBanner} testID="session-chat-stale-banner">
            <View style={styles.bannerHeaderRow}>
              <View style={styles.staleBadgeDot} />
              <Text
                style={styles.staleBannerHeading}
                testID="session-chat-stale-heading">
                Stale data · Not live
              </Text>
            </View>
            <Text
              style={styles.staleBannerBody}
              testID="session-chat-stale-reason">
              Showing snapshot from {formatFetchTime(activeSnapshot.lastFetchedAtMs)}{' '}
              while live refresh is unavailable: {viewState.staleReason} Pull down
              to refresh.
            </Text>
            {viewState.errorKind === 'auth_rejected' && onOpenSettings ? (
              <Pressable
                testID="session-chat-stale-settings-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={onOpenSettings}>
                <Text style={styles.primaryButtonText}>Open Settings</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {activeSnapshot ? (
          <>
            <View
              style={styles.signalsBar}
              testID="session-chat-signals-bar">
              <Text
                style={styles.signalsText}
                testID="session-chat-freshness-text">
                {isStale ? 'Last good fetch' : 'Updated'}{' '}
                {formatFetchTime(activeSnapshot.lastFetchedAtMs)}
              </Text>
              <Text
                style={styles.signalsText}
                testID="session-chat-source-text">
                History: {formatHistorySourceLabel(activeSnapshot.historySource)}{' '}
                · {activeSnapshot.historyAvailable ? 'Available' : 'Unavailable'}
              </Text>
              <Text
                style={styles.signalsText}
                testID="session-chat-window-text">
                {!activeSnapshot.historyAvailable
                  ? activeSnapshot.historySource === 'screen'
                    ? 'Screen snapshot unavailable'
                    : 'Recent window unavailable'
                  : activeSnapshot.historySource === 'screen'
                    ? activeSnapshot.historyHasMore
                      ? 'Screen snapshot (incomplete — page limit reached)'
                      : 'Screen snapshot (current snapshot loaded)'
                    : activeSnapshot.historyHasMore
                      ? 'Recent window (up to 20 exchanges; incomplete — newer items omitted)'
                      : 'Recent window (up to 20 exchanges)'}
              </Text>
            </View>

            {!activeSnapshot.historyAvailable ? (
              <View
                style={styles.unavailableCard}
                testID="session-chat-history-unavailable">
                <Text style={styles.cardHeading}>History unavailable</Text>
                <Text style={styles.cardBody}>
                  {activeSnapshot.historyMessage ||
                    'Session history is currently unavailable.'}
                </Text>
              </View>
            ) : turnGroups.length === 0 ? (
              <View style={styles.card} testID="session-chat-history-empty">
                <Text style={styles.cardHeading}>No recent messages</Text>
                <Text style={styles.cardBody}>
                  No exchanges are present in the current recent window.
                </Text>
              </View>
            ) : (
              <View style={styles.turnsContainer} testID="session-chat-history">
                {turnGroups.map(group => (
                  <View
                    key={group.key}
                    style={styles.turnGroup}
                    testID={`session-chat-turn-${group.key}`}>
                    {group.segments.map((segment, index) => {
                      const prevSegment =
                        index > 0 ? group.segments[index - 1] : null;
                      const prevSpeaker = prevSegment
                        ? prevSegment.kind === 'user'
                          ? 'user'
                          : 'agent'
                        : null;
                      const currSpeaker =
                        segment.kind === 'user' ? 'user' : 'agent';
                      const speakerSwitch =
                        prevSpeaker !== null && prevSpeaker !== currSpeaker;

                      if (segment.kind === 'user') {
                        return (
                          <ChatMessageBubble
                            key={segment.key}
                            item={segment.item}
                            speaker="user"
                            formattedTime={segment.formattedTime}
                            speakerSwitch={speakerSwitch}
                          />
                        );
                      }
                      if (segment.kind === 'tool_group') {
                        const isExpanded = Boolean(
                          expandedToolGroups[segment.key],
                        );
                        return (
                          <ToolActivityCard
                            key={segment.key}
                            groupKey={segment.key}
                            items={segment.items}
                            hasTruncated={segment.hasTruncated}
                            formattedTime={segment.formattedTime}
                            expanded={isExpanded}
                            onToggle={handleToggleToolGroup}
                            speakerSwitch={speakerSwitch}
                          />
                        );
                      }
                      if (segment.item.source === 'screen') {
                        return (
                          <ScreenSnapshotCard
                            key={segment.key}
                            item={segment.item}
                            formattedTime={segment.formattedTime}
                            speakerSwitch={speakerSwitch}
                          />
                        );
                      }
                      return (
                        <ChatMessageBubble
                          key={segment.key}
                          item={segment.item}
                          speaker="agent"
                          formattedTime={segment.formattedTime}
                          speakerSwitch={speakerSwitch}
                        />
                      );
                    })}
                  </View>
                ))}
              </View>
            )}

            <View
              style={styles.outputSection}
              testID="session-chat-output-section">
              <View style={styles.outputHeader}>
                <Text style={styles.outputTitle}>Terminal output</Text>
                <View style={styles.outputHeaderRight}>
                  <View
                    style={[
                      styles.outputPill,
                      !activeSnapshot.outputAvailable
                        ? styles.outputPillUnavailable
                        : isStale
                          ? styles.outputPillStale
                          : styles.outputPillLive,
                    ]}>
                    <View
                      style={[
                        styles.outputPillDot,
                        !activeSnapshot.outputAvailable
                          ? styles.outputPillDotUnavailable
                          : isStale
                            ? styles.outputPillDotStale
                            : styles.outputPillDotLive,
                      ]}
                    />
                    <Text
                      style={styles.outputPillText}
                      testID="session-chat-output-status">
                      {!activeSnapshot.outputAvailable
                        ? 'Unavailable'
                        : isStale
                          ? 'Cached · Not live'
                          : 'Live · Tail (max 200 lines)'}
                    </Text>
                  </View>
                  {activeSnapshot.outputAvailable &&
                  outputTail &&
                  outputTail.totalLines > 0 ? (
                    <Pressable
                      testID="session-chat-output-expand-button"
                      accessibilityRole="button"
                      accessibilityLabel="Expand terminal output"
                      style={styles.outputExpandHeaderButton}
                      onPress={handleOpenOutputModal}>
                      <Text style={styles.outputExpandHeaderText}>Expand</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              {!activeSnapshot.outputAvailable ? (
                <Text
                  style={styles.outputUnavailableText}
                  testID="session-chat-output-unavailable-message">
                  {activeSnapshot.outputMessage ||
                    'Current terminal output is unavailable.'}
                </Text>
              ) : outputTail && outputTail.totalLines === 0 ? (
                <Text style={styles.outputEmptyText}>
                  Terminal output is empty.
                </Text>
              ) : outputTail ? (
                <View style={styles.outputTerminalBox}>
                  <ScrollView
                    ref={outputInlineScroll.scrollViewRef}
                    nestedScrollEnabled
                    style={styles.outputInlineVerticalScroll}
                    contentContainerStyle={styles.outputInlineVerticalContent}
                    showsVerticalScrollIndicator
                    scrollEventThrottle={16}
                    onLayout={outputInlineScroll.handleLayout}
                    onContentSizeChange={outputInlineScroll.handleContentSizeChange}
                    onScrollBeginDrag={outputInlineScroll.handleScrollBeginDrag}
                    onScroll={outputInlineScroll.handleScroll}
                    onScrollEndDrag={outputInlineScroll.handleScrollEnd}
                    onMomentumScrollEnd={outputInlineScroll.handleScrollEnd}
                    testID="session-chat-output-inline-vertical-scroll">
                    <ScrollView
                      horizontal
                      nestedScrollEnabled
                      showsHorizontalScrollIndicator
                      contentContainerStyle={styles.outputHorizontalContent}
                      testID="session-chat-output-inline-horizontal-scroll">
                      <Text
                        selectable
                        style={styles.outputMonoText}
                        testID="session-chat-output-text">
                        {outputTail.visibleText}
                      </Text>
                    </ScrollView>
                  </ScrollView>
                </View>
              ) : null}
            </View>
          </>
        ) : null}
        </ScrollView>
      </View>

      {activeSnapshot ? (
        <View style={styles.composerDock} testID="session-chat-composer">
          {submission && submission.status !== 'delivered' ? (
            <SubmissionBanner
              submission={submission}
              retryAllowed={retryGate.allowed}
              retryBlockedReason={retryGate.reason}
              onRetry={handleRetrySubmission}
              onDiscard={handleDiscardSubmission}
              onOpenSettings={onOpenSettings}
            />
          ) : null}

          {sendGate.reason && !sendGate.emptyDraft ? (
            <View
              style={styles.gateBanner}
              testID="session-chat-send-gate-banner">
              <Text
                style={styles.gateBannerText}
                testID="session-chat-send-gate-reason">
                {sendGate.reason}
              </Text>
            </View>
          ) : null}

          <View style={styles.composerInputRow}>
            <TextInput
              testID="session-chat-input"
              style={[
                styles.composerInput,
                (submission?.status === 'unknown' ||
                  submission?.status === 'pending') &&
                  styles.composerInputDisabled,
              ]}
              value={draftText}
              onChangeText={handleDraftChange}
              placeholder="Reply to agent..."
              placeholderTextColor="#6e7681"
              multiline
              maxLength={MAX_CHAT_DRAFT_CHARS}
              editable={
                submission?.status !== 'unknown' &&
                submission?.status !== 'pending'
              }
              accessibilityLabel="Reply to agent"
            />
            <Pressable
              testID="session-chat-send-button"
              accessibilityRole="button"
              accessibilityLabel="Send follow-up"
              accessibilityState={{ disabled: !sendGate.allowed }}
              disabled={!sendGate.allowed}
              style={[
                styles.sendButton,
                !sendGate.allowed && styles.sendButtonDisabled,
              ]}
              onPress={handlePressSend}>
              {submission?.status === 'pending' ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <SendIcon
                  color={sendGate.allowed ? '#ffffff' : '#6e7681'}
                  size={15}
                />
              )}
            </Pressable>
          </View>
        </View>
      ) : null}

      <Modal
        visible={Boolean(activeSnapshot && outputModalOpen)}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={handleCloseOutputModal}
        testID="session-chat-output-modal">
        <View
          style={[
            styles.outputModalRoot,
            {
              paddingTop: topInset,
              paddingBottom: bottomInset,
            },
          ]}>
          <View
            style={styles.outputModalHeader}
            testID="session-chat-output-modal-header">
            <View style={styles.outputModalTitleCol}>
              <Text style={styles.outputModalTitle} numberOfLines={1}>
                Terminal output
              </Text>
              {activeSnapshot ? (
                <Text style={styles.outputModalSubtitle} numberOfLines={1}>
                  {!activeSnapshot.outputAvailable
                    ? 'Unavailable'
                    : isStale
                      ? 'Cached · Not live'
                      : `Live · ${outputTail?.totalLines ?? 0} lines`}
                </Text>
              ) : null}
            </View>
            <View style={styles.outputModalActions}>
              <Pressable
                testID="session-chat-output-wrap-toggle"
                accessibilityRole="switch"
                accessibilityLabel="Wrap terminal lines"
                accessibilityState={{ checked: outputWrapEnabled }}
                style={[
                  styles.outputModalWrapButton,
                  outputWrapEnabled && styles.outputModalWrapButtonActive,
                ]}
                onPress={handleToggleOutputWrap}>
                <Text
                  style={[
                    styles.outputModalWrapText,
                    outputWrapEnabled && styles.outputModalWrapTextActive,
                  ]}>
                  {outputWrapEnabled ? 'Wrap: On' : 'Wrap: Off'}
                </Text>
              </Pressable>
              <Pressable
                testID="session-chat-output-close-button"
                accessibilityRole="button"
                accessibilityLabel="Close terminal output"
                style={styles.outputModalCloseButton}
                onPress={handleCloseOutputModal}>
                <Text style={styles.outputModalCloseText}>✕</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.outputModalBody}>
            {!activeSnapshot?.outputAvailable ? (
              <View style={styles.outputModalMessageWrap}>
                <Text
                  style={styles.outputUnavailableText}
                  testID="session-chat-output-modal-unavailable">
                  {activeSnapshot?.outputMessage ||
                    'Current terminal output is unavailable.'}
                </Text>
              </View>
            ) : outputTail && outputTail.totalLines === 0 ? (
              <View style={styles.outputModalMessageWrap}>
                <Text style={styles.outputEmptyText}>
                  Terminal output is empty.
                </Text>
              </View>
            ) : outputTail ? (
              <ScrollView
                style={styles.outputModalVerticalScroll}
                contentContainerStyle={styles.outputModalVerticalContent}
                showsVerticalScrollIndicator
                testID="session-chat-output-modal-vertical-scroll">
                {outputWrapEnabled ? (
                  <Text
                    selectable
                    style={[styles.outputMonoText, styles.outputMonoTextWrapped]}
                    testID="session-chat-output-modal-text">
                    {outputTail.visibleText}
                  </Text>
                ) : (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator
                    contentContainerStyle={styles.outputHorizontalContent}
                    testID="session-chat-output-modal-horizontal-scroll">
                    <Text
                      selectable
                      style={styles.outputMonoText}
                      testID="session-chat-output-modal-text">
                      {outputTail.visibleText}
                    </Text>
                  </ScrollView>
                )}
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

/**
 * Shared intervention bubble for user and agent turns: equal full-width compact geometry
 * with speaker color variants, compact top identity row above the bubble, and single bottom-right time.
 */
function ChatMessageBubble({
  item,
  speaker,
  formattedTime,
  speakerSwitch = false,
}: {
  item: SessionHistoryItem;
  speaker: 'user' | 'agent';
  formattedTime: string | null;
  speakerSwitch?: boolean;
}): React.JSX.Element {
  const isUser = speaker === 'user';

  return (
    <View
      style={[styles.messageRow, speakerSwitch && styles.speakerSwitchSpacing]}
      testID={`session-chat-item-${item.id}`}>
      <View
        style={[
          styles.messageIdentityRow,
          isUser ? styles.userIdentityRow : styles.agentIdentityRow,
        ]}
        testID={`session-chat-identity-${item.id}`}>
        {isUser ? (
          <View style={styles.userIdentityBadge}>
            <Text style={styles.userIdentityText}>YOU</Text>
          </View>
        ) : (
          <View
            accessibilityLabel="Agent"
            style={styles.agentIdentityBadge}>
            <SpawneaMarkIcon color="#c4b5fd" size={13} />
          </View>
        )}
      </View>

      <View
        style={[
          styles.messageBubble,
          isUser ? styles.userBubbleVariant : styles.agentBubbleVariant,
        ]}
        testID={`session-chat-bubble-${item.id}`}>
        <Text
          selectable
          style={[
            styles.messageText,
            isUser ? styles.userTextVariant : styles.agentTextVariant,
          ]}>
          {item.text}
        </Text>
        {item.textTruncated || formattedTime ? (
          <View style={styles.itemFooterRow}>
            {item.textTruncated ? (
              <View
                style={styles.truncatedBadge}
                testID={`session-chat-item-truncated-${item.id}`}>
                <Text style={styles.truncatedBadgeText}>Truncated by server</Text>
              </View>
            ) : null}
            {formattedTime ? (
              <Text
                style={styles.itemTimestampText}
                testID={`session-chat-item-time-${item.id}`}>
                {formattedTime}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ScreenSnapshotCard({
  item,
  formattedTime,
  speakerSwitch = false,
}: {
  item: SessionHistoryItem;
  formattedTime: string | null;
  speakerSwitch?: boolean;
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.screenSnapshotCard,
        speakerSwitch && styles.speakerSwitchSpacing,
      ]}
      testID={`session-chat-item-${item.id}`}>
      <View
        style={styles.screenSnapshotHeader}
        testID={`session-chat-screen-snapshot-${item.id}`}>
        <Text style={styles.screenSnapshotLabel}>Terminal screen snapshot</Text>
        {formattedTime ? (
          <Text
            style={styles.itemTimestampText}
            testID={`session-chat-item-time-${item.id}`}>
            {formattedTime}
          </Text>
        ) : null}
      </View>
      <Text selectable style={styles.screenSnapshotMonoText}>
        {item.text}
      </Text>
      {item.textTruncated ? (
        <View
          style={styles.truncatedBadge}
          testID={`session-chat-item-truncated-${item.id}`}>
          <Text style={styles.truncatedBadgeText}>Truncated by server</Text>
        </View>
      ) : null}
    </View>
  );
}

function ToolActivityCard({
  groupKey,
  items,
  hasTruncated,
  formattedTime,
  expanded,
  onToggle,
  speakerSwitch = false,
}: {
  groupKey: string;
  items: SessionHistoryItem[];
  hasTruncated: boolean;
  formattedTime: string | null;
  expanded: boolean;
  onToggle: (key: string) => void;
  speakerSwitch?: boolean;
}): React.JSX.Element {
  const countLabel =
    items.length === 1 ? '1 tool step' : `${items.length} tool steps`;

  return (
    <View
      style={[styles.toolWrapper, speakerSwitch && styles.speakerSwitchSpacing]}
      testID={`session-chat-tool-group-${groupKey}`}>
      <Pressable
        testID={`session-chat-tool-toggle-${groupKey}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Tool activity, ${countLabel}`}
        style={styles.toolToggle}
        onPress={() => onToggle(groupKey)}>
        <View style={styles.toolToggleLeft}>
          <ToolIcon color="#93c5fd" size={12} />
          <Text style={styles.toolToggleText}>
            Tool activity · {countLabel}
          </Text>
          {hasTruncated ? (
            <View style={styles.truncatedBadge}>
              <Text style={styles.truncatedBadgeText}>Truncated</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.toolToggleRight}>
          {formattedTime ? (
            <Text style={styles.itemTimestampText}>{formattedTime}</Text>
          ) : null}
          <ChevronIcon
            direction={expanded ? 'up' : 'down'}
            color="#8b949e"
            size={7}
          />
        </View>
      </Pressable>

      {expanded ? (
        <View
          style={styles.toolExpandedBody}
          testID={`session-chat-tool-body-${groupKey}`}>
          {items.map(toolItem => {
            const toolTime = formatItemTimestamp(toolItem.timestamp);
            return (
              <View
                key={toolItem.id}
                style={styles.toolItemRow}
                testID={`session-chat-item-${toolItem.id}`}>
                <Text selectable style={styles.toolItemText}>
                  {toolItem.text}
                </Text>
                <View style={styles.itemFooterRow}>
                  {toolItem.textTruncated ? (
                    <View
                      style={styles.truncatedBadge}
                      testID={`session-chat-item-truncated-${toolItem.id}`}>
                      <Text style={styles.truncatedBadgeText}>
                        Truncated by server
                      </Text>
                    </View>
                  ) : null}
                  {toolTime ? (
                    <Text style={styles.itemTimestampText}>{toolTime}</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function SubmissionBanner({
  submission,
  retryAllowed,
  retryBlockedReason,
  onRetry,
  onDiscard,
  onOpenSettings,
}: {
  submission: ComposerSubmission;
  retryAllowed: boolean;
  retryBlockedReason: string | null;
  onRetry: () => void;
  onDiscard: () => void;
  onOpenSettings?: () => void;
}): React.JSX.Element {
  const containerStyle =
    submission.status === 'delivered'
      ? styles.subBannerDelivered
      : submission.status === 'unknown'
        ? styles.subBannerUnknown
        : submission.status === 'failed'
          ? styles.subBannerFailed
          : styles.subBannerPending;

  const heading =
    submission.status === 'pending'
      ? 'Sending...'
      : submission.status === 'delivered'
        ? submission.replayed
          ? 'Delivered (replayed)'
          : 'Delivered'
        : submission.status === 'unknown'
          ? 'Delivery unknown'
          : 'Delivery failed';

  return (
    <View
      style={[styles.subBanner, containerStyle]}
      testID="session-chat-submission-banner">
      <View style={styles.subBannerHeader}>
        <Text
          style={styles.subBannerHeading}
          testID="session-chat-submission-status">
          {heading}
        </Text>
      </View>
      <Text
        style={styles.subBannerMessage}
        testID="session-chat-submission-message">
        {submission.message}
      </Text>

      {submission.status === 'unknown' || submission.status === 'failed' ? (
        <View style={styles.subBannerActions}>
          {submission.authRejected && onOpenSettings ? (
            <Pressable
              testID="session-chat-submission-settings-button"
              accessibilityRole="button"
              style={styles.subActionPrimary}
              onPress={onOpenSettings}>
              <Text style={styles.subActionPrimaryText}>Open Settings</Text>
            </Pressable>
          ) : null}

          {!submission.conflictDifferentPrompt ? (
            <Pressable
              testID="session-chat-retry-send-button"
              accessibilityRole="button"
              accessibilityState={{ disabled: !retryAllowed }}
              disabled={!retryAllowed}
              style={[
                styles.subActionPrimary,
                !retryAllowed && styles.subActionDisabled,
              ]}
              onPress={onRetry}>
              <Text style={styles.subActionPrimaryText}>
                Retry (same ID)
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            testID="session-chat-discard-send-button"
            accessibilityRole="button"
            style={styles.subActionSecondary}
            onPress={onDiscard}>
            <Text style={styles.subActionSecondaryText}>Discard</Text>
          </Pressable>
        </View>
      ) : null}

      {(submission.status === 'unknown' || submission.status === 'failed') &&
      !retryAllowed &&
      retryBlockedReason ? (
        <Text style={styles.subRetryHint}>{retryBlockedReason}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screenRoot: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  headerBlock: {
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 4,
    backgroundColor: '#0d1117',
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleCol: {
    flex: 1,
    gap: 3,
  },
  headerTitle: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  headerTask: {
    fontSize: 11,
    lineHeight: 15,
    color: '#9ca3af',
  },
  headerMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 8,
    rowGap: 3,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaBranchChip: {
    backgroundColor: 'rgba(147, 197, 253, 0.1)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  metaText: {
    fontSize: 11,
    color: '#8b949e',
    fontWeight: '500',
  },
  metaBranchText: {
    fontSize: 11,
    color: '#93c5fd',
    fontWeight: '600',
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  connectionBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badgeSpinner: {
    marginLeft: 2,
  },
  pollPopup: {
    alignSelf: 'flex-end',
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pollPopupText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#c9d1d9',
  },
  bodyWrap: {
    flex: 1,
    position: 'relative',
  },
  topDeliveredBannerWrap: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    zIndex: 20,
  },
  scroll: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  scrollContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 20,
    gap: 12,
  },
  signalsBar: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#21262d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 3,
  },
  signalsText: {
    fontSize: 11,
    color: '#8b949e',
  },
  staleBanner: {
    backgroundColor: '#271e09',
    borderWidth: 1,
    borderColor: '#b45309',
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  bannerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  staleBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fbbf24',
  },
  staleBannerHeading: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fde68a',
  },
  staleBannerBody: {
    fontSize: 12,
    lineHeight: 17,
    color: '#fcd34d',
  },
  card: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  unavailableCard: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#6b7280',
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  cardHeading: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  cardBody: {
    fontSize: 13,
    lineHeight: 19,
    color: '#9ca3af',
  },
  errorCard: {
    backgroundColor: '#261114',
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  errorCardHeading: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fecaca',
  },
  errorCardBody: {
    fontSize: 13,
    lineHeight: 19,
    color: '#fca5a5',
  },
  primaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#7c3aed',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  primaryButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
  },
  turnsContainer: {
    gap: 20,
  },
  turnGroup: {
    gap: 8,
  },
  speakerSwitchSpacing: {
    marginTop: 10,
  },
  messageRow: {
    width: '100%',
    flexDirection: 'column',
    gap: 4,
  },
  messageIdentityRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
  },
  userIdentityRow: {
    justifyContent: 'flex-end',
  },
  agentIdentityRow: {
    justifyContent: 'flex-start',
  },
  userIdentityBadge: {
    height: 20,
    minWidth: 32,
    borderRadius: 10,
    backgroundColor: '#1e1b4b',
    borderWidth: 1,
    borderColor: '#4338ca',
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userIdentityText: {
    fontSize: 8,
    fontWeight: '800',
    color: '#c7d2fe',
    letterSpacing: 0.4,
  },
  agentIdentityBadge: {
    height: 20,
    minWidth: 26,
    borderRadius: 10,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#4c1d95',
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageBubble: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 4,
  },
  userBubbleVariant: {
    backgroundColor: '#1a1f36',
    borderColor: '#3730a3',
  },
  agentBubbleVariant: {
    backgroundColor: '#161b22',
    borderColor: '#30363d',
  },
  messageText: {
    fontSize: 14,
    lineHeight: 20,
  },
  userTextVariant: {
    color: '#eef2ff',
  },
  agentTextVariant: {
    color: '#e6edf3',
  },
  screenSnapshotCard: {
    backgroundColor: '#090d13',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  screenSnapshotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  screenSnapshotLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#93c5fd',
  },
  screenSnapshotMonoText: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    fontSize: 11,
    lineHeight: 16,
    color: '#d1d5db',
  },
  itemFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 8,
  },
  itemTimestampText: {
    marginLeft: 'auto',
    fontSize: 11,
    color: '#8b949e',
  },
  truncatedBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderWidth: 1,
    borderColor: '#d97706',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  truncatedBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fde68a',
  },
  toolWrapper: {
    marginLeft: 34,
    marginRight: 32,
    backgroundColor: '#11161d',
    borderWidth: 1,
    borderColor: '#21262d',
    borderRadius: 10,
    overflow: 'hidden',
  },
  toolToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  toolToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    flex: 1,
  },
  toolToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#c9d1d9',
  },
  toolToggleRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toolExpandedBody: {
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    padding: 10,
    gap: 8,
    backgroundColor: '#090d13',
  },
  toolItemRow: {
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#161b22',
    paddingBottom: 6,
  },
  toolItemText: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    color: '#9ca3af',
  },
  outputSection: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  outputHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6,
  },
  outputHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  outputTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  outputPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  outputPillLive: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderColor: '#059669',
  },
  outputPillStale: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: '#d97706',
  },
  outputPillUnavailable: {
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderColor: '#dc2626',
  },
  outputPillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  outputPillDotLive: {
    backgroundColor: '#34d399',
  },
  outputPillDotStale: {
    backgroundColor: '#fbbf24',
  },
  outputPillDotUnavailable: {
    backgroundColor: '#f87171',
  },
  outputPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#e6edf3',
  },
  outputExpandHeaderButton: {
    backgroundColor: '#21262d',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  outputExpandHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#c4b5fd',
  },
  outputUnavailableText: {
    fontSize: 12,
    lineHeight: 17,
    color: '#fca5a5',
  },
  outputEmptyText: {
    fontSize: 12,
    color: '#8b949e',
  },
  outputTerminalBox: {
    backgroundColor: '#090d13',
    borderWidth: 1,
    borderColor: '#21262d',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  outputInlineVerticalScroll: {
    maxHeight: 176,
  },
  outputInlineVerticalContent: {
    paddingBottom: 2,
  },
  outputHorizontalContent: {
    minWidth: '100%',
  },
  outputMonoText: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    fontSize: 11,
    lineHeight: 16,
    color: '#d1d5db',
  },
  outputMonoTextWrapped: {
    flexShrink: 1,
    width: '100%',
  },
  outputModalRoot: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  outputModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    backgroundColor: '#161b22',
  },
  outputModalTitleCol: {
    flex: 1,
    gap: 2,
  },
  outputModalTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  outputModalSubtitle: {
    fontSize: 11,
    color: '#8b949e',
  },
  outputModalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  outputModalWrapButton: {
    backgroundColor: '#21262d',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  outputModalWrapButtonActive: {
    backgroundColor: '#2e1065',
    borderColor: '#7c3aed',
  },
  outputModalWrapText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#c9d1d9',
  },
  outputModalWrapTextActive: {
    color: '#ede9fe',
  },
  outputModalCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#21262d',
    borderWidth: 1,
    borderColor: '#30363d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  outputModalCloseText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  outputModalBody: {
    flex: 1,
    backgroundColor: '#090d13',
  },
  outputModalMessageWrap: {
    padding: 16,
  },
  outputModalVerticalScroll: {
    flex: 1,
  },
  outputModalVerticalContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  composerDock: {
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    backgroundColor: '#0d1117',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
  },
  subBanner: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 6,
  },
  subBannerPending: {
    backgroundColor: '#161b22',
    borderColor: '#4c1d95',
  },
  subBannerDelivered: {
    backgroundColor: '#0e2820',
    borderColor: '#059669',
  },
  subBannerUnknown: {
    backgroundColor: '#271e09',
    borderColor: '#d97706',
  },
  subBannerFailed: {
    backgroundColor: '#261114',
    borderColor: '#dc2626',
  },
  subBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  subBannerHeading: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  subBannerMessage: {
    fontSize: 12,
    lineHeight: 17,
    color: '#e6edf3',
  },
  subBannerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
  },
  subActionPrimary: {
    backgroundColor: '#7c3aed',
    borderRadius: 7,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  subActionDisabled: {
    opacity: 0.45,
  },
  subActionPrimaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ffffff',
  },
  subActionSecondary: {
    backgroundColor: '#21262d',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#30363d',
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  subActionSecondaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#c9d1d9',
  },
  subRetryHint: {
    fontSize: 11,
    color: '#fcd34d',
  },
  gateBanner: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  gateBannerText: {
    fontSize: 12,
    color: '#fbbf24',
  },
  composerInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  composerInput: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: '#f0f6fc',
  },
  composerInputDisabled: {
    opacity: 0.55,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#5b5cf6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#21262d',
  },
});
