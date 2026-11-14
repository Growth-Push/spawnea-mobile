import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContext } from '@react-navigation/native';
import React from 'react';
import { AppState, NativeModules, RefreshControl, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { SpawneaApiClient } from '../src/api/client';
import { SessionsScreen } from '../src/screens/SessionsScreen';
import {
  buildSessionsListTree,
  computeSessionsHeaderSummary,
  deduplicateSessionsById,
  filterSessionsByCategory,
  formatChildrenToggleLabels,
  formatHostName,
  formatRelativeActivity,
} from '../src/sessions/sessionsModel';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../src/storage/sessionCredentialCache';
import { makeSessionFixture } from './apiClient.test';

const TEST_URL = 'https://workstation.tailnet.ts.net:5757';
const TEST_KEY = 'dummy-sessions-test-key-never-rendered';
const FIXED_NOW_MS = Date.parse('2026-11-13T12:15:00.000Z');

const keystore = NativeModules.SpawneaKeystore as {
  getCapability: jest.Mock;
  getCredentialState: jest.Mock;
  hasKey: jest.Mock;
  saveCredentials: jest.Mock;
  updateServerUrl: jest.Mock;
  readKey: jest.Mock;
  deleteKey: jest.Mock;
};

async function flushAsync(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

function getAllText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const children = node.props.children;
      return Array.isArray(children)
        ? children.join('')
        : String(children ?? '');
    })
    .join('\n');
}

function mockConfiguredKeystore(serverUrl = TEST_URL, apiKey = TEST_KEY) {
  keystore.getCredentialState.mockResolvedValue({
    serverUrl,
    hasKey: true,
    incomplete: false,
  });
  keystore.readKey.mockResolvedValue(apiKey);
}

function setupAppStateSpy() {
  const listeners = new Set<
    (state: 'active' | 'background' | 'inactive') => void
  >();
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

function createFakeNavigation(initialFocused = true) {
  let focused = initialFocused;
  const focusListeners = new Set<() => void>();
  const blurListeners = new Set<() => void>();

  return {
    navigation: {
      isFocused: () => focused,
      addListener: (event: string, listener: () => void) => {
        if (event === 'focus') {
          focusListeners.add(listener);
        } else if (event === 'blur') {
          blurListeners.add(listener);
        }
        return () => {
          focusListeners.delete(listener);
          blurListeners.delete(listener);
        };
      },
    },
    emitFocus() {
      focused = true;
      for (const listener of focusListeners) {
        listener();
      }
    },
    emitBlur() {
      focused = false;
      for (const listener of blurListeners) {
        listener();
      }
    },
  };
}

describe('sessionsModel pure helpers (FIXTURE)', () => {
  test('deduplicates by ID keeping latest activity and counts distinct hosts', () => {
    const olderDup = makeSessionFixture({
      id: 'sess-dup-fixture',
      name: 'Older Copy',
      host: { id: 'host-a', name: 'Workstation Alpha' },
      status: 'idle',
      lastActivityAt: '2026-11-13T12:00:00.000Z',
    });
    const newerDup = makeSessionFixture({
      id: 'sess-dup-fixture',
      name: 'Newer Copy',
      host: { id: 'host-a', name: 'Workstation Alpha' },
      status: 'needs_input',
      lastActivityAt: '2026-11-13T12:10:00.000Z',
    });
    const remoteHostFixture = makeSessionFixture({
      id: 'sess-remote-fixture',
      name: 'Remote Build',
      host: { id: 'ssh-prod-1', name: 'Prod Runner' },
      status: 'working',
      lastActivityAt: '2026-11-13T12:05:00.000Z',
    });

    const deduped = deduplicateSessionsById([
      olderDup,
      remoteHostFixture,
      newerDup,
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.find(s => s.id === 'sess-dup-fixture')?.name).toBe(
      'Newer Copy',
    );

    const summary = computeSessionsHeaderSummary([
      olderDup,
      remoteHostFixture,
      newerDup,
    ]);
    expect(summary).toEqual({
      sessionCount: 2,
      hostCount: 2,
      needsInputCount: 1,
    });
  });

  test('formatHostName shows real API host name without adding Local or SSH labels', () => {
    const sshIdHostFixture = makeSessionFixture({
      id: 'sess-host-ssh-fixture',
      host: { id: 'ssh:build-box-2', name: 'Build Box Two' },
    });
    const localIdHostFixture = makeSessionFixture({
      id: 'sess-host-local-fixture',
      host: { id: 'local', name: 'Workstation A' },
    });

    expect(formatHostName(sshIdHostFixture)).toBe('Build Box Two');
    expect(formatHostName(localIdHostFixture)).toBe('Workstation A');
  });

  test('filterSessionsByCategory maps canonical statuses and confines unknown statuses to all', () => {
    const fixtures = [
      makeSessionFixture({ id: 's-ni', status: 'needs_input' }),
      makeSessionFixture({ id: 's-work', status: 'working' }),
      makeSessionFixture({ id: 's-start', status: 'starting' }),
      makeSessionFixture({ id: 's-err', status: 'error' }),
      makeSessionFixture({ id: 's-disc', status: 'disconnected' }),
      makeSessionFixture({ id: 's-idle', status: 'idle' }),
      makeSessionFixture({ id: 's-done', status: 'done' }),
      makeSessionFixture({ id: 's-unk', status: 'awaiting_custom_hook' }),
    ];

    expect(filterSessionsByCategory(fixtures, 'all').map(s => s.id)).toEqual([
      's-ni',
      's-work',
      's-start',
      's-err',
      's-disc',
      's-idle',
      's-done',
      's-unk',
    ]);
    expect(
      filterSessionsByCategory(fixtures, 'need-input').map(s => s.id),
    ).toEqual(['s-ni']);
    expect(
      filterSessionsByCategory(fixtures, 'running').map(s => s.id),
    ).toEqual(['s-work', 's-start']);
    expect(filterSessionsByCategory(fixtures, 'error').map(s => s.id)).toEqual([
      's-err',
      's-disc',
    ]);
    expect(
      filterSessionsByCategory(fixtures, 'done/idle').map(s => s.id),
    ).toEqual(['s-idle', 's-done']);
  });

  test('buildSessionsListTree nests children under present parents, promotes orphan/filtered children to roots, and survives cycles', () => {
    const parent = makeSessionFixture({
      id: 'sess-parent',
      name: 'Parent Orchestrator',
      status: 'idle',
      lastActivityAt: '2026-11-13T12:00:00.000Z',
    });
    const childNeedsInput = makeSessionFixture({
      id: 'sess-child-ni',
      name: 'Child Waiting',
      parentSessionId: 'sess-parent',
      status: 'needs_input',
      lastActivityAt: '2026-11-13T11:55:00.000Z',
    });
    const orphanChild = makeSessionFixture({
      id: 'sess-orphan',
      name: 'Orphan Child',
      parentSessionId: 'sess-missing-parent',
      status: 'working',
      lastActivityAt: '2026-11-13T12:10:00.000Z',
    });
    const cycleA = makeSessionFixture({
      id: 'sess-cycle-a',
      name: 'Cycle A',
      parentSessionId: 'sess-cycle-b',
      status: 'idle',
      lastActivityAt: '2026-11-13T11:00:00.000Z',
    });
    const cycleB = makeSessionFixture({
      id: 'sess-cycle-b',
      name: 'Cycle B',
      parentSessionId: 'sess-cycle-a',
      status: 'idle',
      lastActivityAt: '2026-11-13T10:00:00.000Z',
    });

    const allTree = buildSessionsListTree(
      [parent, childNeedsInput, orphanChild, cycleA, cycleB, childNeedsInput],
      'all',
    );
    expect(allTree.totalLoadedCount).toBe(5);
    expect(allTree.rootSessions.map(s => s.id)).toEqual([
      'sess-parent',
      'sess-orphan',
      'sess-cycle-a',
    ]);
    expect(allTree.childrenByParentId.get('sess-parent')?.map(s => s.id)).toEqual([
      'sess-child-ni',
    ]);
    expect(allTree.childrenByParentId.get('sess-cycle-a')?.map(s => s.id)).toEqual([
      'sess-cycle-b',
    ]);
    expect(allTree.needsInputParentIds.has('sess-parent')).toBe(true);

    // Filtering by Need input promotes childNeedsInput to root because parent is idle.
    const niTree = buildSessionsListTree(
      [parent, childNeedsInput, orphanChild],
      'need-input',
    );
    expect(niTree.rootSessions.map(s => s.id)).toEqual(['sess-child-ni']);
    expect(niTree.childrenByParentId.size).toBe(0);
    expect(niTree.parentTitleById.get('sess-parent')).toBe(
      'Parent Orchestrator',
    );
  });

  test('formatRelativeActivity formats seconds, minutes, hours, days, and invalid dates', () => {
    expect(
      formatRelativeActivity('2026-11-13T12:14:30.000Z', FIXED_NOW_MS),
    ).toBe('Just now');
    expect(
      formatRelativeActivity('2026-11-13T12:10:00.000Z', FIXED_NOW_MS),
    ).toBe('5m ago');
    expect(
      formatRelativeActivity('2026-11-13T09:15:00.000Z', FIXED_NOW_MS),
    ).toBe('3h ago');
    expect(
      formatRelativeActivity('2026-11-11T12:15:00.000Z', FIXED_NOW_MS),
    ).toBe('2d ago');
    expect(formatRelativeActivity('not-a-date', FIXED_NOW_MS)).toBe('Unknown');
  });
});

describe('SessionsScreen (FIXTURE)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  test('renders multi-host fixtures, needs_input highlight, duplicate names by ID, filters, unknown status only in All, and no visible IDs or Local/SSH tags', async () => {
    mockConfiguredKeystore();
    const sessionsFixture = [
      makeSessionFixture({
        id: 'sess-dup-1',
        name: 'Deploy API',
        task: 'Await approval for production migration',
        host: { id: 'ssh-prod-1', name: 'Prod Box' },
        project: { id: 'proj-alpha', name: 'Growth Core' },
        harness: { id: 'local:claude', name: 'Claude Code', command: 'claude' },
        worktree: { branch: 'feat/mobile-sessions' },
        status: 'needs_input',
        lastActivityAt: '2026-11-13T12:10:00.000Z',
      }),
      makeSessionFixture({
        id: 'sess-dup-2',
        name: 'Deploy API',
        task: 'Running integration checks',
        host: { id: 'local', name: 'Dev Workstation' },
        project: { id: 'proj-beta', name: 'Mobile Client' },
        harness: { id: 'local:codex', name: 'Codex', command: 'codex' },
        worktree: { branch: 'main' },
        status: 'working',
        lastActivityAt: '2026-11-13T12:12:00.000Z',
      }),
      makeSessionFixture({
        id: 'sess-child-err',
        name: 'Subtask Linter',
        parentSessionId: 'sess-dup-2',
        task: 'Lint failed on CI check',
        host: { id: 'local', name: 'Dev Workstation' },
        project: { id: 'proj-beta', name: 'Mobile Client' },
        harness: { id: 'local:codex', name: 'Codex', command: 'codex' },
        status: 'error',
        lastActivityAt: '2026-11-13T12:00:00.000Z',
      }),
      makeSessionFixture({
        id: 'sess-orphan-done',
        name: 'Orphan Cleanup',
        parentSessionId: 'sess-nonexistent-parent',
        task: 'Orphan Cleanup',
        host: { id: 'local', name: 'Dev Workstation' },
        project: { id: 'proj-gamma', name: 'Ops Scripts' },
        harness: { id: 'local:gemini', name: 'Gemini', command: 'gemini' },
        status: 'done',
        lastActivityAt: '2026-11-13T10:15:00.000Z',
      }),
      makeSessionFixture({
        id: 'sess-unknown-status',
        name: 'Custom State Session',
        task: 'Paused by custom webhook',
        host: { id: 'ssh-prod-1', name: 'Prod Box' },
        project: { id: 'proj-alpha', name: 'Growth Core' },
        harness: { id: 'local:codex', name: 'Codex', command: 'codex' },
        status: 'custom_queued',
        lastActivityAt: '2026-11-13T11:15:00.000Z',
      }),
    ];

    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: sessionsFixture,
      }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);
    const onOpenSessionChat = jest.fn();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <SafeAreaInsetsContext.Provider
            value={{ top: 24, right: 0, bottom: 0, left: 0 }}>
            <SessionsScreen
              onOpenSessionChat={onOpenSessionChat}
              onOpenSettings={jest.fn()}
              apiClient={client}
              credentialCache={cache}
              allowDebugLoopback={false}
              now={() => FIXED_NOW_MS}
            />
          </SafeAreaInsetsContext.Provider>,
        );
        await flushAsync();
      });

      const root = renderer.root.findByProps({ testID: 'sessions-root' });
      const rootStyle = Object.assign(
        {},
        ...(Array.isArray(root.props.style)
          ? root.props.style
          : [root.props.style]),
      );
      expect(rootStyle.paddingTop).toBe(24);
      expect(rootStyle.backgroundColor).toBe('#0d1117');

      const allText = getAllText(renderer);
      expect(allText).toContain('5 sessions');
      expect(allText).toContain('2 hosts');
      expect(allText).toContain('1 need input');
      expect(allText).toContain('Growth Core');
      expect(allText).toContain('Prod Box');
      expect(allText).toContain('Dev Workstation');
      expect(allText).toContain('feat/mobile-sessions');
      expect(allText).toContain('5m ago');
      expect(allText).toContain('custom_queued');
      // Never expose session IDs or infer Local/SSH labels
      expect(allText).not.toContain('sess-dup-1');
      expect(allText).not.toContain('sess-dup-2');
      expect(allText).not.toContain('sess-orphan-done');
      expect(allText).not.toContain('SSH');
      expect(allText).not.toContain('Local');

      // Duplicate session names navigate by their distinct session IDs.
      const card1 = renderer.root.findByProps({
        testID: 'sessions-card-sess-dup-1',
      });
      const card2 = renderer.root.findByProps({
        testID: 'sessions-card-sess-dup-2',
      });
      await ReactTestRenderer.act(async () => {
        card1.props.onPress();
        card2.props.onPress();
      });
      expect(onOpenSessionChat).toHaveBeenNthCalledWith(1, 'sess-dup-1');
      expect(onOpenSessionChat).toHaveBeenNthCalledWith(2, 'sess-dup-2');

      // Expand child under sess-dup-2 and tap child card.
      expect(
        renderer.root.findAllByProps({
          testID: 'sessions-child-card-sess-child-err',
        }),
      ).toHaveLength(0);
      const childrenToggle = renderer.root.findByProps({
        testID: 'sessions-children-toggle-sess-dup-2',
      });
      await ReactTestRenderer.act(async () => {
        childrenToggle.props.onPress();
      });
      const childCard = renderer.root.findByProps({
        testID: 'sessions-child-card-sess-child-err',
      });
      await ReactTestRenderer.act(async () => {
        childCard.props.onPress();
      });
      expect(onOpenSessionChat).toHaveBeenNthCalledWith(3, 'sess-child-err');

      // Filter: Need input -> only sess-dup-1; unknown status is excluded.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'sessions-filter-need-input' })
          .props.onPress();
      });
      expect(
        renderer.root.findAllByProps({ testID: 'sessions-card-sess-dup-1' })
          .length,
      ).toBeGreaterThan(0);
      expect(
        renderer.root.findAllByProps({ testID: 'sessions-card-sess-dup-2' }),
      ).toHaveLength(0);
      expect(getAllText(renderer)).not.toContain('custom_queued');

      // Filter: Error -> sess-child-err promoted to root because its parent is working.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'sessions-filter-error' })
          .props.onPress();
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'sessions-card-sess-child-err',
        }).length,
      ).toBeGreaterThan(0);
      expect(getAllText(renderer)).toContain('Parent: Deploy API');
      expect(getAllText(renderer)).not.toContain('custom_queued');

      // Filter: Running -> sess-dup-2 only.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'sessions-filter-running' })
          .props.onPress();
      });
      expect(
        renderer.root.findAllByProps({ testID: 'sessions-card-sess-dup-2' })
          .length,
      ).toBeGreaterThan(0);
      expect(getAllText(renderer)).not.toContain('custom_queued');

      // Filter: Done/idle -> orphan child rendered as root without Parent badge.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'sessions-filter-done/idle' })
          .props.onPress();
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'sessions-card-sess-orphan-done',
        }).length,
      ).toBeGreaterThan(0);
      expect(getAllText(renderer)).not.toContain('Parent:');
      expect(getAllText(renderer)).not.toContain('custom_queued');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('hides needs_input counter when zero pending and shows filter empty reset card when filter matches 0', async () => {
    mockConfiguredKeystore();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [
          makeSessionFixture({
            id: 'sess-only-idle',
            name: 'Idle Session',
            status: 'idle',
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
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <SessionsScreen
            onOpenSessionChat={jest.fn()}
            onOpenSettings={jest.fn()}
            apiClient={client}
            credentialCache={cache}
            allowDebugLoopback={false}
          />,
        );
        await flushAsync();
      });

      expect(
        renderer.root.findAllByProps({
          testID: 'sessions-needs-input-counter',
        }),
      ).toHaveLength(0);
      expect(getAllText(renderer)).toContain('1 session');
      expect(getAllText(renderer)).toContain('1 host');

      // Select Error filter (0 matches) -> empty filter card with reset button.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'sessions-filter-error' })
          .props.onPress();
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'sessions-filter-empty-card',
        }).length,
      ).toBeGreaterThan(0);

      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'sessions-filter-reset-button' })
          .props.onPress();
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'sessions-card-sess-only-idle',
        }).length,
      ).toBeGreaterThan(0);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('polls only when focused & foreground, supports pull-to-refresh, stale offline/401, and clears session data on background/lock', async () => {
    jest.useFakeTimers();
    const appStateSpy = setupAppStateSpy();
    const navHarness = createFakeNavigation(true);
    mockConfiguredKeystore();

    const request = jest
      .fn()
      // 1. initial focus load
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-poll-1',
              name: 'Secret Live Task',
              project: { id: 'p1', name: 'Secret Project' },
              status: 'working',
            }),
          ],
        }),
      })
      // 2. 10s poll succeeds
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-poll-1',
              name: 'Secret Live Task',
              project: { id: 'p1', name: 'Secret Project' },
              status: 'working',
            }),
          ],
        }),
      })
      // 3. manual pull-to-refresh fails offline -> stale
      .mockRejectedValueOnce(new Error('Connection refused'))
      // 4. poll recovers -> live
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({
              id: 'sess-poll-1',
              name: 'Secret Live Task',
              project: { id: 'p1', name: 'Secret Project' },
              status: 'idle',
            }),
          ],
        }),
      })
      // 5. manual refresh gets 401 -> stale auth rejected
      .mockResolvedValueOnce({
        status: 401,
        retryAfter: null,
        body: '',
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(true);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <NavigationContext.Provider value={navHarness.navigation as never}>
            <SessionsScreen
              onOpenSessionChat={jest.fn()}
              onOpenSettings={jest.fn()}
              apiClient={client}
              credentialCache={cache}
              allowDebugLoopback={false}
            />
          </NavigationContext.Provider>,
        );
        await flushAsync();
      });

      expect(request).toHaveBeenCalledTimes(1);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(getAllText(renderer)).toContain('Secret Live Task');

      // Blur stops polling.
      await ReactTestRenderer.act(async () => {
        navHarness.emitBlur();
        jest.advanceTimersByTime(25000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(1);

      // Focus resumes immediately using cached credential (no second prompt) and schedules 10s poll.
      await ReactTestRenderer.act(async () => {
        navHarness.emitFocus();
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(keystore.readKey).toHaveBeenCalledTimes(1);

      // Pull-to-refresh fails offline -> stale banner + keeps cached session.
      const scroll = renderer.root.findByProps({ testID: 'sessions-screen' });
      const refreshControl = scroll.props
        .refreshControl as React.ReactElement<
        React.ComponentProps<typeof RefreshControl>
      >;
      await ReactTestRenderer.act(async () => {
        refreshControl.props.onRefresh?.();
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(3);
      expect(
        renderer.root.findByProps({ testID: 'sessions-connection-status' })
          .props.children,
      ).toBe('Stale · Offline');
      expect(getAllText(renderer)).toContain('Secret Live Task');

      // Next scheduled poll recovers to Live.
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10000);
        await flushAsync();
      });
      expect(request).toHaveBeenCalledTimes(4);
      expect(
        renderer.root.findByProps({ testID: 'sessions-connection-status' })
          .props.children,
      ).toBe('Live');

      // Manual refresh hits 401 -> Stale · Auth rejected + Open Settings CTA.
      await ReactTestRenderer.act(async () => {
        refreshControl.props.onRefresh?.();
        await flushAsync();
      });
      expect(
        renderer.root.findByProps({ testID: 'sessions-connection-status' })
          .props.children,
      ).toBe('Stale · Auth rejected');
      expect(
        renderer.root.findAllByProps({
          testID: 'sessions-stale-settings-button',
        }).length,
      ).toBeGreaterThan(0);

      // Going to background clears cached credential and hides all session data.
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync();
      });
      const lockedText = getAllText(renderer);
      expect(lockedText).toContain('Locked');
      expect(lockedText).not.toContain('Secret Live Task');
      expect(lockedText).not.toContain('Secret Project');
      expect(lockedText).not.toContain('1 session');
      expect(
        renderer.root.findAllByProps({ testID: 'sessions-filter-bar' }),
      ).toHaveLength(0);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
      appStateSpy.restore();
      jest.useRealTimers();
    }
  });

  test('App integration: shares single foreground biometric unlock across Dashboard -> Sessions -> SessionChat', async () => {
    const appStateSpy = setupAppStateSpy();
    mockConfiguredKeystore();
    const sharedSession = makeSessionFixture({
      id: 'sess-shared-nav-1',
      name: 'Shared Unlock Session',
      status: 'working',
    });
    const request = jest.fn().mockImplementation(async (req: { url: string }) => {
      if (req.url.endsWith('/sessions/sess-shared-nav-1/history?limit=20')) {
        return {
          status: 200,
          retryAfter: null,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-shared-nav-1',
            available: true,
            source: 'transcript',
            items: [],
            hasMore: false,
          }),
        };
      }
      if (req.url.endsWith('/sessions/sess-shared-nav-1/output?lines=200')) {
        return {
          status: 200,
          retryAfter: null,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-shared-nav-1',
            available: true,
            status: 'live',
            output: 'live output line',
          }),
        };
      }
      if (req.url.endsWith('/sessions/sess-shared-nav-1')) {
        return {
          status: 200,
          retryAfter: null,
          body: JSON.stringify({
            apiVersion: 'v1',
            session: sharedSession,
          }),
        };
      }
      return {
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [sharedSession],
        }),
      };
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

      // Dashboard unlocked once.
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);

      // Navigate to SessionsTab via tab bar button.
      const sessionsTabButton = renderer.root.findByProps({
        testID: 'sessions-tab-button',
      });
      await ReactTestRenderer.act(async () => {
        sessionsTabButton.props.onPress();
        await flushAsync(8);
      });

      // No second biometric prompt when switching to Sessions!
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(getAllText(renderer)).toContain('Shared Unlock Session');

      // Tap card on Sessions -> opens SessionChat for sess-shared-nav-1 without extra prompt.
      const sessionCard = renderer.root.findByProps({
        testID: 'sessions-card-sess-shared-nav-1',
      });
      await ReactTestRenderer.act(async () => {
        sessionCard.props.onPress();
        await flushAsync(8);
      });

      expect(
        renderer.root.findByProps({ testID: 'session-chat-title' }).props
          .children,
      ).toBe('Shared Unlock Session');
      expect(getAllText(renderer)).not.toContain('sess-shared-nav-1');
      expect(keystore.readKey).toHaveBeenCalledTimes(1);
      expect(
        request.mock.calls.some(call =>
          String((call[0] as { url: string }).url).includes(
            '/sessions/sess-shared-nav-1',
          ),
        ),
      ).toBe(true);

      // Background clears credential and hides SessionChat + Sessions data.
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(6);
      });
      expect(getAllText(renderer)).not.toContain('sess-shared-nav-1');
      expect(getAllText(renderer)).not.toContain('Shared Unlock Session');
    } finally {
      delete (NativeModules as { SpawneaHttp?: unknown }).SpawneaHttp;
      if (renderer) {
        await ReactTestRenderer.act(async () => {
          renderer.unmount();
        });
      }
      defaultSessionCredentialCache.dispose();
      appStateSpy.restore();
    }
  });

  test('collapsed parent and nested ancestor expose visible text and accessibilityLabel when child transitions working -> needs_input without altering parent status', async () => {
    jest.useFakeTimers();
    const appStateSpy = setupAppStateSpy();
    mockConfiguredKeystore();

    const rootParent = makeSessionFixture({
      id: 'sess-collapse-root',
      name: 'Release Coordinator',
      status: 'working',
      lastActivityAt: '2026-11-13T12:12:00.000Z',
    });
    const midBranch = makeSessionFixture({
      id: 'sess-collapse-mid',
      name: 'Migration Runner',
      parentSessionId: 'sess-collapse-root',
      status: 'working',
      lastActivityAt: '2026-11-13T12:11:00.000Z',
    });
    const leafWorker = makeSessionFixture({
      id: 'sess-collapse-leaf',
      name: 'Schema Verifier',
      parentSessionId: 'sess-collapse-mid',
      status: 'working',
      lastActivityAt: '2026-11-13T12:10:00.000Z',
    });

    const payload = (sessions: unknown[]) => ({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions,
      }),
    });

    const request = jest
      .fn()
      .mockResolvedValueOnce(payload([rootParent, midBranch, leafWorker]))
      .mockResolvedValue(
        payload([
          rootParent,
          midBranch,
          { ...leafWorker, status: 'needs_input' },
        ]),
      );

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });
    const cache = new SessionCredentialCache(false);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <SessionsScreen
            onOpenSessionChat={jest.fn()}
            onOpenSettings={jest.fn()}
            apiClient={client}
            credentialCache={cache}
            allowDebugLoopback={false}
            now={() => FIXED_NOW_MS}
          />,
        );
        await flushAsync(8);
      });

      const rootToggle = () =>
        renderer.root.findByProps({
          testID: 'sessions-children-toggle-sess-collapse-root',
        });

      // User expands root, expands nested child, then collapses both branches.
      await ReactTestRenderer.act(async () => {
        rootToggle().props.onPress();
      });
      const midToggle = () =>
        renderer.root.findByProps({
          testID: 'sessions-children-toggle-sess-collapse-mid',
        });
      await ReactTestRenderer.act(async () => {
        midToggle().props.onPress();
      });
      expect(getAllText(renderer)).toContain('Schema Verifier');

      await ReactTestRenderer.act(async () => {
        midToggle().props.onPress();
      });
      await ReactTestRenderer.act(async () => {
        rootToggle().props.onPress();
      });
      expect(getAllText(renderer)).not.toContain('Schema Verifier');
      expect(rootToggle().props.accessibilityLabel).toBe(
        '1 child. Expand child sessions',
      );

      // Next poll: leaf transitions working -> needs_input while root & mid stay collapsed.
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10000);
        await flushAsync(8);
      });

      expect(request).toHaveBeenCalledTimes(2);
      expect(getAllText(renderer)).toContain('1 need input');
      expect(getAllText(renderer)).not.toContain('Schema Verifier');
      // Parent card keeps its own `Working` status semantics.
      expect(
        renderer.root.findByProps({
          testID: 'sessions-card-sess-collapse-root',
        }).props.accessibilityLabel,
      ).toBe('Release Coordinator, Working');
      // Collapsed ancestor toggle surfaces textual and accessible attention cue.
      expect(rootToggle().props.accessibilityLabel).toBe(
        '1 child, 1 need input. Expand child sessions',
      );
      expect(getAllText(renderer)).toContain('1 child · 1 need input');

      // Expanding root keeps intermediate child collapsed and transfers the cue to midToggle.
      await ReactTestRenderer.act(async () => {
        rootToggle().props.onPress();
      });
      expect(rootToggle().props.accessibilityLabel).toBe(
        '1 child. Collapse child sessions',
      );
      expect(
        renderer.root.findByProps({
          testID: 'sessions-child-card-sess-collapse-mid',
        }).props.accessibilityLabel,
      ).toBe('Migration Runner, Working');
      expect(midToggle().props.accessibilityLabel).toBe(
        '1 child, 1 need input. Expand child sessions',
      );
      expect(getAllText(renderer)).toContain('1 child · 1 need input');

      // Expanding mid reveals the transitioned child exactly once.
      await ReactTestRenderer.act(async () => {
        midToggle().props.onPress();
      });
      expect(
        getAllText(renderer).split('Schema Verifier').length - 1,
      ).toBe(1);
      expect(
        renderer.root.findByProps({
          testID: 'sessions-child-card-sess-collapse-leaf',
        }).props.accessibilityLabel,
      ).toBe('Schema Verifier, Needs input');
      expect(getAllText(renderer)).toContain('3 sessions');

      // Verify helper label formatting for multi-descendant collapsed branches.
      expect(formatChildrenToggleLabels(2, false, 2)).toEqual({
        visibleLabel: '2 children · 2 need input',
        accessibilityLabel:
          '2 children, 2 need input. Expand child sessions',
      });
    } finally {
      if (renderer) {
        await ReactTestRenderer.act(async () => {
          renderer.unmount();
        });
      }
      cache.dispose();
      appStateSpy.restore();
      jest.useRealTimers();
    }
  });
});
