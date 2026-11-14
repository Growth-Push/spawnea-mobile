import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContext } from '@react-navigation/native';
import React from 'react';
import { AppState, NativeModules, RefreshControl, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { HttpTransport, SpawneaApiClient } from '../src/api/client';
import {
  computeDistributionSummary,
  mapApiFailureToDashboardError,
  partitionDashboardSessions,
  sortDashboardSessions,
} from '../src/dashboard/dashboardModel';
import { DashboardScreen } from '../src/screens/DashboardScreen';
import { SessionChatScreen } from '../src/screens/SessionChatScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../src/storage/sessionCredentialCache';
import { makeSessionFixture } from './apiClient.test';

const TEST_URL = 'https://workstation.tailnet.ts.net:5757';
const TEST_KEY = 'dummy-dashboard-test-key-never-rendered';

const keystore = NativeModules.SpawneaKeystore as {
  getCapability: jest.Mock;
  getCredentialState: jest.Mock;
  hasKey: jest.Mock;
  saveCredentials: jest.Mock;
  updateServerUrl: jest.Mock;
  readKey: jest.Mock;
  deleteKey: jest.Mock;
};

async function flushAsync(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function getAllText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const children = node.props.children;
      return Array.isArray(children) ? children.join('') : String(children ?? '');
    })
    .join('\n');
}

function setupAppStateSpy() {
  const listeners = new Set<(state: 'active' | 'background' | 'inactive') => void>();
  let currentState: 'active' | 'background' | 'inactive' = 'active';
  const prevDescriptor = Object.getOwnPropertyDescriptor(
    AppState,
    'currentState',
  );
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => currentState,
  });
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, cb) => {
      const typedCb = cb as (
        state: 'active' | 'background' | 'inactive',
      ) => void;
      listeners.add(typedCb);
      return {
        remove: jest.fn(() => {
          listeners.delete(typedCb);
        }),
      };
    });

  return {
    emit(next: 'active' | 'background' | 'inactive') {
      currentState = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    restore() {
      spy.mockRestore();
      if (prevDescriptor) {
        Object.defineProperty(AppState, 'currentState', prevDescriptor);
      }
    },
  };
}

function mockConfiguredKeystore(serverUrl = TEST_URL, apiKey = TEST_KEY) {
  keystore.getCredentialState.mockResolvedValue({
    serverUrl,
    hasKey: true,
    incomplete: false,
  });
  keystore.readKey.mockResolvedValue(apiKey);
}

describe('dashboardModel pure helpers', () => {
  test('computeDistributionSummary maps all 7 canonical statuses into 4 categories with total equal to sum', () => {
    const fixtures = [
      makeSessionFixture({ id: 'sess-1', status: 'needs_input' }),
      makeSessionFixture({ id: 'sess-2', status: 'working' }),
      makeSessionFixture({ id: 'sess-3', status: 'starting' }),
      makeSessionFixture({ id: 'sess-4', status: 'idle' }),
      makeSessionFixture({ id: 'sess-5', status: 'done' }),
      makeSessionFixture({ id: 'sess-6', status: 'error' }),
      makeSessionFixture({ id: 'sess-7', status: 'disconnected' }),
    ];

    const summary = computeDistributionSummary(fixtures);
    expect(summary.total).toBe(7);

    const byCategory = Object.fromEntries(
      summary.categories.map(item => [item.category, item.count]),
    );
    expect(byCategory).toEqual({
      'need-input': 1,
      running: 2,
      'done/idle': 2,
      error: 2,
    });
    const sum = summary.categories.reduce((acc, item) => acc + item.count, 0);
    expect(sum).toBe(summary.total);
  });

  test('computeDistributionSummary counts unrecognized backend statuses separately without adding a fifth category', () => {
    const fixtures = [
      makeSessionFixture({ id: 'sess-1', status: 'idle' }),
      makeSessionFixture({ id: 'sess-2', status: 'custom_backend_state' }),
    ];

    const summary = computeDistributionSummary(fixtures);
    expect(summary.total).toBe(2);
    expect(summary.unknownCount).toBe(1);
    expect(summary.categories).toHaveLength(4);
    expect(
      Object.fromEntries(summary.categories.map(c => [c.category, c.count])),
    ).toEqual({
      'need-input': 0,
      running: 0,
      'done/idle': 1,
      error: 0,
    });
  });

  test('sortDashboardSessions and partitionDashboardSessions put needs_input first by recency', () => {
    const olderNeedsInput = makeSessionFixture({
      id: 'sess-ni-old',
      status: 'needs_input',
      lastActivityAt: '2026-11-13T10:00:00.000Z',
    });
    const newerNeedsInput = makeSessionFixture({
      id: 'sess-ni-new',
      status: 'needs_input',
      lastActivityAt: '2026-11-13T12:00:00.000Z',
    });
    const veryRecentWorking = makeSessionFixture({
      id: 'sess-work-recent',
      status: 'working',
      lastActivityAt: '2026-11-13T13:00:00.000Z',
    });
    const olderIdle = makeSessionFixture({
      id: 'sess-idle-old',
      status: 'idle',
      lastActivityAt: '2026-11-13T09:00:00.000Z',
    });

    const sorted = sortDashboardSessions([
      olderIdle,
      olderNeedsInput,
      veryRecentWorking,
      newerNeedsInput,
    ]);

    expect(sorted.map(s => s.id)).toEqual([
      'sess-ni-new',
      'sess-ni-old',
      'sess-work-recent',
      'sess-idle-old',
    ]);

    const partitioned = partitionDashboardSessions([
      olderIdle,
      olderNeedsInput,
      veryRecentWorking,
      newerNeedsInput,
    ]);
    expect(partitioned.needsInput.map(s => s.id)).toEqual([
      'sess-ni-new',
      'sess-ni-old',
    ]);
    expect(partitioned.otherSessions.map(s => s.id)).toEqual([
      'sess-work-recent',
      'sess-idle-old',
    ]);
  });

  test('mapApiFailureToDashboardError categorizes auth, rate limit, offline, and server errors', () => {
    expect(
      mapApiFailureToDashboardError({
        ok: false,
        category: 'unauthorized',
        status: 401,
        retryAfterSeconds: null,
      }).kind,
    ).toBe('auth_rejected');

    expect(
      mapApiFailureToDashboardError({
        ok: false,
        category: 'polling_paused_auth',
        status: 401,
        retryAfterSeconds: null,
      }).kind,
    ).toBe('auth_rejected');

    expect(
      mapApiFailureToDashboardError({
        ok: false,
        category: 'rate_limited',
        status: 429,
        retryAfterSeconds: 30,
      }).kind,
    ).toBe('rate_limited');

    for (const category of ['network_error', 'timeout', 'tls_error'] as const) {
      expect(
        mapApiFailureToDashboardError({
          ok: false,
          category,
          status: null,
          retryAfterSeconds: null,
        }).kind,
      ).toBe('offline');
    }

    for (const category of ['server_error', 'malformed_response'] as const) {
      expect(
        mapApiFailureToDashboardError({
          ok: false,
          category,
          status: 500,
          retryAfterSeconds: null,
        }).kind,
      ).toBe('server_error');
    }
  });
});

describe('SessionCredentialCache', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  test('unlocks once per foreground session, clears on background, and never persists', async () => {
    const appState = setupAppStateSpy();
    const cache = new SessionCredentialCache();
    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });
    mockConfiguredKeystore();

    try {
      const first = await cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.fromCache).toBe(false);
        expect(first.credentials.apiKey).toBe(TEST_KEY);
      }
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      const second = await cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.fromCache).toBe(true);
      }
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      // Leaving foreground clears the in-memory reference immediately.
      appState.emit('background');
      expect(cache.getCachedCredentials(client)).toBeNull();

      appState.emit('active');
      const third = await cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      expect(third.ok).toBe(true);
      expect(keystore.readKey).toHaveBeenCalledTimes(2);
    } finally {
      cache.dispose();
      appState.restore();
    }
  });

  test('deduplicates concurrent unlock requests into one Keystore prompt', async () => {
    const appState = setupAppStateSpy();
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: TEST_URL,
      hasKey: true,
      incomplete: false,
    });
    let resolveRead!: (value: string) => void;
    keystore.readKey.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          resolveRead = resolve;
        }),
    );

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(true);

    try {
      const p1 = cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      const p2 = cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      await flushAsync();
      expect(keystore.getCredentialState).toHaveBeenCalledTimes(1);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      resolveRead(TEST_KEY);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual({
        ok: true,
        fromCache: false,
        credentials: { serverUrl: TEST_URL, apiKey: TEST_KEY },
      });
      expect(r2).toEqual({
        ok: true,
        fromCache: false,
        credentials: { serverUrl: TEST_URL, apiKey: TEST_KEY },
      });
    } finally {
      cache.dispose();
      appState.restore();
    }
  });

  test('rejects pending unlock and skips caching when backgrounded mid-prompt', async () => {
    const appState = setupAppStateSpy();
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: TEST_URL,
      hasKey: true,
      incomplete: false,
    });
    let resolveRead!: (value: string) => void;
    keystore.readKey.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          resolveRead = resolve;
        }),
    );

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(true);

    try {
      const pending = cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      await flushAsync();
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      appState.emit('background');
      resolveRead(TEST_KEY);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('backgrounded');
      }
      expect(cache.getCachedCredentials(client)).toBeNull();
    } finally {
      cache.dispose();
      appState.restore();
    }
  });

  test('rejects pending unlock and skips caching when credentials change mid-prompt', async () => {
    const appState = setupAppStateSpy();
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: TEST_URL,
      hasKey: true,
      incomplete: false,
    });
    let resolveRead!: (value: string) => void;
    keystore.readKey.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          resolveRead = resolve;
        }),
    );

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(true);

    try {
      const pending = cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      await flushAsync();
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      client.notifyCredentialsChanged();
      cache.invalidateForCredentialChange();
      resolveRead(TEST_KEY);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('credential_changed');
      }
      expect(cache.getCachedCredentials(client)).toBeNull();
    } finally {
      cache.dispose();
      appState.restore();
    }
  });
});

describe('DashboardScreen', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    await AsyncStorage.clear();
    defaultSessionCredentialCache.invalidateForCredentialChange();
    keystore.getCapability.mockResolvedValue({
      biometryAvailable: true,
      biometryType: 'Fingerprint',
      status: 'available',
    });
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: null,
      hasKey: false,
      incomplete: false,
    });
  });

  afterEach(() => {
    defaultSessionCredentialCache.invalidateForCredentialChange();
    jest.useRealTimers();
  });

  test('shows not_configured state honestly with no fake sessions or HTTP calls', async () => {
    const request = jest.fn();
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);
    const onOpenSettings = jest.fn();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={onOpenSettings}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      expect(
        renderer.root.findByProps({ testID: 'dashboard-not-configured-card' }),
      ).toBeDefined();
      expect(request).not.toHaveBeenCalled();
      expect(keystore.readKey).not.toHaveBeenCalled();
      expect(getAllText(renderer)).not.toContain('sess-');

      renderer.root
        .findByProps({ testID: 'dashboard-config-open-settings-button' })
        .props.onPress();
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('renders real empty state (0 sessions) without synthetic sessions', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      expect(
        renderer.root.findByProps({ testID: 'dashboard-empty-card' }),
      ).toBeDefined();
      expect(
        String(
          renderer.root.findByProps({ testID: 'dashboard-total-sessions' })
            .props.children.join(''),
        ),
      ).toContain('0');
      expect(getAllText(renderer)).not.toContain('sess-');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('emphasizes needs_input sessions at top, shows host/harness/branch without visible ID, and opens Session/Chat with ID', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          makeSessionFixture({
            id: 'sess-idle-a',
            name: 'Idle Worker',
            task: 'Run scheduled checks',
            status: 'idle',
            project: { id: 'p-1', name: 'Project Alpha' },
            host: { id: 'h-1', name: 'Host One' },
            harness: { id: 'h-codex', name: 'Codex CLI', command: 'codex' },
            worktree: { branch: 'chore/checks' },
            lastActivityAt: '2026-11-13T12:10:00.000Z',
          }),
          makeSessionFixture({
            id: 'sess-input-a',
            name: 'Approve Deployment',
            task: 'Confirm migration step',
            status: 'needs_input',
            project: { id: 'p-2', name: 'Project Beta' },
            host: { id: 'h-2', name: 'Host Two' },
            harness: { id: 'h-claude', name: 'Claude Code', command: 'claude' },
            worktree: { branch: 'feat/deploy' },
            lastActivityAt: '2026-11-13T12:05:00.000Z',
          }),
        ],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);
    const onOpenSessionChat = jest.fn();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={onOpenSessionChat}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      const needsInputSection = renderer.root.findByProps({
        testID: 'dashboard-needs-input-section',
      });
      const needsInputText = needsInputSection
        .findAllByType(Text)
        .map(node =>
          Array.isArray(node.props.children)
            ? node.props.children.join('')
            : String(node.props.children ?? ''),
        )
        .join('\n');
      expect(needsInputText).toContain('Approve Deployment');
      expect(needsInputText).not.toContain('sess-input-a');

      const text = getAllText(renderer);
      expect(text).toContain('Host Two');
      expect(text).toContain('Claude Code');
      expect(text).toContain('feat/deploy');
      expect(text).toContain('Host One');
      expect(text).toContain('Codex CLI');
      expect(text).toContain('chore/checks');
      expect(text).not.toContain('sess-input-a');
      expect(text).not.toContain('sess-idle-a');
      expect(text.indexOf('Approve Deployment')).toBeLessThan(
        text.indexOf('Idle Worker'),
      );
      expect(text).not.toContain(TEST_KEY);

      renderer.root
        .findByProps({ testID: 'dashboard-session-card-sess-input-a' })
        .props.onPress();
      expect(onOpenSessionChat).toHaveBeenCalledWith('sess-input-a');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('transitions to stale without timestamps or age on refresh failure, never replaces with empty list, and recovers on pull-to-refresh', async () => {
    mockConfiguredKeystore();
    let currentTimeMs = 1_700_000_000_000;
    const now = () => currentTimeMs;

    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-live-1',
              name: 'Build Monitor',
              status: 'working',
            }),
          ],
        }),
      })
      .mockRejectedValueOnce({ code: 'E_NETWORK_ERROR' })
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-live-1',
              name: 'Build Monitor',
              status: 'done',
            }),
          ],
        }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
          now={now}
        />,
      );
      await flushAsync();
    });

    try {
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      // Next poll fails with offline error -> becomes STALE, keeps Build Monitor without exposing ID or age.
      currentTimeMs += 10000;
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10000);
        await flushAsync();
      });

      const staleStatus = renderer.root.findByProps({
        testID: 'dashboard-connection-status',
      }).props.children;
      expect(staleStatus).toContain('Stale');
      expect(staleStatus).not.toBe('Live');
      expect(
        renderer.root.findByProps({ testID: 'dashboard-stale-banner' }),
      ).toBeDefined();
      const staleText = getAllText(renderer);
      expect(staleText).toContain('Build Monitor');
      expect(staleText).toContain('Not live');
      expect(staleText).not.toContain('Age:');
      expect(staleText).not.toContain('Last successful update');
      expect(staleText).not.toContain('sess-live-1');

      // Manual pull-to-refresh recovers back to Live without re-prompting biometrics.
      const scroll = renderer.root.findByProps({ testID: 'dashboard-screen' });
      const refreshControl = scroll.props
        .refreshControl as React.ReactElement<
        React.ComponentProps<typeof RefreshControl>
      >;
      currentTimeMs += 1000;
      await ReactTestRenderer.act(async () => {
        refreshControl.props.onRefresh?.();
        await flushAsync();
      });

      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-stale-banner' }),
      ).toHaveLength(0);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('pauses polling in background, clears key, and stops prompting until resume', async () => {
    const appState = setupAppStateSpy();
    mockConfiguredKeystore();
    const request: jest.MockedFunction<HttpTransport['request']> = jest
      .fn()
      .mockResolvedValue({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [makeSessionFixture({ id: 'sess-bg-1', status: 'working' })],
        }),
      });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
        />,
      );
      await flushAsync();
    });

    try {
      expect(request).toHaveBeenCalledTimes(1);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      // Foreground poll uses cached key without re-prompting biometrics.
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      // Backgrounding clears memory cache and session snapshot, locks Dashboard, and stops polling.
      await ReactTestRenderer.act(async () => {
        appState.emit('background');
        await flushAsync();
      });
      expect(cache.getCachedCredentials(client)).toBeNull();
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(60000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      // Returning to foreground unlocks once and resumes live polling.
      await ReactTestRenderer.act(async () => {
        appState.emit('active');
        await flushAsync();
      });
      expect(keystore.readKey).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(3);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
      appState.restore();
    }
  });

  test('honors 401 polling pause without retrying or spamming biometrics', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 401,
      retryAfter: null,
      body: JSON.stringify({ error: 'unauthorized' }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
        />,
      );
      await flushAsync();
    });

    try {
      expect(request).toHaveBeenCalledTimes(1);
      expect(client.isPollingPausedForAuth()).toBe(true);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Auth rejected (HTTP 401)');

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(60000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('honors 429 per-origin cooldown on both polling and manual refresh before retrying', async () => {
    mockConfiguredKeystore();
    let currentTimeMs = 1_700_000_000_000;
    const now = () => currentTimeMs;

    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '30',
        body: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
          now={now}
        />,
      );
      await flushAsync();
    });

    try {
      expect(request).toHaveBeenCalledTimes(1);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Rate limited (HTTP 429)');

      // During 30s cooldown, advancing 15s and manual refresh still must NOT hit transport.
      currentTimeMs += 15000;
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(15000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);

      const scroll = renderer.root.findByProps({ testID: 'dashboard-screen' });
      const refreshControl = scroll.props
        .refreshControl as React.ReactElement<
        React.ComponentProps<typeof RefreshControl>
      >;
      await ReactTestRenderer.act(async () => {
        refreshControl.props.onRefresh?.();
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);

      // Once 30s cooldown elapses, scheduled poll calls transport and recovers.
      currentTimeMs += 15000;
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(15000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('does not spam biometric prompt when user cancels unlock', async () => {
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: TEST_URL,
      hasKey: true,
      incomplete: false,
    });
    keystore.readKey.mockRejectedValue({ code: 'E_AUTH_CANCELED' });

    const request = jest.fn();
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
        />,
      );
      await flushAsync();
    });

    try {
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-locked-card' }),
      ).toBeDefined();

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(30000);
        await flushAsync();
      });
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();

      // Tapping Unlock retries explicitly.
      keystore.readKey.mockResolvedValueOnce(TEST_KEY);
      request.mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

      await ReactTestRenderer.act(async () => {
        await renderer.root
          .findByProps({ testID: 'dashboard-unlock-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(keystore.readKey).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('distinguishes offline and server_error initial states', async () => {
    mockConfiguredKeystore();
    const request = jest
      .fn()
      .mockRejectedValueOnce({ code: 'E_NETWORK_ERROR' })
      .mockResolvedValueOnce({ status: 503, retryAfter: null, body: '' });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
        />,
      );
      await flushAsync();
    });

    try {
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Offline / unreachable');

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10000);
        await flushAsync();
      });
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Server error');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('navigates from App Dashboard session card to SessionChatScreen showing stable session ID', async () => {
    mockConfiguredKeystore();
    (NativeModules as { SpawneaHttp?: unknown }).SpawneaHttp = {
      getConstants: () => ({ allowDebugLoopback: false }),
      request: jest.fn().mockResolvedValue({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-nav-99',
              name: 'Navigation Target',
              status: 'idle',
            }),
          ],
        }),
      }),
    };

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(<App />);
        await flushAsync(8);
      });

      const sessionCard = renderer.root.findByProps({
        testID: 'dashboard-session-card-sess-nav-99',
      });
      await ReactTestRenderer.act(async () => {
        sessionCard.props.onPress();
        await flushAsync(8);
      });

      const chatIdText = renderer.root
        .findByProps({ testID: 'session-chat-session-id' })
        .props.children.join('');
      expect(chatIdText).toContain('sess-nav-99');
    } finally {
      delete (NativeModules as { SpawneaHttp?: unknown }).SpawneaHttp;
      if (renderer) {
        await ReactTestRenderer.act(async () => {
          renderer.unmount();
        });
      }
    }
  });

  test('keeps prior sessions as stale on 401 and provides navigation to Sessions and Settings', async () => {
    mockConfiguredKeystore();
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-stale-401',
              name: 'Active Task',
              status: 'working',
            }),
          ],
        }),
      })
      .mockResolvedValueOnce({
        status: 401,
        retryAfter: null,
        body: JSON.stringify({ error: 'unauthorized' }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);
    const onOpenSessions = jest.fn();
    const onOpenSettings = jest.fn();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={onOpenSettings}
          onOpenSessions={onOpenSessions}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
        />,
      );
      await flushAsync();
    });

    try {
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10000);
        await flushAsync();
      });

      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Stale · Auth rejected');
      expect(getAllText(renderer)).toContain('Active Task');
      expect(getAllText(renderer)).not.toContain('sess-stale-401');
      expect(client.isPollingPausedForAuth()).toBe(true);

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(30000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(2);

      renderer.root
        .findByProps({ testID: 'dashboard-stale-settings-button' })
        .props.onPress();
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('resets pull-to-refresh refreshing state when blurred while a 401 refresh is in flight', async () => {
    mockConfiguredKeystore();
    let resolveDeferred!: (resp: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [makeSessionFixture({ id: 'sess-blur-1' })],
        }),
      })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveDeferred = resolve;
          }),
      );

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    const listeners = new Map<'focus' | 'blur', Set<() => void>>();
    let focused = true;
    const mockNav = {
      isFocused: () => focused,
      addListener: jest.fn((event: 'focus' | 'blur', cb: () => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)?.add(cb);
        return () => {
          listeners.get(event)?.delete(cb);
        };
      }),
    };
    const emitNav = (event: 'focus' | 'blur') => {
      focused = event === 'focus';
      listeners.get(event)?.forEach(cb => cb());
    };

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <NavigationContext.Provider value={mockNav as never}>
          <DashboardScreen
            onOpenSettings={jest.fn()}
            onOpenSessions={jest.fn()}
            onOpenSessionChat={jest.fn()}
            apiClient={client}
            credentialCache={cache}
            allowDebugLoopback={false}
          />
        </NavigationContext.Provider>,
      );
      await flushAsync();
    });

    try {
      const getRefreshControl = () =>
        renderer.root.findByProps({ testID: 'dashboard-screen' }).props
          .refreshControl as React.ReactElement<
          React.ComponentProps<typeof RefreshControl>
        >;
      expect(getRefreshControl().props.refreshing).toBe(false);

      // Start manual pull-to-refresh, then blur before the pending request resolves 401.
      await ReactTestRenderer.act(async () => {
        getRefreshControl().props.onRefresh?.();
        await flushAsync(2);
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(getRefreshControl().props.refreshing).toBe(true);

      await ReactTestRenderer.act(async () => {
        emitNav('blur');
        await flushAsync(2);
      });
      expect(getRefreshControl().props.refreshing).toBe(false);

      await ReactTestRenderer.act(async () => {
        resolveDeferred({
          status: 401,
          retryAfter: null,
          body: JSON.stringify({ error: 'unauthorized' }),
        });
        await flushAsync();
      });

      await ReactTestRenderer.act(async () => {
        emitNav('focus');
        await flushAsync();
      });
      expect(getRefreshControl().props.refreshing).toBe(false);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('renders stale zero-session state distinctly after a live empty response fails to refresh', async () => {
    mockConfiguredKeystore();
    let currentTimeMs = 1_700_000_000_000;
    const now = () => currentTimeMs;

    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      })
      .mockRejectedValueOnce({ code: 'E_NETWORK_ERROR' });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          now={now}
        />,
      );
      await flushAsync();
    });

    try {
      expect(
        renderer.root.findByProps({ testID: 'dashboard-empty-card' }),
      ).toBeDefined();
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-stale-empty-card' }),
      ).toHaveLength(0);

      currentTimeMs += 8000;
      const scroll = renderer.root.findByProps({ testID: 'dashboard-screen' });
      const refreshControl = scroll.props
        .refreshControl as React.ReactElement<
        React.ComponentProps<typeof RefreshControl>
      >;
      await ReactTestRenderer.act(async () => {
        refreshControl.props.onRefresh?.();
        await flushAsync();
      });

      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-empty-card' }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-stale-empty-card' }),
      ).toBeDefined();
      expect(getAllText(renderer)).toContain(
        '0 sessions (last known · not live)',
      );
      expect(getAllText(renderer)).not.toContain('Age:');
      expect(getAllText(renderer)).not.toContain('Last successful update');
      expect(getAllText(renderer)).not.toContain(
        'No sessions are currently reported by this Spawnea server.',
      );
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('invalidates prepopulated cache on Settings lockout so Dashboard makes no HTTP calls until fresh unlock', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [makeSessionFixture({ id: 'sess-lockout-1' })],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let dashRenderer!: ReactTestRenderer.ReactTestRenderer;
    let settingsRenderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      dashRenderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={5000}
        />,
      );
      settingsRenderer = ReactTestRenderer.create(
        <SettingsScreen
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      expect(request).toHaveBeenCalledTimes(1);
      expect(cache.getCachedCredentials(client)).not.toBeNull();

      // Settings test connection hits E_BIOMETRIC_LOCKOUT -> clears shared cache + broadcasts lock.
      keystore.readKey.mockRejectedValueOnce({
        code: 'E_BIOMETRIC_LOCKOUT',
        message: 'Too many failed biometric attempts',
      });
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'test-connection-button' })
          .props.onPress();
        await flushAsync();
      });

      expect(cache.getCachedCredentials(client)).toBeNull();
      expect(cache.getTerminalAuthLock()?.reason).toBe('biometric_lockout');
      expect(
        dashRenderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');

      // Advance timers and try passive poll ticks: zero HTTP requests allowed.
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(20000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);

      // Even a manual unlock retry while still locked makes zero HTTP requests.
      keystore.readKey.mockRejectedValueOnce({
        code: 'E_BIOMETRIC_LOCKOUT',
        message: 'Too many failed biometric attempts',
      });
      await ReactTestRenderer.act(async () => {
        dashRenderer.root
          .findByProps({ testID: 'dashboard-unlock-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);

      // Fresh successful biometric unlock restores live polling.
      keystore.readKey.mockResolvedValueOnce(TEST_KEY);
      await ReactTestRenderer.act(async () => {
        dashRenderer.root
          .findByProps({ testID: 'dashboard-unlock-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        dashRenderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
    } finally {
      await ReactTestRenderer.act(async () => {
        dashRenderer.unmount();
        settingsRenderer.unmount();
      });
      cache.dispose();
    }
  });

  test('clears green connection banner in Settings on URL update and uncertain save commit, and clears shared cache on save failure', async () => {
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: TEST_URL,
      hasKey: true,
      incomplete: false,
    });
    keystore.readKey.mockResolvedValue(TEST_KEY);
    keystore.updateServerUrl.mockImplementation(async (nextUrl: string) => {
      keystore.getCredentialState.mockResolvedValue({
        serverUrl: nextUrl,
        hasKey: true,
        incomplete: false,
      });
      return true;
    });

    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    // Prepopulate cache as if Dashboard unlocked it earlier.
    await cache.unlockAndGetCredentials({
      apiClient: client,
      allowDebugLoopback: false,
    });
    expect(cache.getCachedCredentials(client)).not.toBeNull();

    let settingsRenderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      settingsRenderer = ReactTestRenderer.create(
        <SettingsScreen
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      // 1. Run Test connection -> green banner appears.
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'test-connection-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findByProps({ testID: 'test-status-text' }).props
          .children,
      ).toContain('Connection succeeded (HTTP 200)');

      // 2. Save a different same-origin URL without replacing the key -> banner cleared + cache cleared.
      // (A cross-origin change requires re-entering the key, so it is not a key-kept update.)
      await ReactTestRenderer.act(async () => {
        settingsRenderer.root
          .findByProps({ testID: 'server-url-input' })
          .props.onChangeText('https://workstation.tailnet.ts.net:05757');
      });
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'save-settings-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findAllByProps({ testID: 'test-status-banner' }),
      ).toHaveLength(0);
      expect(cache.getCachedCredentials(client)).toBeNull();

      // 3. Re-populate cache + re-run Test connection -> green banner appears again.
      await cache.unlockAndGetCredentials({
        apiClient: client,
        allowDebugLoopback: false,
      });
      expect(cache.getCachedCredentials(client)).not.toBeNull();
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'test-connection-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findByProps({ testID: 'test-status-text' }).props
          .children,
      ).toContain('Connection succeeded (HTTP 200)');

      // 4. Uncertain save outcome clears BOTH the test banner and the shared cache.
      keystore.saveCredentials.mockRejectedValueOnce({
        code: 'E_COMMIT_UNCERTAIN',
        message: 'Could not verify which configuration is saved on disk',
      });
      await ReactTestRenderer.act(async () => {
        settingsRenderer.root
          .findByProps({ testID: 'api-key-input' })
          .props.onChangeText('replacement-key-for-uncertain-test');
      });
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'save-settings-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findAllByProps({ testID: 'test-status-banner' }),
      ).toHaveLength(0);
      expect(cache.getCachedCredentials(client)).toBeNull();
    } finally {
      await ReactTestRenderer.act(async () => {
        settingsRenderer.unmount();
      });
      cache.dispose();
    }
  });

  test.each([
    ['empty', []],
    ['live', [makeSessionFixture({ id: 'sess-age-1', name: 'Live Worker', status: 'working' })]],
  ])(
    'J70-5 omits timestamps, age, and technical panel in %s state while continuing foreground polling',
    async (_label, sessions) => {
      jest.setSystemTime(new Date('2026-11-14T12:00:00Z'));
      mockConfiguredKeystore();
      const request = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          retryAfter: null,
          body: JSON.stringify({ apiVersion: 'v1', sessions }),
        })
        .mockImplementationOnce(() => new Promise(() => {}));

      const client = new SpawneaApiClient({
        transport: { request },
        allowDebugLoopback: false,
      });
      const cache = new SessionCredentialCache(false);

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <DashboardScreen
            onOpenSettings={jest.fn()}
            onOpenSessions={jest.fn()}
            onOpenSessionChat={jest.fn()}
            apiClient={client}
            credentialCache={cache}
            allowDebugLoopback={false}
          />,
        );
        await flushAsync();
      });

      try {
        expect(
          renderer.root.findByProps({ testID: 'dashboard-connection-status' })
            .props.children,
        ).toBe('Live');
        expect(
          renderer.root.findAllByProps({ testID: 'dashboard-last-updated' }),
        ).toHaveLength(0);
        expect(
          renderer.root.findAllByProps({ testID: 'dashboard-server-url' }),
        ).toHaveLength(0);
        expect(
          renderer.root.findAllByProps({ testID: 'dashboard-refresh-button' }),
        ).toHaveLength(0);

        const initialText = getAllText(renderer);
        expect(initialText).not.toContain('Last successful update');
        expect(initialText).not.toContain('Server:');
        expect(initialText).not.toContain('ago)');

        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(10000);
          await flushAsync();
        });
        expect(request).toHaveBeenCalledTimes(2);
        expect(getAllText(renderer)).not.toContain('10s ago');
        expect(
          renderer.root.findByProps({ testID: 'dashboard-connection-status' })
            .props.children,
        ).toBe('Live');
      } finally {
        await ReactTestRenderer.act(async () => {
          renderer.unmount();
        });
        cache.dispose();
      }
    },
  );

  test('N70-3 preserves foreground resume intent across 429 cooldown without violating cooldown or passive-poll rules', async () => {
    const appState = setupAppStateSpy();
    mockConfiguredKeystore();
    let currentTimeMs = 1_700_000_000_000;
    const now = () => currentTimeMs;

      const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '30',
        body: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-429-resume',
              name: 'Resumed Session',
            }),
          ],
        }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now,
    });
    const cache = new SessionCredentialCache(true);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
          now={now}
        />,
      );
      await flushAsync();
    });

    try {
      expect(request).toHaveBeenCalledTimes(1);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Rate limited (HTTP 429)');

      // Background clears the in-memory credential cache while 429 cooldown is active.
      await ReactTestRenderer.act(async () => {
        appState.emit('background');
        await flushAsync();
      });
      expect(cache.getCachedCredentials(client)).toBeNull();

      // Return to foreground 15s into the 30s Retry-After window: must respect cooldown
      // (no HTTP call, no premature prompt) and preserve foreground unlock intent.
      currentTimeMs += 15000;
      await ReactTestRenderer.act(async () => {
        appState.emit('active');
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Rate limited (HTTP 429)');

      // Advance remaining 15s until cooldown expires -> unlocks once and fetches live sessions.
      currentTimeMs += 15000;
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(15000);
        await flushAsync();
      });
      expect(keystore.readKey).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
      expect(getAllText(renderer)).toContain('Resumed Session');
      expect(getAllText(renderer)).not.toContain('sess-429-resume');

      // Passive poll with cleared cache must never prompt for biometrics.
      await ReactTestRenderer.act(async () => {
        cache.clear();
        await flushAsync();
      });
      currentTimeMs += 10000;
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10000);
        await flushAsync();
      });
      expect(keystore.readKey).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');
      expect(getAllText(renderer)).not.toContain('Resumed Session');
      expect(getAllText(renderer)).not.toContain('sess-429-resume');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
      appState.restore();
    }
  });

  test('N70-4 clears shared terminalAuthLock on successful Settings unlock without caching key and lets Dashboard recover on focus', async () => {
    mockConfiguredKeystore();
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [makeSessionFixture({ id: 'sess-n70-4' })],
        }),
      })
      .mockResolvedValue({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [makeSessionFixture({ id: 'sess-n70-4' })],
        }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    const listeners = new Map<'focus' | 'blur', Set<() => void>>();
    let focused = true;
    const dashNav = {
      isFocused: () => focused,
      addListener: jest.fn((event: 'focus' | 'blur', cb: () => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)?.add(cb);
        return () => {
          listeners.get(event)?.delete(cb);
        };
      }),
    };
    const emitDashNav = (event: 'focus' | 'blur') => {
      focused = event === 'focus';
      listeners.get(event)?.forEach(cb => cb());
    };

    let dashRenderer!: ReactTestRenderer.ReactTestRenderer;
    let settingsRenderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      dashRenderer = ReactTestRenderer.create(
        <NavigationContext.Provider value={dashNav as never}>
          <DashboardScreen
            onOpenSettings={jest.fn()}
            onOpenSessions={jest.fn()}
            onOpenSessionChat={jest.fn()}
            apiClient={client}
            credentialCache={cache}
            allowDebugLoopback={false}
          />
        </NavigationContext.Provider>,
      );
      settingsRenderer = ReactTestRenderer.create(
        <SettingsScreen
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      expect(request).toHaveBeenCalledTimes(1);

      // Navigate to Settings (blur Dashboard), trigger temporary biometric lockout in Settings.
      await ReactTestRenderer.act(async () => {
        emitDashNav('blur');
        await flushAsync();
      });
      keystore.readKey.mockRejectedValueOnce({
        code: 'E_BIOMETRIC_LOCKOUT',
        message: 'Too many failed biometric attempts',
      });
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'test-connection-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(cache.getTerminalAuthLock()?.reason).toBe('biometric_lockout');
      expect(
        dashRenderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');
      expect(getAllText(dashRenderer)).not.toContain('sess-n70-4');

      // Later, Settings -> Test connection succeeds -> clears terminalAuthLock without caching the key.
      keystore.readKey.mockResolvedValueOnce(TEST_KEY);
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'test-connection-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findByProps({ testID: 'test-status-text' }).props
          .children,
      ).toContain('Connection succeeded (HTTP 200)');
      expect(cache.getTerminalAuthLock()).toBeNull();
      expect(cache.getCachedCredentials(client)).toBeNull();

      // Returning focus to Dashboard unlocks once and resumes Live (not stuck on obsolete lockout).
      keystore.readKey.mockResolvedValueOnce(TEST_KEY);
      await ReactTestRenderer.act(async () => {
        emitDashNav('focus');
        await flushAsync();
      });
      expect(
        dashRenderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      await ReactTestRenderer.act(async () => {
        dashRenderer.unmount();
        settingsRenderer.unmount();
      });
      cache.dispose();
    }
  });

  test('S70-1 clears session snapshot and rendered session data on background and inactive transitions until biometric unlock succeeds', async () => {
    const appState = setupAppStateSpy();
    mockConfiguredKeystore();
    const request: jest.MockedFunction<HttpTransport['request']> = jest
      .fn()
      .mockResolvedValue({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-secret-1',
              name: 'Private Build',
              task: 'Deploy prod secrets',
              status: 'working',
              project: { id: 'p1', name: 'SecretProject' },
              host: { id: 'h1', name: 'ProdHost' },
            }),
          ],
        }),
      });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(true);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      expect(getAllText(renderer)).toContain('Private Build');
      expect(getAllText(renderer)).toContain('ProdHost');
      expect(getAllText(renderer)).not.toContain('sess-secret-1');

      await ReactTestRenderer.act(async () => {
        appState.emit('background');
        await flushAsync();
      });

      const bgText = getAllText(renderer);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');
      expect(
        renderer.root.findByProps({ testID: 'dashboard-locked-card' }),
      ).toBeDefined();
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-summary-card' }),
      ).toHaveLength(0);
      expect(bgText).not.toContain('Private Build');
      expect(bgText).not.toContain('Deploy prod secrets');
      expect(bgText).not.toContain('SecretProject');
      expect(bgText).not.toContain('ProdHost');
      expect(bgText).not.toContain('sess-secret-1');
      expect(bgText).not.toContain('Stale');

      // Re-unlock on active, then transition to inactive and verify clearance again.
      await ReactTestRenderer.act(async () => {
        appState.emit('active');
        await flushAsync();
      });
      expect(getAllText(renderer)).toContain('Private Build');

      await ReactTestRenderer.act(async () => {
        appState.emit('inactive');
        await flushAsync();
      });

      const inactiveText = getAllText(renderer);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-summary-card' }),
      ).toHaveLength(0);
      expect(inactiveText).not.toContain('Private Build');
      expect(inactiveText).not.toContain('sess-secret-1');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
      appState.restore();
    }
  });

  test('S70-1 keeps session data cleared on cancelled, failed, or locked-out biometric unlock and repopulates only after BIOMETRIC_STRONG + sync succeed', async () => {
    const appState = setupAppStateSpy();
    mockConfiguredKeystore();
    const request: jest.MockedFunction<HttpTransport['request']> = jest
      .fn()
      .mockResolvedValue({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-secret-2',
              name: 'Confidential Session',
              task: 'Rotate prod tokens',
              status: 'needs_input',
              project: { id: 'p2', name: 'ProjX' },
              host: { id: 'h2', name: 'HostY' },
            }),
          ],
        }),
      });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(true);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      expect(getAllText(renderer)).toContain('Confidential Session');

      await ReactTestRenderer.act(async () => {
        appState.emit('background');
        await flushAsync();
      });

      // Returning while user cancels Keystore prompt keeps screen locked with no session data.
      keystore.readKey.mockRejectedValueOnce({ code: 'E_AUTH_CANCELED' });
      await ReactTestRenderer.act(async () => {
        appState.emit('active');
        await flushAsync();
      });
      const cancelText = getAllText(renderer);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-summary-card' }),
      ).toHaveLength(0);
      expect(cancelText).not.toContain('Confidential Session');
      expect(cancelText).not.toContain('Rotate prod tokens');
      expect(cancelText).not.toContain('ProjX');
      expect(cancelText).not.toContain('HostY');
      expect(cancelText).not.toContain('sess-secret-2');

      // Explicit retry that fails with biometric lockout still exposes zero session data.
      keystore.readKey.mockRejectedValueOnce({
        code: 'E_BIOMETRIC_LOCKOUT',
        message: 'Too many failed biometric attempts',
      });
      await ReactTestRenderer.act(async () => {
        await renderer.root
          .findByProps({ testID: 'dashboard-unlock-button' })
          .props.onPress();
        await flushAsync();
      });
      const lockoutText = getAllText(renderer);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Locked');
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-summary-card' }),
      ).toHaveLength(0);
      expect(lockoutText).not.toContain('Confidential Session');
      expect(lockoutText).not.toContain('sess-secret-2');

      // Successful BIOMETRIC_STRONG unlock + HTTP 200 repopulates Dashboard cleanly.
      keystore.readKey.mockResolvedValueOnce(TEST_KEY);
      await ReactTestRenderer.act(async () => {
        await renderer.root
          .findByProps({ testID: 'dashboard-unlock-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toBe('Live');
      expect(getAllText(renderer)).toContain('Confidential Session');
      expect(getAllText(renderer)).toContain('Rotate prod tokens');
      expect(getAllText(renderer)).not.toContain('sess-secret-2');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
      appState.restore();
    }
  });

  test('V70-1 clears Settings green test banner immediately on URL edit and on cross-origin Save rejection without key', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let settingsRenderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      settingsRenderer = ReactTestRenderer.create(
        <SettingsScreen
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      // 1. Test connection -> green banner appears.
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'test-connection-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findByProps({ testID: 'test-status-text' }).props
          .children,
      ).toContain('Connection succeeded (HTTP 200)');

      // 2. Editing the URL input clears testBanner immediately before pressing Save.
      await ReactTestRenderer.act(async () => {
        settingsRenderer.root
          .findByProps({ testID: 'server-url-input' })
          .props.onChangeText('https://other-host.tailnet.ts.net:5770');
      });
      expect(
        settingsRenderer.root.findAllByProps({ testID: 'test-status-banner' }),
      ).toHaveLength(0);

      // 3. Running Test connection while draft URL has another origin shows green banner,
      //    and pressing Save / Replace (origin-change rejection without key) clears testBanner.
      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'test-connection-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findByProps({ testID: 'test-status-text' }).props
          .children,
      ).toContain('Connection succeeded (HTTP 200)');

      await ReactTestRenderer.act(async () => {
        await settingsRenderer.root
          .findByProps({ testID: 'save-settings-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        settingsRenderer.root.findByProps({ testID: 'save-status-text' }).props
          .children,
      ).toContain('Changing the server origin requires entering the API key again.');
      expect(
        settingsRenderer.root.findAllByProps({ testID: 'test-status-banner' }),
      ).toHaveLength(0);
    } finally {
      await ReactTestRenderer.act(async () => {
        settingsRenderer.unmount();
      });
      cache.dispose();
    }
  });

  test.each([429, 401] as const)(
    'S70-1 clears session snapshot after cancelled Settings replacement during HTTP %s pause without violating pause or cooldown',
    async status => {
      mockConfiguredKeystore();
      let currentTimeMs = 1_700_000_000_000;
      const now = () => currentTimeMs;

      const okResponse = {
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-s70-pause-1',
              name: 'PrivateName',
              task: 'PrivateTask',
              project: { id: 'p-priv', name: 'PrivateProject' },
              host: { id: 'h-priv', name: 'PrivateHost' },
            }),
          ],
        }),
      };

      const request = jest
        .fn()
        .mockResolvedValueOnce(okResponse)
        .mockResolvedValueOnce({
          status,
          retryAfter: status === 429 ? '30' : null,
          body: '',
        })
        .mockResolvedValueOnce(okResponse);

      const client = new SpawneaApiClient({
        transport: { request },
        allowDebugLoopback: false,
        now,
      });
      const cache = new SessionCredentialCache(false);

      const listeners = new Map<'focus' | 'blur', Set<() => void>>();
      let focused = true;
      const dashNav = {
        isFocused: () => focused,
        addListener: jest.fn((event: 'focus' | 'blur', cb: () => void) => {
          if (!listeners.has(event)) {
            listeners.set(event, new Set());
          }
          listeners.get(event)?.add(cb);
          return () => {
            listeners.get(event)?.delete(cb);
          };
        }),
      };
      const emitDashNav = (event: 'focus' | 'blur') => {
        focused = event === 'focus';
        listeners.get(event)?.forEach(cb => cb());
      };

      let dashRenderer!: ReactTestRenderer.ReactTestRenderer;
      let settingsRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        dashRenderer = ReactTestRenderer.create(
          <NavigationContext.Provider value={dashNav as never}>
            <DashboardScreen
              onOpenSettings={jest.fn()}
              onOpenSessions={jest.fn()}
              onOpenSessionChat={jest.fn()}
              apiClient={client}
              credentialCache={cache}
              allowDebugLoopback={false}
              now={now}
            />
          </NavigationContext.Provider>,
        );
        settingsRenderer = ReactTestRenderer.create(
          <SettingsScreen
            apiClient={client}
            credentialCache={cache}
            allowDebugLoopback={false}
          />,
        );
        await flushAsync();
      });

      try {
        expect(getAllText(dashRenderer)).toContain('PrivateName');
        expect(keystore.readKey).toHaveBeenCalledTimes(1);

        // Unlocked pull-to-refresh receives 429/401 -> stays stale while foreground cache is still valid.
        const scroll = dashRenderer.root.findByProps({
          testID: 'dashboard-screen',
        });
        const refreshControl = scroll.props
          .refreshControl as React.ReactElement<
          React.ComponentProps<typeof RefreshControl>
        >;
        await ReactTestRenderer.act(async () => {
          refreshControl.props.onRefresh?.();
          await flushAsync();
        });
        expect(
          dashRenderer.root.findByProps({
            testID: 'dashboard-connection-status',
          }).props.children,
        ).toContain('Stale');
        expect(getAllText(dashRenderer)).toContain('PrivateName');

        // Navigate to Settings (blur Dashboard), start key replacement and cancel it -> clears cache.
        await ReactTestRenderer.act(async () => {
          emitDashNav('blur');
          settingsRenderer.root
            .findByProps({ testID: 'api-key-input' })
            .props.onChangeText('synthetic-replacement');
          await flushAsync();
        });
        keystore.saveCredentials.mockRejectedValueOnce({
          code: 'E_AUTH_CANCELED',
        });
        await ReactTestRenderer.act(async () => {
          await settingsRenderer.root
            .findByProps({ testID: 'save-settings-button' })
            .props.onPress();
          await flushAsync();
        });
        expect(cache.getCachedCredentials(client)).toBeNull();

        // Return focus to Dashboard during 429 cooldown / 401 pause:
        // must clear snapshot data and honor pause/cooldown without premature HTTP or biometric prompt.
        await ReactTestRenderer.act(async () => {
          emitDashNav('focus');
          await flushAsync();
        });
        expect(cache.getCachedCredentials(client)).toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
        expect(keystore.readKey).toHaveBeenCalledTimes(1);
        expect(
          dashRenderer.root.findByProps({
            testID: 'dashboard-connection-status',
          }).props.children,
        ).toBe(
          status === 429 ? 'Rate limited (HTTP 429)' : 'Auth rejected (HTTP 401)',
        );
        expect(
          dashRenderer.root.findAllByProps({ testID: 'dashboard-summary-card' }),
        ).toHaveLength(0);
        const visibleAfterReturn = getAllText(dashRenderer);
        for (const privateValue of [
          'PrivateName',
          'PrivateTask',
          'PrivateProject',
          'PrivateHost',
          'sess-s70-pause-1',
        ]) {
          expect(visibleAfterReturn).not.toContain(privateValue);
        }

        currentTimeMs += 30000;
        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(30000);
          await flushAsync();
        });
        if (status === 429) {
          // Focus intent preserved across cooldown unlocks once and recovers Live.
          expect(keystore.readKey).toHaveBeenCalledTimes(2);
          expect(request).toHaveBeenCalledTimes(3);
          expect(
            dashRenderer.root.findByProps({
              testID: 'dashboard-connection-status',
            }).props.children,
          ).toBe('Live');
          expect(getAllText(dashRenderer)).toContain('PrivateName');
        } else {
          // 401 pause does not retry or prompt on timers.
          expect(keystore.readKey).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledTimes(2);
        }
      } finally {
        await ReactTestRenderer.act(async () => {
          dashRenderer.unmount();
          settingsRenderer.unmount();
        });
        cache.dispose();
      }
    },
  );

  test('renders segmented distribution bar omitting zero-count segments, single legend row, and hides Needs input when count is 0', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          makeSessionFixture({ id: 'sess-w-1', name: 'Worker One', status: 'working' }),
          makeSessionFixture({ id: 'sess-s-1', name: 'Starting One', status: 'starting' }),
          makeSessionFixture({ id: 'sess-i-1', name: 'Idle One', status: 'idle' }),
          makeSessionFixture({ id: 'sess-d-1', name: 'Done One', status: 'done' }),
        ],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-total-sessions' })
          .props.children.join(''),
      ).toBe('Total: 4');

      // Zero-count segments ('need-input' and 'error') must not render in the bar.
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-bar-segment-need-input' }),
      ).toHaveLength(0);
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-bar-segment-error' }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-bar-segment-running' }),
      ).toBeDefined();
      expect(
        renderer.root.findByProps({ testID: 'dashboard-bar-segment-done/idle' }),
      ).toBeDefined();

      // Legend renders all 4 categories with exact counts.
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-legend-need-input' })
          .props.children.join(''),
      ).toBe('0 Need input');
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-legend-running' })
          .props.children.join(''),
      ).toBe('2 Running');
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-legend-done/idle' })
          .props.children.join(''),
      ).toBe('2 Done/idle');
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-legend-error' })
          .props.children.join(''),
      ).toBe('0 Error');

      // Needs input section is completely absent when 0 pending.
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-needs-input-section' }),
      ).toHaveLength(0);
      const text = getAllText(renderer);
      expect(text).not.toContain('Needs input (0)');
      expect(text).not.toContain('0 sessions with status needs_input');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('renders host/harness/branch/children metadata from data, avoids top-level child duplication, hides IDs and worktree.path', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          {
            ...makeSessionFixture({
              id: 'sess-parent-secret-id',
              name: 'Coordinator Session',
              task: 'Coordinator Session',
              status: 'idle',
              host: { id: 'local', name: 'Workstation Alpha' },
              harness: { id: 'local:claude', name: 'Claude Opus', command: 'claude' },
            }),
            worktree: {
              managed: true,
              branch: 'feat/ui-polish',
              path: '/mnt/secret-host-path/worktrees/ops-70',
            },
          },
          {
            ...makeSessionFixture({
              id: 'sess-child-1-secret-id',
              name: 'Child Builder',
              parentSessionId: 'sess-parent-secret-id',
              childAlias: 'child-1',
              task: 'Build UI cards',
              status: 'working',
              host: { id: 'local', name: 'Workstation Alpha' },
              harness: { id: 'local:agy', name: 'Antigravity', command: 'agy' },
            }),
            worktree: {
              branch: 'feat/ui-polish',
              path: '/mnt/secret-host-path/worktrees/child-1',
            },
          },
          {
            ...makeSessionFixture({
              id: 'sess-child-2-secret-id',
              name: '',
              parentSessionId: 'sess-parent-secret-id',
              childAlias: 'child-2',
              task: '',
              status: 'done',
              host: { id: 'local', name: 'Workstation Alpha' },
              harness: { id: 'local:codex', name: 'Codex Sol', command: 'codex' },
            }),
          },
        ],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);
    const onOpenSessionChat = jest.fn();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={onOpenSessionChat}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      // Total counts all 3 sessions once (1 idle/done + 1 working + 1 done = 3).
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-total-sessions' })
          .props.children.join(''),
      ).toBe('Total: 3');

      // Only the parent card is top-level; children are NOT duplicated top-level.
      expect(
        renderer.root.findByProps({
          testID: 'dashboard-session-card-sess-parent-secret-id',
        }),
      ).toBeDefined();
      expect(
        renderer.root.findAllByProps({
          testID: 'dashboard-session-card-sess-child-1-secret-id',
        }),
      ).toHaveLength(0);
      expect(
        renderer.root.findAllByProps({
          testID: 'dashboard-session-card-sess-child-2-secret-id',
        }),
      ).toHaveLength(0);

      const initialText = getAllText(renderer);
      expect(initialText).toContain('Coordinator Session');
      expect(initialText).toContain('Workstation Alpha');
      expect(initialText).toContain('Claude Opus');
      expect(initialText).toContain('feat/ui-polish');
      expect(initialText).toContain('2 children');

      // Neither session IDs nor worktree.path appear anywhere in rendered text or accessibility labels.
      const allAccessibilityLabels = renderer.root
        .findAll(node => typeof node.props.accessibilityLabel === 'string')
        .map(node => String(node.props.accessibilityLabel))
        .join('\n');
      for (const secret of [
        'sess-parent-secret-id',
        'sess-child-1-secret-id',
        'sess-child-2-secret-id',
        '/mnt/secret-host-path',
      ]) {
        expect(initialText).not.toContain(secret);
        expect(allAccessibilityLabels).not.toContain(secret);
      }

      // Expanding the children chip reveals nested child rows and opens child by ID.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'dashboard-children-toggle-sess-parent-secret-id' })
          .props.onPress();
        await flushAsync();
      });

      expect(
        renderer.root.findByProps({
          testID: 'dashboard-children-list-sess-parent-secret-id',
        }),
      ).toBeDefined();
      const expandedText = getAllText(renderer);
      expect(expandedText).toContain('Child Builder');
      expect(expandedText).toContain('child-2');
      expect(expandedText).not.toContain('sess-child-1-secret-id');
      expect(expandedText).not.toContain('sess-child-2-secret-id');

      renderer.root
        .findByProps({ testID: 'dashboard-child-card-sess-child-1-secret-id' })
        .props.onPress();
      expect(onOpenSessionChat).toHaveBeenCalledWith('sess-child-1-secret-id');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('toggles discrete Refresh in N s popup on connection badge tap without URL or buttons', async () => {
    mockConfiguredKeystore();
    let currentTimeMs = 1_700_000_000_000;
    const now = () => currentTimeMs;
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [makeSessionFixture({ id: 'sess-pop-1', name: 'Popup Session' })],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
          pollIntervalMs={10000}
          now={now}
        />,
      );
      await flushAsync();
    });

    try {
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-poll-countdown-popup' }),
      ).toHaveLength(0);

      // Tap connection badge -> opens discrete countdown popup.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'dashboard-connection-badge' })
          .props.onPress();
        await flushAsync();
      });

      const popupText = renderer.root
        .findByProps({ testID: 'dashboard-poll-countdown-text' })
        .props.children.join('');
      expect(popupText).toBe('Refresh in 10 s');
      expect(getAllText(renderer)).not.toContain(TEST_URL);

      // Advance 3s -> countdown updates from real polling timer.
      currentTimeMs += 3000;
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(3000);
        await flushAsync();
      });
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-poll-countdown-text' })
          .props.children.join(''),
      ).toBe('Refresh in 7 s');

      // Tap badge again -> closes popup.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'dashboard-connection-badge' })
          .props.onPress();
        await flushAsync();
      });
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-poll-countdown-popup' }),
      ).toHaveLength(0);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('never displays session ID even when name and task are empty, and surfaces needs_input child without duplication', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          makeSessionFixture({
            id: 'sess-empty-title-id',
            name: '',
            task: '',
            status: 'idle',
          }),
          makeSessionFixture({
            id: 'sess-parent-with-ni-child',
            name: 'Parent Orchestrator',
            task: 'Coordinate workers',
            status: 'working',
          }),
          makeSessionFixture({
            id: 'sess-ni-child-id',
            name: 'Child Waiting Approval',
            parentSessionId: 'sess-parent-with-ni-child',
            childAlias: 'child-1',
            task: 'Confirm schema migration',
            status: 'needs_input',
          }),
        ],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      const text = getAllText(renderer);
      expect(text).toContain('Untitled session');
      expect(text).toContain('Child Waiting Approval');
      expect(text).toContain('Parent: Parent Orchestrator');
      expect(text).toContain('1 child');
      expect(text).not.toContain('sess-empty-title-id');
      expect(text).not.toContain('sess-parent-with-ni-child');
      expect(text).not.toContain('sess-ni-child-id');

      // Needs input child appears in Needs input section, NOT duplicated as top-level in Sessions section.
      const needsInputSection = renderer.root.findByProps({
        testID: 'dashboard-needs-input-section',
      });
      expect(
        needsInputSection.findByProps({
          testID: 'dashboard-session-card-sess-ni-child-id',
        }),
      ).toBeDefined();
      const otherSection = renderer.root.findByProps({
        testID: 'dashboard-other-sessions-section',
      });
      expect(
        otherSection.findAllByProps({
          testID: 'dashboard-session-card-sess-ni-child-id',
        }),
      ).toHaveLength(0);

      // Expand parent: chip still counts 1 child, child card is NOT duplicated,
      // and compact non-card reference indicates the child is waiting in Need input.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({
            testID: 'dashboard-children-toggle-sess-parent-with-ni-child',
          })
          .props.onPress();
        await flushAsync();
      });

      const expandedText = getAllText(renderer);
      expect(expandedText.split('Child Waiting Approval').length - 1).toBe(1);
      expect(expandedText).toContain('1 child');
      expect(expandedText).toContain('1 waiting in Need input');
      expect(
        otherSection.findAllByProps({
          testID: 'dashboard-child-card-sess-ni-child-id',
        }),
      ).toHaveLength(0);
      expect(
        otherSection.findByProps({
          testID: 'dashboard-children-needs-input-ref-sess-parent-with-ni-child',
        }),
      ).toBeDefined();
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('UI-2 keeps max 4 categories in bar and legend while rendering discrete notice for unknown statuses', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          makeSessionFixture({ id: 'sess-known-idle', name: 'Idle One', status: 'idle' }),
          makeSessionFixture({
            id: 'sess-unknown-1',
            name: 'Unknown State One',
            status: 'custom_backend_state',
          }),
        ],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      const text = getAllText(renderer);
      expect(text).toContain('Total: 2');
      expect(text).toContain('1 session with unknown status');
      expect(text).not.toContain('Other');

      const legend = renderer.root.findByProps({
        testID: 'dashboard-distribution-legend',
      });
      expect(
        legend.findAll(
          node =>
            node.type === Text &&
            typeof node.props.testID === 'string' &&
            node.props.testID.startsWith('dashboard-legend-'),
        ),
      ).toHaveLength(4);
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-bar-segment-other' }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({
          testID: 'dashboard-unknown-status-notice',
        }),
      ).toBeDefined();
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('UI-3 renders exact count/total proportional bar widths and hides inner number on narrow segments while keeping accessibilityLabel', async () => {
    mockConfiguredKeystore();
    const sessions = [
      makeSessionFixture({
        id: 'sess-ni-tiny',
        name: 'Tiny Needs Input',
        status: 'needs_input',
      }),
      ...Array.from({ length: 19 }, (_, idx) =>
        makeSessionFixture({
          id: `sess-idle-${idx}`,
          name: `Idle ${idx}`,
          status: 'idle',
        }),
      ),
    ];
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions,
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      const bar = renderer.root.findByProps({
        testID: 'dashboard-distribution-bar',
      });
      await ReactTestRenderer.act(async () => {
        bar.props.onLayout({ nativeEvent: { layout: { width: 322 } } });
      });

      const niSeg = renderer.root.findByProps({
        testID: 'dashboard-bar-segment-need-input',
      });
      const idleSeg = renderer.root.findByProps({
        testID: 'dashboard-bar-segment-done/idle',
      });

      expect(niSeg.props.accessibilityLabel).toBe('1 Need input');
      expect(idleSeg.props.accessibilityLabel).toBe('19 Done/idle');

      const niFlatStyle = Object.assign({}, ...(Array.isArray(niSeg.props.style) ? niSeg.props.style : [niSeg.props.style]));
      const idleFlatStyle = Object.assign({}, ...(Array.isArray(idleSeg.props.style) ? idleSeg.props.style : [idleSeg.props.style]));
      expect(niFlatStyle.width).toBe('5%');
      expect(niFlatStyle.minWidth).toBeUndefined();
      expect(niFlatStyle.paddingHorizontal).toBeUndefined();
      expect(idleFlatStyle.width).toBe('95%');

      // 5% of 320dp = 16dp (< 17dp needed for '1'), so inner Text is omitted while 95% keeps '19'.
      expect(niSeg.findAllByType(Text)).toHaveLength(0);
      expect(idleSeg.findAllByType(Text).map(node => String(node.props.children))).toContain('19');
      expect(getAllText(renderer)).toContain('1 Need input');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('UI-4 renders host icon and accessible label on expanded child cards', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          makeSessionFixture({
            id: 'sess-parent-host',
            name: 'Parent Coord',
            status: 'idle',
            host: { id: 'host-main', name: 'Parent Box' },
          }),
          makeSessionFixture({
            id: 'sess-child-host',
            name: 'Worker Child',
            parentSessionId: 'sess-parent-host',
            status: 'working',
            host: { id: 'host-remote', name: 'Remote Build Host' },
          }),
        ],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <DashboardScreen
          onOpenSettings={jest.fn()}
          onOpenSessions={jest.fn()}
          onOpenSessionChat={jest.fn()}
          apiClient={client}
          credentialCache={cache}
          allowDebugLoopback={false}
        />,
      );
      await flushAsync();
    });

    try {
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'dashboard-children-toggle-sess-parent-host' })
          .props.onPress();
        await flushAsync();
      });

      const childCard = renderer.root.findByProps({
        testID: 'dashboard-child-card-sess-child-host',
      });
      const childText = childCard
        .findAllByType(Text)
        .map(node => String(node.props.children))
        .join('\n');
      expect(childText).toContain('Remote Build Host');
      expect(
        childCard.findByProps({
          accessibilityLabel: 'Host: Remote Build Host',
        }),
      ).toBeDefined();
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('UI-5 applies top safe-area inset on opaque root container above ScrollView', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [makeSessionFixture({ id: 'sess-inset-1', name: 'Inset Test' })],
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SafeAreaInsetsContext.Provider
          value={{ top: 24, right: 0, bottom: 0, left: 0 }}>
          <DashboardScreen
            onOpenSettings={jest.fn()}
            onOpenSessions={jest.fn()}
            onOpenSessionChat={jest.fn()}
            apiClient={client}
            credentialCache={cache}
            allowDebugLoopback={false}
          />
        </SafeAreaInsetsContext.Provider>,
      );
      await flushAsync();
    });

    try {
      const root = renderer.root.findByProps({ testID: 'dashboard-root' });
      const rootStyle = Object.assign(
        {},
        ...(Array.isArray(root.props.style)
          ? root.props.style
          : [root.props.style]),
      );
      expect(rootStyle.paddingTop).toBe(24);
      expect(rootStyle.backgroundColor).toBe('#0d1117');

      const scroll = renderer.root.findByProps({ testID: 'dashboard-screen' });
      const contentStyle = Object.assign(
        {},
        ...(Array.isArray(scroll.props.contentContainerStyle)
          ? scroll.props.contentContainerStyle
          : [scroll.props.contentContainerStyle]),
      );
      expect(contentStyle.paddingTop).toBe(10);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });
});

describe('SessionChatScreen S70-2 relock guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    defaultSessionCredentialCache.dispose();
  });

  test('S70-2 shows session ID only while unlocked in foreground and hides on background without biometrics or HTTP', async () => {
    const appStateSpy = setupAppStateSpy();
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          makeSessionFixture({
            id: 'sess-chat-bg-1',
            name: 'BG Session',
            status: 'idle',
          }),
        ],
      }),
    });
    (NativeModules as { SpawneaHttp?: unknown }).SpawneaHttp = {
      getConstants: () => ({ allowDebugLoopback: false }),
      request,
    };

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(<App />);
        await flushAsync(8);
      });

      const sessionCard = renderer.root.findByProps({
        testID: 'dashboard-session-card-sess-chat-bg-1',
      });
      await ReactTestRenderer.act(async () => {
        sessionCard.props.onPress();
        await flushAsync(8);
      });

      expect(getAllText(renderer)).toContain('sess-chat-bg-1');
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);

      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(4);
      });

      expect(getAllText(renderer)).not.toContain('sess-chat-bg-1');
      expect(getAllText(renderer)).toContain(
        'Locked. Unlock from Dashboard to view this session.',
      );

      // Returning directly to foreground on Session/Chat must keep ID hidden
      // and never trigger its own biometric prompt or HTTP call.
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('active');
        await flushAsync(6);
      });

      expect(getAllText(renderer)).not.toContain('sess-chat-bg-1');
      expect(getAllText(renderer)).toContain(
        'Locked. Unlock from Dashboard to view this session.',
      );
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      delete (NativeModules as { SpawneaHttp?: unknown }).SpawneaHttp;
      if (renderer) {
        await ReactTestRenderer.act(async () => {
          renderer.unmount();
        });
      }
      appStateSpy.restore();
    }
  });

  test('S70-2 clears session ID on cache.clear(), invokes navigation.setParams, restores only when unlocked with param intact, and cleans up listeners', async () => {
    const appStateSpy = setupAppStateSpy();
    mockConfiguredKeystore();
    const apiClient = new SpawneaApiClient({
      transport: {
        request: jest.fn(),
      },
      allowDebugLoopback: true,
    });
    const cache = new SessionCredentialCache();
    await cache.unlockAndGetCredentials({
      apiClient,
      allowDebugLoopback: true,
    });
    expect(cache.hasUnlockedKey(apiClient)).toBe(true);

    const setParams = jest.fn();
    const unsubscribeFocus = jest.fn();
    let focusHandler: (() => void) | undefined;
    const addListener = jest.fn((event: string, listener: () => void) => {
      if (event === 'focus') {
        focusHandler = listener;
      }
      return unsubscribeFocus;
    });

    const addEventListenerMock = AppState.addEventListener as unknown as jest.Mock;
    const subCountBeforeRender = addEventListenerMock.mock.results.length;

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <SessionChatScreen
            route={{ params: { sessionId: 'sess-chat-clear-2' } }}
            navigation={{ setParams, addListener }}
            credentialCache={cache}
            apiClient={apiClient}
          />,
        );
        await flushAsync();
      });

      expect(getAllText(renderer)).toContain('sess-chat-clear-2');

      await ReactTestRenderer.act(async () => {
        cache.clear();
        await flushAsync();
      });

      expect(setParams).toHaveBeenCalledWith({ sessionId: undefined });
      expect(getAllText(renderer)).not.toContain('sess-chat-clear-2');
      expect(getAllText(renderer)).toContain(
        'Locked. Unlock from Dashboard to view this session.',
      );
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      // Re-unlocking while route param was not mutated externally allows display again on focus/active.
      await cache.unlockAndGetCredentials({
        apiClient,
        allowDebugLoopback: true,
      });
      await ReactTestRenderer.act(async () => {
        focusHandler?.();
        await flushAsync();
      });
      expect(getAllText(renderer)).toContain('sess-chat-clear-2');

      // Inactive also hides ID and clears route param.
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('inactive');
        await flushAsync();
      });
      expect(getAllText(renderer)).not.toContain('sess-chat-clear-2');

      const screenAppStateSubs = addEventListenerMock.mock.results
        .slice(subCountBeforeRender)
        .map(result => result.value as { remove: jest.Mock });
      expect(screenAppStateSubs.length).toBeGreaterThanOrEqual(1);

      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      expect(unsubscribeFocus).toHaveBeenCalledTimes(1);
      for (const sub of screenAppStateSubs) {
        expect(sub.remove).toHaveBeenCalledTimes(1);
      }
    } finally {
      cache.dispose();
      appStateSpy.restore();
    }
  });
});
