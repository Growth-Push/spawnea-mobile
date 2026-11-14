import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContext } from '@react-navigation/native';
import React from 'react';
import { AppState, NativeModules, RefreshControl, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { HttpTransport, SpawneaApiClient } from '../src/api/client';
import {
  computeStatusSummary,
  formatAgeDuration,
  mapApiFailureToDashboardError,
  partitionDashboardSessions,
  sortDashboardSessions,
} from '../src/dashboard/dashboardModel';
import { DashboardScreen } from '../src/screens/DashboardScreen';
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
  test('computeStatusSummary derives counts strictly from API status strings', () => {
    const fixtures = [
      makeSessionFixture({ id: 'sess-1', status: 'needs_input' }),
      makeSessionFixture({ id: 'sess-2', status: 'working' }),
      makeSessionFixture({ id: 'sess-3', status: 'working' }),
      makeSessionFixture({ id: 'sess-4', status: 'idle' }),
      makeSessionFixture({ id: 'sess-5', status: 'error' }),
      makeSessionFixture({ id: 'sess-6', status: 'disconnected' }),
      makeSessionFixture({ id: 'sess-7', status: 'custom_backend_state' }),
    ];

    const summary = computeStatusSummary(fixtures);
    expect(summary.total).toBe(7);

    const byStatus = Object.fromEntries(
      summary.counts.map(item => [item.status, item.count]),
    );
    expect(byStatus).toEqual({
      needs_input: 1,
      working: 2,
      starting: 0,
      idle: 1,
      done: 0,
      error: 1,
      disconnected: 1,
      custom_backend_state: 1,
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

  test('formatAgeDuration formats seconds, minutes, and hours deterministically', () => {
    expect(formatAgeDuration(0)).toBe('0s');
    expect(formatAgeDuration(14900)).toBe('14s');
    expect(formatAgeDuration(65000)).toBe('1m 5s');
    expect(formatAgeDuration(120000)).toBe('2m');
    expect(formatAgeDuration(3780000)).toBe('1h 3m');
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

  test('emphasizes needs_input sessions at top, shows host/project, and opens Session/Chat with ID', async () => {
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
            lastActivityAt: '2026-11-13T12:10:00.000Z',
          }),
          makeSessionFixture({
            id: 'sess-input-a',
            name: 'Approve Deployment',
            task: 'Confirm migration step',
            status: 'needs_input',
            project: { id: 'p-2', name: 'Project Beta' },
            host: { id: 'h-2', name: 'Host Two' },
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
      expect(needsInputText).toContain('sess-input-a');

      const text = getAllText(renderer);
      expect(text).toContain('Project: Project Beta · Host: Host Two');
      expect(text).toContain('Project: Project Alpha · Host: Host One');
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

  test('transitions to stale with age on refresh failure, never replaces with empty list, and recovers on pull-to-refresh', async () => {
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

      // Next poll fails with offline error -> becomes STALE, keeps sess-live-1.
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
      expect(getAllText(renderer)).toContain('sess-live-1');

      // Advancing clock increases the displayed stale age without hitting empty state.
      currentTimeMs += 5000;
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(5000);
        await flushAsync();
      });
      expect(
        renderer.root
          .findByProps({ testID: 'dashboard-stale-age' })
          .props.children.join(''),
      ).toContain('Age: 15s');

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

      // Backgrounding clears memory cache, marks snapshot stale/locked, and stops polling.
      await ReactTestRenderer.act(async () => {
        appState.emit('background');
        await flushAsync();
      });
      expect(cache.getCachedCredentials(client)).toBeNull();
      expect(
        renderer.root.findByProps({ testID: 'dashboard-connection-status' })
          .props.children,
      ).toContain('Stale · Locked');

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

      await ReactTestRenderer.act(async () => {
        await renderer.root
          .findByProps({ testID: 'dashboard-refresh-button' })
          .props.onPress();
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
      expect(getAllText(renderer)).toContain('sess-stale-401');
      expect(client.isPollingPausedForAuth()).toBe(true);

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(30000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(2);

      renderer.root
        .findByProps({ testID: 'dashboard-open-sessions-button' })
        .props.onPress();
      renderer.root
        .findByProps({ testID: 'dashboard-open-settings-button' })
        .props.onPress();
      expect(onOpenSessions).toHaveBeenCalledTimes(1);
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('resets Refresh button state when blurred while a 401 refresh is in flight', async () => {
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
      const refreshButton = renderer.root.findByProps({
        testID: 'dashboard-refresh-button',
      });
      expect(refreshButton.props.disabled).toBe(false);

      // Start manual refresh, then blur before the pending request resolves 401.
      await ReactTestRenderer.act(async () => {
        refreshButton.props.onPress();
        await flushAsync(2);
      });
      expect(request).toHaveBeenCalledTimes(2);

      await ReactTestRenderer.act(async () => {
        emitNav('blur');
        await flushAsync(2);
      });
      expect(
        renderer.root.findByProps({ testID: 'dashboard-refresh-button' }).props
          .disabled,
      ).toBe(false);

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
      expect(
        renderer.root.findByProps({ testID: 'dashboard-refresh-button' }).props
          .disabled,
      ).toBe(false);
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
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'dashboard-refresh-button' })
          .props.onPress();
        await flushAsync();
      });

      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-empty-card' }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-stale-empty-card' }),
      ).toBeDefined();
      expect(getAllText(renderer)).toContain(
        '0 sessions (last known · current state unknown)',
      );
      expect(getAllText(renderer)).not.toContain(
        'No sessions are currently reported by this server.',
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
      ).toBe('Stale · Locked');

      // Advance timers and try passive poll ticks: zero HTTP requests allowed.
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(20000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);

      // Even a manual refresh retry while still locked makes zero HTTP requests.
      keystore.readKey.mockRejectedValueOnce({
        code: 'E_BIOMETRIC_LOCKOUT',
        message: 'Too many failed biometric attempts',
      });
      await ReactTestRenderer.act(async () => {
        dashRenderer.root
          .findByProps({ testID: 'dashboard-refresh-button' })
          .props.onPress();
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);

      // Fresh successful biometric unlock restores live polling.
      keystore.readKey.mockResolvedValueOnce(TEST_KEY);
      await ReactTestRenderer.act(async () => {
        dashRenderer.root
          .findByProps({ testID: 'dashboard-refresh-button' })
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
    ['live', [makeSessionFixture({ id: 'sess-age-1', status: 'working' })]],
  ])(
    'J70-5 advances relative age in %s state while focused and active even with a pending poll',
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
        const lastUpdatedText = () =>
          renderer.root
            .findByProps({ testID: 'dashboard-last-updated' })
            .props.children.join('');

        expect(
          renderer.root.findByProps({ testID: 'dashboard-connection-status' })
            .props.children,
        ).toBe('Live');
        expect(lastUpdatedText()).toContain('(0s ago)');

        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(10000);
          await flushAsync();
        });
        expect(request).toHaveBeenCalledTimes(2);
        expect(lastUpdatedText()).toContain('(10s ago)');

        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(10000);
          await flushAsync();
        });
        expect(
          renderer.root.findByProps({ testID: 'dashboard-connection-status' })
            .props.children,
        ).toBe('Live');
        expect(lastUpdatedText()).toContain('(20s ago)');
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
          sessions: [makeSessionFixture({ id: 'sess-429-resume' })],
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
      expect(getAllText(renderer)).toContain('sess-429-resume');

      // Passive poll with cleared cache must never prompt for biometrics.
      cache.clear();
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
      ).toBe('Stale · Locked');
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
      ).toBe('Stale · Locked');

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
});
