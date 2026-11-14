import { NavigationContext } from '@react-navigation/native';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { defaultApiClient, SpawneaApiClient } from '../api/client';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../storage/sessionCredentialCache';

interface SessionChatNavigationProp {
  setParams?: (params: { sessionId?: string }) => void;
  addListener?: (event: 'focus', listener: () => void) => () => void;
}

interface SessionChatScreenProps {
  route?: {
    params?: {
      sessionId?: string;
    };
  };
  navigation?: SessionChatNavigationProp;
  sessionId?: string;
  apiClient?: SpawneaApiClient;
  credentialCache?: SessionCredentialCache;
}

function isForegroundAppState(state: string | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

export function SessionChatScreen({
  route,
  navigation: navigationProp,
  sessionId: directSessionId,
  apiClient = defaultApiClient,
  credentialCache = defaultSessionCredentialCache,
}: SessionChatScreenProps): React.JSX.Element {
  const navigationContext = useContext(NavigationContext) as
    | SessionChatNavigationProp
    | undefined;
  const navigation = navigationProp ?? navigationContext;
  const routeSessionId = route?.params?.sessionId;
  const rawSessionId = directSessionId ?? routeSessionId;

  const [isForeground, setIsForeground] = useState<boolean>(() =>
    isForegroundAppState(AppState.currentState),
  );
  const [hasUnlockedCredential, setHasUnlockedCredential] = useState<boolean>(
    () => credentialCache.hasUnlockedKey(apiClient),
  );

  const routeSessionIdRef = useRef(routeSessionId);
  routeSessionIdRef.current = routeSessionId;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;

  const clearRouteSessionId = useCallback(() => {
    if (routeSessionIdRef.current !== undefined) {
      routeSessionIdRef.current = undefined;
      navigationRef.current?.setParams?.({ sessionId: undefined });
    }
  }, []);

  useEffect(() => {
    const syncSecurityState = () => {
      const nextForeground = isForegroundAppState(AppState.currentState);
      const nextUnlocked = credentialCache.hasUnlockedKey(apiClient);
      setIsForeground(nextForeground);
      setHasUnlockedCredential(nextUnlocked);
      if (!nextForeground || !nextUnlocked) {
        clearRouteSessionId();
      }
    };

    syncSecurityState();

    const appStateSub = AppState.addEventListener('change', nextState => {
      const nextForeground = isForegroundAppState(nextState);
      setIsForeground(nextForeground);
      if (!nextForeground) {
        setHasUnlockedCredential(false);
        clearRouteSessionId();
        return;
      }
      setHasUnlockedCredential(credentialCache.hasUnlockedKey(apiClient));
    });

    const unsubscribeCleared = credentialCache.onCleared(() => {
      setHasUnlockedCredential(false);
      clearRouteSessionId();
    });

    const unsubscribeTerminalAuth = credentialCache.onTerminalInvalidated(() => {
      setHasUnlockedCredential(false);
      clearRouteSessionId();
    });

    const unsubscribeTerminalCleared = credentialCache.onTerminalLockCleared(
      () => {
        setHasUnlockedCredential(credentialCache.hasUnlockedKey(apiClient));
      },
    );

    const unsubscribeFocus = navigation?.addListener?.(
      'focus',
      syncSecurityState,
    );

    return () => {
      appStateSub?.remove?.();
      unsubscribeCleared();
      unsubscribeTerminalAuth();
      unsubscribeTerminalCleared();
      unsubscribeFocus?.();
    };
  }, [apiClient, clearRouteSessionId, credentialCache, navigation]);

  const canShowSessionId =
    isForeground &&
    hasUnlockedCredential &&
    isForegroundAppState(AppState.currentState) &&
    credentialCache.hasUnlockedKey(apiClient);
  const visibleSessionId = canShowSessionId ? rawSessionId : undefined;

  return (
    <View style={styles.container} testID="session-chat-screen">
      <Text style={styles.title}>Session / Chat</Text>
      {!canShowSessionId ? (
        <View style={styles.lockedCard} testID="session-chat-locked-card">
          <Text style={styles.lockedHeading}>Biometric unlock required</Text>
          <Text style={styles.cardBody} testID="session-chat-locked-message">
            Locked. Unlock from Dashboard to view this session.
          </Text>
        </View>
      ) : visibleSessionId ? (
        <View style={styles.selectedCard}>
          <Text style={styles.selectedLabel}>Selected session</Text>
          <Text style={styles.sessionIdText} testID="session-chat-session-id">
            Session ID: {visibleSessionId}
          </Text>
        </View>
      ) : null}
      <View style={styles.card}>
        <Text style={styles.cardHeading}>Not available yet</Text>
        <Text style={styles.cardBody}>
          Conversation history, live terminal output, and prompt submission will
          be added in a later slice.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
  },
  selectedCard: {
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    padding: 14,
    gap: 4,
  },
  lockedCard: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    padding: 16,
    gap: 6,
  },
  lockedHeading: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
  },
  selectedLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1d4ed8',
    textTransform: 'uppercase',
  },
  sessionIdText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    gap: 8,
  },
  cardHeading: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#475569',
  },
});
