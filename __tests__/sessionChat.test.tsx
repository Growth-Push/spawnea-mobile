import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {
  AppState,
  Keyboard,
  NativeModules,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  createNativeHttpTransport,
  SpawneaApiClient,
} from '../src/api/client';
import type {
  SendMessageResponse,
  SessionHistoryItem,
  SessionHistoryResponse,
} from '../src/api/types';
import {
  applyHistoryFetchResult,
  createClientRequestId,
  didTranscriptCursorReset,
  evaluateRetryGate,
  evaluateSendGate,
  formatItemTimestamp,
  groupHistoryItemsByTurn,
  isScrollNearBottom,
  mapSendFailureToSubmission,
  mapSendResponseToSubmission,
  mergeTranscriptItems,
  SessionChatSnapshot,
  sliceOutputTail,
} from '../src/chat/chatModel';
import { SessionChatScreen } from '../src/screens/SessionChatScreen';
import { SessionCredentialCache } from '../src/storage/sessionCredentialCache';
import { makeSessionFixture } from './apiClient.test';

const TEST_URL = 'https://workstation.tailnet.ts.net:5757';
const TEST_KEY = 'dummy-chat-test-key-never-rendered';

const keystore = NativeModules.SpawneaKeystore as {
  getCapability: jest.Mock;
  getCredentialState: jest.Mock;
  hasKey: jest.Mock;
  saveCredentials: jest.Mock;
  updateServerUrl: jest.Mock;
  readKey: jest.Mock;
  deleteKey: jest.Mock;
};

async function flushAsync(turns = 8): Promise<void> {
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

function makeChatTransport(overrides: {
  session?: ReturnType<typeof makeSessionFixture>;
  historyHandler?: (url: string) => {
    status: number;
    retryAfter?: string | null;
    body: string;
  };
  outputHandler?: (url: string) => {
    status: number;
    retryAfter?: string | null;
    body: string;
  };
  detailHandler?: (url: string) => {
    status: number;
    retryAfter?: string | null;
    body: string;
  };
  messageHandler?: (req: {
    url: string;
    body?: string;
  }) => Promise<{ status: number; retryAfter?: string | null; body: string }>;
}) {
  const session =
    overrides.session ??
    makeSessionFixture({
      id: 'sess-fixture-codex-1',
      name: 'Fixture Codex Chat',
      status: 'idle',
      task: 'Verify chat screen',
      project: { id: 'proj-1', name: 'spawnea-mobile' },
      worktree: { branch: 'feat/chat' },
    });

  return jest.fn(async (req: { method: string; url: string; body?: string }) => {
    if (req.method === 'POST' && req.url.includes('/message')) {
      if (overrides.messageHandler) {
        return overrides.messageHandler(req);
      }
      return {
        status: 202,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: session.id,
          delivered: true,
          deliveryMethod: 'submit',
          replayed: false,
          status: 'delivered',
        } satisfies SendMessageResponse),
      };
    }
    if (req.url.includes('/history')) {
      if (overrides.historyHandler) {
        return overrides.historyHandler(req.url);
      }
      return {
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: session.id,
          available: true,
          source: 'transcript',
          items: [
            {
              id: 'item-u1',
              role: 'user',
              source: 'transcript',
              text: 'Run smoke checks',
              timestamp: '2026-11-14T15:00:00.000Z',
              turnId: 'turn-1',
              turnBoundary: 'start',
            },
            {
              id: 'item-a1',
              role: 'agent',
              source: 'transcript',
              text: 'All checks passed cleanly.',
              timestamp: '2026-11-14T15:01:00.000Z',
              turnId: 'turn-1',
              turnBoundary: 'end',
            },
          ],
          hasMore: false,
          cursor: 'cursor-1',
        } satisfies SessionHistoryResponse),
      };
    }
    if (req.url.includes('/output')) {
      if (overrides.outputHandler) {
        return overrides.outputHandler(req.url);
      }
      return {
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: session.id,
          available: true,
          status: 'live',
          output: 'line 1\nline 2',
        }),
      };
    }
    if (overrides.detailHandler) {
      return overrides.detailHandler(req.url);
    }
    return {
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        session,
      }),
    };
  });
}

async function renderUnlockedChatScreen(params: {
  sessionId?: string;
  request: jest.Mock;
  pollIntervalMs?: number;
  now?: () => number;
  onOpenSettings?: jest.Mock;
  navigation?: {
    setParams?: jest.Mock;
    addListener?: jest.Mock;
    isFocused?: jest.Mock;
  };
}) {
  mockConfiguredKeystore();
  const apiClient = new SpawneaApiClient({
    transport: { request: params.request },
    allowDebugLoopback: true,
    ...(params.now ? { now: params.now } : {}),
  });
  const cache = new SessionCredentialCache();
  await cache.unlockAndGetCredentials({
    apiClient,
    allowDebugLoopback: true,
  });

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <SessionChatScreen
        route={{ params: { sessionId: params.sessionId ?? 'sess-fixture-codex-1' } }}
        navigation={params.navigation}
        onOpenSettings={params.onOpenSettings}
        credentialCache={cache}
        apiClient={apiClient}
        allowDebugLoopback={true}
        pollIntervalMs={params.pollIntervalMs ?? 60_000}
        now={params.now ?? (() => Date.parse('2026-11-14T15:05:10.000Z'))}
      />,
    );
    await flushAsync(10);
  });

  return { renderer, apiClient, cache };
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

describe('chatModel pure helpers', () => {
  test('(FIXTURE) groups items by turnId, collapses consecutive tool calls, and preserves absent timestamps', () => {
    const items: SessionHistoryItem[] = [
      {
        id: 'u1',
        role: 'user',
        source: 'transcript',
        text: 'Inspect repo',
        timestamp: '2026-11-14T14:20:00.000Z',
        turnId: 'turn-1',
        turnBoundary: 'start',
      },
      {
        id: 't1',
        role: 'tool',
        source: 'transcript',
        text: 'Ran grep',
        turnId: 'turn-1',
        textTruncated: true,
      },
      {
        id: 't2',
        role: 'tool',
        source: 'transcript',
        text: 'Read file',
        turnId: 'turn-1',
      },
      {
        id: 'a1',
        role: 'agent',
        source: 'transcript',
        text: 'Found issue.',
        turnId: 'turn-1',
        turnBoundary: 'end',
      },
    ];

    const groups = groupHistoryItemsByTurn(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].turnId).toBe('turn-1');
    expect(groups[0].segments.map(s => s.kind)).toEqual([
      'user',
      'tool_group',
      'agent',
    ]);
    const toolGroup = groups[0].segments[1];
    expect(toolGroup.kind).toBe('tool_group');
    if (toolGroup.kind === 'tool_group') {
      expect(toolGroup.items).toHaveLength(2);
      expect(toolGroup.hasTruncated).toBe(true);
    }
    expect(formatItemTimestamp(undefined)).toBeNull();
    expect(formatItemTimestamp('invalid-date')).toBeNull();
  });

  test('(FIXTURE) applyHistoryFetchResult handles transcript cursor merge and screen fingerprint semantics', () => {
    const baseSnapshot: SessionChatSnapshot = {
      session: makeSessionFixture({ id: 'sess-fixture-1' }),
      historyAvailable: true,
      historySource: 'transcript',
      historyItems: [
        {
          id: 'm1',
          role: 'user',
          source: 'transcript',
          text: 'hi',
          turnId: 't1',
          turnBoundary: 'start',
        },
        {
          id: 'm2',
          role: 'agent',
          source: 'transcript',
          text: 'working',
          turnId: 't1',
        },
      ],
      historyHasMore: true,
      historyCursor: 'c1',
      outputAvailable: true,
      outputStatus: 'live',
      outputText: 'ok',
      lastFetchedAtMs: 1000,
      serverUrl: TEST_URL,
      credentialGeneration: 0,
    };

    const updatedTranscript = applyHistoryFetchResult(
      baseSnapshot,
      {
        apiVersion: 'v1',
        sessionId: 'sess-fixture-1',
        available: true,
        source: 'transcript',
        items: [
          {
            id: 'm2',
            role: 'agent',
            source: 'transcript',
            text: 'working',
            turnId: 't1',
            turnBoundary: 'end',
          },
          {
            id: 'm3',
            role: 'user',
            source: 'transcript',
            text: 'next',
            turnId: 't2',
            turnBoundary: 'single',
          },
        ],
        hasMore: false,
        cursor: 'c2',
      },
      true,
    );
    expect(updatedTranscript.historyItems.map(i => i.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    expect(updatedTranscript.historyItems[1].turnBoundary).toBe('end');
    expect(updatedTranscript.historyCursor).toBe('c2');

    const screenSnapshot: SessionChatSnapshot = {
      ...baseSnapshot,
      historySource: 'screen',
      historyItems: [
        { id: 'screen-1', role: 'agent', source: 'screen', text: '$ pwd' },
      ],
      historyCursor: 'line:1:fp:abcd',
    };

    // Unchanged cursor delta on screen source returns empty array -> keep cached snapshot.
    const unchangedScreen = applyHistoryFetchResult(
      screenSnapshot,
      {
        apiVersion: 'v1',
        sessionId: 'sess-fixture-1',
        available: true,
        source: 'screen',
        items: [],
        hasMore: false,
        cursor: 'line:1:fp:abcd',
      },
      true,
    );
    expect(unchangedScreen.historyItems).toEqual([
      { id: 'screen-1', role: 'agent', source: 'screen', text: '$ pwd' },
    ]);

    // Changed fingerprint resets to line 0 and replaces items.
    const changedScreen = applyHistoryFetchResult(
      screenSnapshot,
      {
        apiVersion: 'v1',
        sessionId: 'sess-fixture-1',
        available: true,
        source: 'screen',
        items: [
          {
            id: 'screen-1',
            role: 'agent',
            source: 'screen',
            text: '$ pwd\n/workspace',
          },
        ],
        hasMore: false,
        cursor: 'line:2:fp:ef01',
      },
      true,
    );
    expect(changedScreen.historyItems).toEqual([
      {
        id: 'screen-1',
        role: 'agent',
        source: 'screen',
        text: '$ pwd\n/workspace',
      },
    ]);

    expect(
      mergeTranscriptItems(
        [{ id: 'a', role: 'user', source: 'transcript', text: 'one' }],
        [{ id: 'a', role: 'user', source: 'transcript', text: 'one-updated' }],
      ),
    ).toEqual([
      { id: 'a', role: 'user', source: 'transcript', text: 'one-updated' },
    ]);
  });

  test('(FIXTURE) sliceOutputTail keeps last 12 lines collapsed and expands all lines', () => {
    const lines = Array.from({ length: 16 }, (_, idx) => `line-${idx + 1}`).join(
      '\n',
    );
    const collapsed = sliceOutputTail(lines, false, 12);
    expect(collapsed.totalLines).toBe(16);
    expect(collapsed.hiddenAboveCount).toBe(4);
    expect(collapsed.visibleText.startsWith('line-5\n')).toBe(true);
    expect(collapsed.visibleText.endsWith('line-16')).toBe(true);

    const expanded = sliceOutputTail(lines, true, 12);
    expect(expanded.hiddenAboveCount).toBe(0);
    expect(expanded.visibleText.startsWith('line-1\n')).toBe(true);
  });

  test('(FIXTURE) evaluateSendGate and submission mappers handle status gating, unknown, replay, 409, and 422', () => {
    const workingGate = evaluateSendGate({
      isForeground: true,
      hasUnlockedCredential: true,
      isAuthPaused: false,
      session: makeSessionFixture({ id: 's1', status: 'working' }),
      submissionStatus: null,
      draftText: 'hello',
    });
    expect(workingGate.allowed).toBe(false);
    expect(workingGate.reason).toContain('Working');

    const needsInputGate = evaluateSendGate({
      isForeground: true,
      hasUnlockedCredential: true,
      isAuthPaused: false,
      session: makeSessionFixture({ id: 's1', status: 'needs_input' }),
      submissionStatus: null,
      draftText: 'yes',
    });
    expect(needsInputGate.allowed).toBe(true);

    const unknownSub = mapSendResponseToSubmission(
      {
        apiVersion: 'v1',
        sessionId: 's1',
        delivered: false,
        deliveryMethod: 'submit',
        replayed: false,
        status: 'unknown',
      },
      'mob-1',
      'hello',
    );
    expect(unknownSub.status).toBe('unknown');

    const replaySub = mapSendResponseToSubmission(
      {
        apiVersion: 'v1',
        sessionId: 's1',
        delivered: true,
        deliveryMethod: 'submit',
        replayed: true,
        status: 'delivered',
      },
      'mob-1',
      'hello',
    );
    expect(replaySub.status).toBe('delivered');
    expect(replaySub.replayed).toBe(true);

    const conflictDifferentSub = mapSendFailureToSubmission(
      {
        ok: false,
        category: 'invalid_request',
        status: 409,
        retryAfterSeconds: null,
        errorCode: 'request_id_conflict',
      },
      'mob-1',
      'new prompt',
    );
    expect(conflictDifferentSub.conflictDifferentPrompt).toBe(true);
    expect(conflictDifferentSub.httpStatus).toBe(409);

    const unprocessableSub = mapSendFailureToSubmission(
      {
        ok: false,
        category: 'invalid_request',
        status: 422,
        retryAfterSeconds: null,
        errorCode: 'needs_human',
      },
      'mob-1',
      'prompt',
    );
    expect(unprocessableSub.httpStatus).toBe(422);
    expect(unprocessableSub.message).toContain('Rejected (HTTP 422)');
    expect(createClientRequestId(1000)).toMatch(/^mob-/);
  });
});

describe('SessionChatScreen contract & failure mode fixtures', () => {
  test('(FIXTURE) renders textTruncated warnings, collapsed tool activity expansion, and bounded output expansion', async () => {
    const request = makeChatTransport({
      historyHandler: () => ({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-fixture-codex-1',
          available: true,
          source: 'transcript',
          hasMore: true,
          cursor: 'c-trunc',
          items: [
            {
              id: 'u-trunc',
              role: 'user',
              source: 'transcript',
              text: 'Long prompt...',
              timestamp: '2026-11-14T15:00:00.000Z',
              turnId: 'turn-trunc',
              turnBoundary: 'start',
              textTruncated: true,
            },
            {
              id: 'tool-1',
              role: 'tool',
              source: 'transcript',
              text: 'read_file output body',
              turnId: 'turn-trunc',
              textTruncated: true,
            },
            {
              id: 'a-trunc',
              role: 'agent',
              source: 'transcript',
              text: 'Partial summary...',
              turnId: 'turn-trunc',
              turnBoundary: 'end',
              textTruncated: true,
            },
          ],
        }),
      }),
      outputHandler: () => ({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-fixture-codex-1',
          available: true,
          status: 'live',
          output: Array.from({ length: 15 }, (_, idx) => `out-${idx + 1}`).join(
            '\n',
          ),
        }),
      }),
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      const textBefore = getAllText(renderer);
      expect(textBefore).toContain('Fixture Codex Chat');
      expect(textBefore).toContain('Recent window');
      expect(textBefore).toContain('Truncated by server');
      expect(textBefore).toContain('Tool activity · 1 tool step');
      expect(textBefore).toContain('Truncated');
      expect(textBefore).not.toContain('read_file output body');
      expect(textBefore).toContain('Show earlier · 3 more lines');
      expect(textBefore).not.toContain('out-1\n');
      expect(textBefore).not.toContain('sess-fixture-codex-1');

      const toolToggle = renderer.root.findByProps({
        testID: 'session-chat-tool-toggle-turn-turn-trunc-tools-tool-1',
      });
      await ReactTestRenderer.act(async () => {
        toolToggle.props.onPress();
      });
      expect(getAllText(renderer)).toContain('read_file output body');

      const outputToggle = renderer.root.findByProps({
        testID: 'session-chat-output-toggle',
      });
      await ReactTestRenderer.act(async () => {
        outputToggle.props.onPress();
      });
      expect(getAllText(renderer)).toContain('out-1');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) unavailable history & output renders explicit server unavailability messages honestly', async () => {
    const request = makeChatTransport({
      historyHandler: () => ({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-fixture-codex-1',
          available: false,
          source: 'screen',
          items: [],
          hasMore: false,
          message: 'Screen buffer not ready on fixture.',
        }),
      }),
      outputHandler: () => ({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-fixture-codex-1',
          available: false,
          status: 'unavailable',
          output: null,
          message: 'Pane disconnected on fixture.',
        }),
      }),
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      const text = getAllText(renderer);
      expect(text).toContain('Screen buffer not ready on fixture.');
      expect(text).toContain('Unavailable');
      expect(text).toContain('Pane disconnected on fixture.');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) handles unknown send, no automatic resend, manual retry with SAME clientRequestId, and discard for NEW ID', async () => {
    const sentRequestIds: string[] = [];
    let attempt = 0;
    const request = makeChatTransport({
      messageHandler: async req => {
        const body = JSON.parse(req.body ?? '{}') as {
          clientRequestId: string;
        };
        sentRequestIds.push(body.clientRequestId);
        attempt += 1;
        if (attempt === 1) {
          return {
            status: 202,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-fixture-codex-1',
              delivered: false,
              deliveryMethod: 'submit',
              replayed: false,
              status: 'unknown',
            }),
          };
        }
        return {
          status: 202,
          retryAfter: null,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-fixture-codex-1',
            delivered: true,
            deliveryMethod: 'submit',
            replayed: true,
            status: 'delivered',
          }),
        };
      },
    });

    let idCounter = 1;
    const { renderer, cache } = await renderUnlockedChatScreen({
      request,
      now: () => 1_760_000_000_000 + idCounter++ * 1000,
    });
    try {
      const input = renderer.root.findByProps({ testID: 'session-chat-input' });
      const sendButton = renderer.root.findByProps({
        testID: 'session-chat-send-button',
      });

      await ReactTestRenderer.act(async () => {
        input.props.onChangeText('Check unknown state');
      });
      await ReactTestRenderer.act(async () => {
        sendButton.props.onPress();
        await flushAsync(8);
      });

      expect(sentRequestIds).toHaveLength(1);
      expect(getAllText(renderer)).toContain('Delivery unknown');
      expect(getAllText(renderer)).toContain('No automatic resend was performed');

      expect(
        renderer.root.findByProps({ testID: 'session-chat-send-button' }).props
          .disabled,
      ).toBe(true);

      // Manual retry reuses the exact same clientRequestId and handles replay response.
      const retryButton = renderer.root.findByProps({
        testID: 'session-chat-retry-send-button',
      });
      await ReactTestRenderer.act(async () => {
        retryButton.props.onPress();
        await flushAsync(8);
      });

      expect(sentRequestIds).toHaveLength(2);
      expect(sentRequestIds[1]).toBe(sentRequestIds[0]);
      expect(getAllText(renderer)).toContain('Delivered (replayed)');

      // Sending a second new prompt generates a different clientRequestId.
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('Second prompt');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(8);
      });
      expect(sentRequestIds).toHaveLength(3);
      expect(sentRequestIds[2]).not.toBe(sentRequestIds[0]);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) double tap deduplication sends only one POST /message while pending', async () => {
    let resolvePost!: (val: {
      status: number;
      retryAfter: null;
      body: string;
    }) => void;
    let postCount = 0;
    const request = makeChatTransport({
      messageHandler: req => {
        postCount += 1;
        JSON.parse(req.body ?? '{}');
        return new Promise(resolve => {
          resolvePost = () =>
            resolve({
              status: 202,
              retryAfter: null,
              body: JSON.stringify({
                apiVersion: 'v1',
                sessionId: 'sess-fixture-codex-1',
                delivered: true,
                deliveryMethod: 'submit',
                replayed: false,
                status: 'delivered',
              }),
            });
        });
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      const input = renderer.root.findByProps({ testID: 'session-chat-input' });
      const sendButton = renderer.root.findByProps({
        testID: 'session-chat-send-button',
      });
      await ReactTestRenderer.act(async () => {
        input.props.onChangeText('Double tap test');
      });

      await ReactTestRenderer.act(async () => {
        sendButton.props.onPress();
        sendButton.props.onPress();
        await flushAsync(4);
      });

      expect(postCount).toBe(1);
      expect(getAllText(renderer)).toContain('Sending...');

      await ReactTestRenderer.act(async () => {
        resolvePost({ status: 202, retryAfter: null, body: '' });
        await flushAsync(8);
      });
      expect(getAllText(renderer)).toContain('Delivered');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) handles HTTP 409, HTTP 422, HTTP 429, and HTTP 401 on send cleanly', async () => {
    const responses = [
      {
        status: 409,
        retryAfter: null,
        body: JSON.stringify({
          error: {
            code: 'conflict',
            message: 'Turn is still open in desktop session.',
          },
        }),
      },
      {
        status: 422,
        retryAfter: null,
        body: JSON.stringify({
          error: {
            code: 'unprocessable',
            message: 'Prompt cannot be empty or too large.',
          },
        }),
      },
      {
        status: 429,
        retryAfter: '12',
        body: JSON.stringify({
          error: { code: 'rate_limited', message: 'Too many requests.' },
        }),
      },
    ];
    let idx = 0;
    const request = makeChatTransport({
      messageHandler: async () => {
        const next = responses[idx];
        idx += 1;
        return next;
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      const typeAndSend = async (msg: string) => {
        await ReactTestRenderer.act(async () => {
          renderer.root
            .findByProps({ testID: 'session-chat-input' })
            .props.onChangeText(msg);
        });
        await ReactTestRenderer.act(async () => {
          renderer.root
            .findByProps({ testID: 'session-chat-send-button' })
            .props.onPress();
          await flushAsync(8);
        });
      };

      await typeAndSend('Prompt 409');
      expect(getAllText(renderer)).toContain('Conflict (HTTP 409)');

      await typeAndSend('Prompt 422');
      expect(getAllText(renderer)).toContain('Rejected (HTTP 422)');

      await typeAndSend('Prompt 429');
      expect(getAllText(renderer)).toContain(
        'Rate limited by server (HTTP 429)',
      );
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }

    const onOpenSettings = jest.fn();
    const request401 = makeChatTransport({
      messageHandler: async () => ({
        status: 401,
        retryAfter: null,
        body: JSON.stringify({
          error: { code: 'unauthorized', message: 'Invalid API key.' },
        }),
      }),
    });
    const unlocked401 = await renderUnlockedChatScreen({
      request: request401,
      onOpenSettings,
    });
    try {
      await ReactTestRenderer.act(async () => {
        unlocked401.renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('Prompt 401');
      });
      await ReactTestRenderer.act(async () => {
        unlocked401.renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(8);
      });
      expect(getAllText(unlocked401.renderer)).toContain(
        'Authentication rejected (HTTP 401)',
      );
      const settingsBtn = unlocked401.renderer.root.findByProps({
        testID: 'session-chat-submission-settings-button',
      });
      await ReactTestRenderer.act(async () => {
        settingsBtn.props.onPress();
      });
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        unlocked401.renderer.unmount();
      });
      unlocked401.cache.dispose();
    }
  });

  test('(FIXTURE) pull-to-refresh omits cursor, offline -> stale -> recovery works, and background locks privacy', async () => {
    const appStateSpy = setupAppStateSpy();
    let failNetwork = false;
    const historyUrls: string[] = [];

    const request = makeChatTransport({
      historyHandler: url => {
        historyUrls.push(url);
        if (failNetwork) {
          throw new Error('Network offline');
        }
        return {
          status: 200,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-fixture-codex-1',
            available: true,
            source: 'transcript',
            items: [
              {
                id: 'item-live-1',
                role: 'agent',
                source: 'transcript',
                text: 'Recovered reply',
                turnId: 'turn-live',
                turnBoundary: 'single',
              },
            ],
            hasMore: false,
            cursor: 'cursor-after-1',
          }),
        };
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      expect(getAllText(renderer)).toContain('Live');
      expect(getAllText(renderer)).toContain('Recovered reply');
      expect(historyUrls[0]).toContain('/history?limit=20');

      // Simulate offline on pull-to-refresh -> Stale preserving snapshot
      failNetwork = true;
      const refreshControl = renderer.root.findByType(RefreshControl);
      await ReactTestRenderer.act(async () => {
        refreshControl.props.onRefresh();
        await flushAsync(8);
      });
      expect(getAllText(renderer)).toContain('Stale · Offline');
      expect(getAllText(renderer)).toContain('Recovered reply');
      expect(historyUrls[1]).toBe(
        `${TEST_URL}/api/v1/sessions/sess-fixture-codex-1/history?limit=20`,
      );

      // Restore network -> manual refresh returns to Live
      failNetwork = false;
      await ReactTestRenderer.act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
        await flushAsync(8);
      });
      expect(getAllText(renderer)).toContain('Live');

      // Background hides chat data immediately
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(4);
      });
      expect(getAllText(renderer)).not.toContain('Recovered reply');
      expect(getAllText(renderer)).toContain('Locked');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
      appStateSpy.restore();
    }
  });

  test('(FIXTURE) send gating blocks sending on non-idle/working sessions and discard clears unknown/failed state with new clientRequestId', async () => {
    const request = makeChatTransport({
      session: makeSessionFixture({
        id: 'sess-fixture-codex-1',
        name: 'Working Codex Fixture',
        status: 'working',
      }),
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      const gateText = getAllText(renderer);
      expect(gateText).toContain('Working Codex Fixture');
      expect(gateText).toContain('Sending is blocked while session is Working');
      expect(
        renderer.root.findByProps({ testID: 'session-chat-send-button' }).props
          .disabled,
      ).toBe(true);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) SpawneaApiClient parses turnBoundary on /history and errorCode/serverMessage on 409/422 without altering empty-body errors', async () => {
    const client = new SpawneaApiClient({
      transport: {
        request: jest.fn(async (req: { url: string }) => {
          if (req.url.includes('/history')) {
            return {
              status: 200,
              retryAfter: null,
              body: JSON.stringify({
                apiVersion: 'v1',
                sessionId: 'sess-fixture-1',
                available: true,
                source: 'transcript',
                items: [
                  {
                    id: 'i1',
                    role: 'user',
                    source: 'transcript',
                    text: 'hi',
                    turnId: 't1',
                    turnBoundary: 'start',
                  },
                ],
                hasMore: false,
              }),
            };
          }
          if (req.url.includes('/message')) {
            return {
              status: 409,
              retryAfter: null,
              body: JSON.stringify({
                error: {
                  code: 'conflict',
                  message: 'Open turn conflict',
                },
              }),
            };
          }
          return {
            status: 500,
            retryAfter: null,
            body: '',
          };
        }),
      },
      allowDebugLoopback: true,
    });

    const historyRes = await client.getSessionHistory(
      { serverUrl: TEST_URL, apiKey: TEST_KEY },
      'sess-fixture-1',
      { limit: 20 },
    );
    expect(historyRes.ok).toBe(true);
    if (historyRes.ok) {
      expect(historyRes.data.items[0].turnBoundary).toBe('start');
    }

    const conflictRes = await client.sendMessage(
      { serverUrl: TEST_URL, apiKey: TEST_KEY },
      'sess-fixture-1',
      { message: 'hello', clientRequestId: 'mob-123' },
    );
    expect(conflictRes).toEqual({
      ok: false,
      category: 'server_error',
      status: 409,
      retryAfterSeconds: null,
      errorCode: 'open_turn_conflict',
    });
  });
});

describe('Round 1 review & UX regression fixes (F1-F8)', () => {
  test('(FIXTURE) F1 rejects superseded POST completion after switching sessions', async () => {
    let rejectPendingA!: (err: Error) => void;
    let postCallCount = 0;
    const sessionA = makeSessionFixture({
      id: 'sess-fixture-a',
      name: 'Session Alpha',
      status: 'idle',
    });
    const sessionB = makeSessionFixture({
      id: 'sess-fixture-b',
      name: 'Session Beta',
      status: 'idle',
    });

    const request = jest.fn(
      async (req: { method: string; url: string; body?: string }) => {
        if (req.method === 'POST' && req.url.includes('/message')) {
          postCallCount += 1;
          if (req.url.includes('sess-fixture-a')) {
            return new Promise<never>((_resolve, reject) => {
              rejectPendingA = reject;
            });
          }
          return {
            status: 202,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-fixture-b',
              delivered: true,
              deliveryMethod: 'submit',
              status: 'delivered',
            }),
          };
        }
        const sid = req.url.includes('sess-fixture-b')
          ? 'sess-fixture-b'
          : 'sess-fixture-a';
        const target = sid === 'sess-fixture-b' ? sessionB : sessionA;
        if (req.url.includes('/history')) {
          return {
            status: 200,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: sid,
              available: true,
              source: 'transcript',
              items: [],
              hasMore: false,
            }),
          };
        }
        if (req.url.includes('/output')) {
          return {
            status: 200,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: sid,
              available: true,
              status: 'live',
              output: '',
            }),
          };
        }
        return {
          status: 200,
          retryAfter: null,
          body: JSON.stringify({ apiVersion: 'v1', session: target }),
        };
      },
    );

    mockConfiguredKeystore();
    const apiClient = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: true,
    });
    const cache = new SessionCredentialCache();
    await cache.unlockAndGetCredentials({
      apiClient,
      allowDebugLoopback: true,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <SessionChatScreen
            route={{ params: { sessionId: 'sess-fixture-a' } }}
            credentialCache={cache}
            apiClient={apiClient}
            allowDebugLoopback={true}
            pollIntervalMs={60_000}
          />,
        );
        await flushAsync(10);
      });

      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('Prompt for A only');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(4);
      });
      expect(postCallCount).toBe(1);

      // Navigate/reuse component for session B while A's POST is still in flight.
      await ReactTestRenderer.act(async () => {
        renderer.update(
          <SessionChatScreen
            route={{ params: { sessionId: 'sess-fixture-b' } }}
            credentialCache={cache}
            apiClient={apiClient}
            allowDebugLoopback={true}
            pollIntervalMs={60_000}
          />,
        );
        await flushAsync(10);
      });
      expect(getAllText(renderer)).toContain('Session Beta');

      // Deferred failure from A settles after switching to B: B's composer must ignore it.
      await ReactTestRenderer.act(async () => {
        rejectPendingA(new Error('Network lost on A'));
        await flushAsync(8);
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'session-chat-submission-banner',
        }),
      ).toHaveLength(0);
      expect(
        renderer.root.findAllByProps({
          testID: 'session-chat-retry-send-button',
        }),
      ).toHaveLength(0);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) F2 recomputes send gate on HTTP 401 refresh and refuses dispatch when auth is paused', async () => {
    let return401 = false;
    let postAttempts = 0;
    const baseTransport = makeChatTransport({
      detailHandler: () =>
        return401
          ? {
              status: 401,
              retryAfter: null,
              body: JSON.stringify({
                error: { code: 'unauthorized', message: 'Invalid key' },
              }),
            }
          : {
              status: 200,
              retryAfter: null,
              body: JSON.stringify({
                apiVersion: 'v1',
                session: makeSessionFixture({
                  id: 'sess-fixture-codex-1',
                  name: 'Fixture Codex Chat',
                  status: 'idle',
                }),
              }),
            },
      messageHandler: async () => {
        postAttempts += 1;
        return {
          status: 202,
          retryAfter: null,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-fixture-codex-1',
            delivered: true,
            deliveryMethod: 'submit',
            status: 'delivered',
          }),
        };
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({
      request: baseTransport,
    });
    try {
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('Ready before 401');
      });
      expect(
        renderer.root.findByProps({ testID: 'session-chat-send-button' }).props
          .disabled,
      ).toBe(false);

      return401 = true;
      await ReactTestRenderer.act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
        await flushAsync(8);
      });

      const sendBtn = renderer.root.findByProps({
        testID: 'session-chat-send-button',
      });
      expect(sendBtn.props.disabled).toBe(true);
      expect(getAllText(renderer)).toContain('Authentication was rejected');

      // Calling onPress directly must also be refused before dispatch.
      await ReactTestRenderer.act(async () => {
        sendBtn.props.onPress();
        await flushAsync(4);
      });
      expect(postAttempts).toBe(0);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) F3 drains bounded continuation pages on initial and manual history fetches', async () => {
    const historyUrls: string[] = [];
    const request = makeChatTransport({
      historyHandler: url => {
        historyUrls.push(url);
        if (!url.includes('cursor=')) {
          return {
            status: 200,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-fixture-codex-1',
              available: true,
              source: 'transcript',
              items: [
                {
                  id: 'u-page1',
                  role: 'user',
                  source: 'transcript',
                  text: 'Tool-heavy request',
                  turnId: 'turn-big',
                  turnBoundary: 'start',
                },
                {
                  id: 't-page1',
                  role: 'tool',
                  source: 'transcript',
                  text: 'step 1',
                  turnId: 'turn-big',
                },
              ],
              hasMore: true,
              cursor: 'cursor-page-2',
            }),
          };
        }
        return {
          status: 200,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-fixture-codex-1',
            available: true,
            source: 'transcript',
            items: [
              {
                id: 'a-page2',
                role: 'agent',
                source: 'transcript',
                text: 'Final page 2 reply',
                turnId: 'turn-big',
                turnBoundary: 'end',
              },
            ],
            hasMore: false,
            cursor: 'cursor-end',
          }),
        };
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      expect(historyUrls).toEqual([
        `${TEST_URL}/api/v1/sessions/sess-fixture-codex-1/history?limit=20`,
        `${TEST_URL}/api/v1/sessions/sess-fixture-codex-1/history?limit=50&cursor=cursor-page-2`,
      ]);
      expect(getAllText(renderer)).toContain('Final page 2 reply');

      await ReactTestRenderer.act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
        await flushAsync(8);
      });
      expect(historyUrls).toHaveLength(4);
      expect(historyUrls[3]).toContain('cursor=cursor-page-2');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) F4 treats malformed 2xx POST receipts as unknown delivery preserving same-ID retry', async () => {
    const mapped = mapSendFailureToSubmission(
      {
        ok: false,
        category: 'malformed_response',
        status: 202,
        retryAfterSeconds: null,
      },
      'mob-malformed-1',
      'Prompt with unreadable receipt',
    );
    expect(mapped.status).toBe('unknown');
    expect(mapped.clientRequestId).toBe('mob-malformed-1');
    expect(mapped.message.toLowerCase()).toContain('no automatic resend');

    const sentIds: string[] = [];
    let attempt = 0;
    const request = makeChatTransport({
      messageHandler: async req => {
        const parsed = JSON.parse(req.body ?? '{}') as {
          clientRequestId: string;
        };
        sentIds.push(parsed.clientRequestId);
        attempt += 1;
        if (attempt === 1) {
          return { status: 202, retryAfter: null, body: '{broken json' };
        }
        return {
          status: 202,
          retryAfter: null,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-fixture-codex-1',
            delivered: true,
            deliveryMethod: 'submit',
            replayed: true,
            status: 'delivered',
          }),
        };
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('Trigger 2xx malformed');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(8);
      });
      expect(getAllText(renderer)).toContain('Delivery unknown');
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props
          .editable,
      ).toBe(false);

      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-retry-send-button' })
          .props.onPress();
        await flushAsync(8);
      });
      expect(sentIds).toHaveLength(2);
      expect(sentIds[1]).toBe(sentIds[0]);
      expect(getAllText(renderer)).toContain('Delivered (replayed)');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) F5 clears previous screen items when cleared terminal returns cursor line:0 while retaining identical fingerprint cursor', () => {
    const populatedScreen: SessionChatSnapshot = {
      session: makeSessionFixture({ id: 'sess-screen-1' }),
      historyAvailable: true,
      historySource: 'screen',
      historyItems: [
        {
          id: 'screen-l1',
          role: 'agent',
          source: 'screen',
          text: '$ ls\nREADME.md',
        },
      ],
      historyHasMore: false,
      historyCursor: 'line:2:fp:abcd1234',
      outputAvailable: true,
      outputStatus: 'live',
      outputText: '$ ls\nREADME.md',
      lastFetchedAtMs: 1000,
      serverUrl: TEST_URL,
      credentialGeneration: 0,
    };

    const retained = applyHistoryFetchResult(
      populatedScreen,
      {
        apiVersion: 'v1',
        sessionId: 'sess-screen-1',
        available: true,
        source: 'screen',
        items: [],
        hasMore: false,
        cursor: 'line:2:fp:abcd1234',
      },
      true,
    );
    expect(retained.historyItems).toHaveLength(1);

    const cleared = applyHistoryFetchResult(
      populatedScreen,
      {
        apiVersion: 'v1',
        sessionId: 'sess-screen-1',
        available: true,
        source: 'screen',
        items: [],
        hasMore: false,
        cursor: 'line:0',
      },
      true,
    );
    expect(cleared.historyItems).toEqual([]);
    expect(cleared.historyCursor).toBe('line:0');
  });

  test('(FIXTURE) F6 lifts composer padding when soft keyboard opens, clears on hide, and uses handled ScrollView taps', async () => {
    const keyboardListeners: Record<string, ((e?: { endCoordinates?: { height: number; screenY: number } }) => void)[]> = {};
    const kbSpy = jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((eventName, cb) => {
        keyboardListeners[eventName] = keyboardListeners[eventName] ?? [];
        keyboardListeners[eventName].push(cb as never);
        return {
          remove: jest.fn(),
        } as never;
      });

    const request = makeChatTransport({});
    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      const scroll = renderer.root.findByType(ScrollView);
      expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');

      const showEventName =
        keyboardListeners.keyboardDidShow ? 'keyboardDidShow' : 'keyboardWillShow';
      const hideEventName =
        keyboardListeners.keyboardDidHide ? 'keyboardDidHide' : 'keyboardWillHide';

      await ReactTestRenderer.act(async () => {
        keyboardListeners[showEventName]?.forEach(cb =>
          cb({ endCoordinates: { height: 320, screenY: 540 } }),
        );
      });
      const shownStyle = StyleSheet.flatten(
        renderer.root.findByProps({ testID: 'session-chat-screen' }).props.style,
      );
      expect(shownStyle.paddingBottom).toBeGreaterThan(300);

      await ReactTestRenderer.act(async () => {
        keyboardListeners[hideEventName]?.forEach(cb => cb());
      });
      const hiddenStyle = StyleSheet.flatten(
        renderer.root.findByProps({ testID: 'session-chat-screen' }).props.style,
      );
      expect(hiddenStyle.paddingBottom).toBe(0);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      kbSpy.mockRestore();
      cache.dispose();
    }
  });

  test('(FIXTURE) F7 and F8 render screen snapshots monospace without Agent label and clamp header task to one line', async () => {
    const request = makeChatTransport({
      session: makeSessionFixture({
        id: 'sess-screen-shell',
        name: 'Shell Fixture',
        status: 'idle',
        task: 'Very long task description that must be clamped to a single line in the compact header',
        worktree: { branch: 'feat/chat' },
      }),
      historyHandler: () => ({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-screen-shell',
          available: true,
          source: 'screen',
          items: [
            {
              id: 'sess-screen-shell-screen-l1',
              role: 'agent',
              source: 'screen',
              text: '$ echo hello\nhello',
            },
          ],
          hasMore: false,
          cursor: 'line:2:fp:abcd',
        }),
      }),
    });

    const { renderer, cache } = await renderUnlockedChatScreen({
      sessionId: 'sess-screen-shell',
      request,
    });
    try {
      const renderedText = getAllText(renderer);
      expect(renderedText).toContain('Terminal screen snapshot');
      expect(renderedText).not.toContain('\nAgent\n');
      expect(renderedText).toContain('$ echo hello');
      expect(renderedText).toContain('feat/chat');

      const snapshotNode = renderer.root.findByProps({
        testID: 'session-chat-item-sess-screen-shell-screen-l1',
      });
      const monoTextNode = snapshotNode
        .findAllByType(Text)
        .find(node =>
          String(
            Array.isArray(node.props.children)
              ? node.props.children.join('')
              : node.props.children ?? '',
          ).includes('$ echo hello'),
        );
      expect(monoTextNode).toBeDefined();
      const monoStyle = StyleSheet.flatten(monoTextNode?.props.style);
      expect(monoStyle.fontFamily).toBeTruthy();

      expect(
        renderer.root.findByProps({ testID: 'session-chat-task' }).props
          .numberOfLines,
      ).toBe(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });
});

describe('Round 2 review & UX regression fixes (F9-F11)', () => {
  test('(FIXTURE) F9 propagates native non-2xx JSON error codes without rendering raw server messages and hides retry on request-ID conflict', async () => {
    const nativeModulesRecord = NativeModules as Record<string, unknown>;
    const hadOwnNativeModule = Object.prototype.hasOwnProperty.call(
      nativeModulesRecord,
      'SpawneaHttp',
    );
    const originalNativeModule = nativeModulesRecord.SpawneaHttp;
    const nativeRequestMock = jest.fn();
    nativeModulesRecord.SpawneaHttp = { request: nativeRequestMock };

    const session = makeSessionFixture({
      id: 'sess-native-f9',
      name: 'Native F9 Target',
      status: 'idle',
    });

    const sendResponses = [
      {
        status: 409,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          error: {
            code: 'conflict',
            message:
              "Client request ID 'secret-req-99' was already used with a different prompt for internal-id-leak",
          },
        }),
      },
      {
        status: 409,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          error: {
            code: 'conflict',
            message: "Session 'internal-id-leak' already has an open turn",
          },
        }),
      },
      {
        status: 422,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          error: {
            code: 'needs_human',
            message: 'Session internal-id-leak is waiting on human approval',
          },
        }),
      },
      {
        status: 401,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          error: { code: 'unauthorized', message: 'bad token internal-id-leak' },
        }),
      },
      {
        status: 429,
        retryAfter: '14',
        body: JSON.stringify({
          apiVersion: 'v1',
          error: { code: 'rate_limited', message: 'slow down internal-id-leak' },
        }),
      },
    ];
    let sendIdx = 0;

    nativeRequestMock.mockImplementation(
      async (req: { url: string; method: string }) => {
        if (req.method === 'POST' && req.url.includes('/message')) {
          return sendResponses[Math.min(sendIdx++, sendResponses.length - 1)];
        }
        if (req.url.includes('/history')) {
          return {
            status: 200,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: session.id,
              available: true,
              source: 'transcript',
              items: [],
              hasMore: false,
            }),
          };
        }
        if (req.url.includes('/output')) {
          return {
            status: 200,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: session.id,
              available: true,
              status: 'live',
              output: '',
            }),
          };
        }
        return {
          status: 200,
          retryAfter: null,
          body: JSON.stringify({ apiVersion: 'v1', session }),
        };
      },
    );

    try {
      const apiClient = new SpawneaApiClient({
        transport: createNativeHttpTransport(),
        allowDebugLoopback: true,
      });

      mockConfiguredKeystore();
      const cache = new SessionCredentialCache();
      await cache.unlockAndGetCredentials({
        apiClient,
        allowDebugLoopback: true,
      });

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      try {
        await ReactTestRenderer.act(async () => {
          renderer = ReactTestRenderer.create(
            <SessionChatScreen
              sessionId={session.id}
              apiClient={apiClient}
              credentialCache={cache}
              allowDebugLoopback
            />,
          );
          await flushAsync(14);
        });

        // 1) Request-ID/different-prompt conflict through real native transport:
        await ReactTestRenderer.act(async () => {
          renderer.root
            .findByProps({ testID: 'session-chat-input' })
            .props.onChangeText('conflicting prompt');
        });
        await ReactTestRenderer.act(async () => {
          renderer.root
            .findByProps({ testID: 'session-chat-send-button' })
            .props.onPress();
          await flushAsync(12);
        });

        const conflictText = getAllText(renderer);
        expect(conflictText).toContain('Delivery failed');
        expect(conflictText).toContain(
          'Edit the message or tap Discard to start with a new request ID.',
        );
        expect(conflictText).not.toContain('secret-req-99');
        expect(conflictText).not.toContain('internal-id-leak');
        expect(
          renderer.root.findAllByProps({
            testID: 'session-chat-retry-send-button',
          }),
        ).toHaveLength(0);
        expect(
          renderer.root.findByProps({
            testID: 'session-chat-discard-send-button',
          }),
        ).toBeDefined();
      } finally {
        await ReactTestRenderer.act(async () => {
          renderer.unmount();
        });
        cache.dispose();
      }

      // 2) Verify open-turn 409, 422, 429, and 401 non-2xx JSON code extraction via real native transport without serverMessage exposure
      const resOpenTurn = await apiClient.sendMessage(
        { serverUrl: TEST_URL, apiKey: TEST_KEY },
        session.id,
        { message: 'm1', clientRequestId: 'mob-1' },
      );
      expect(resOpenTurn).toEqual({
        ok: false,
        category: 'server_error',
        status: 409,
        retryAfterSeconds: null,
        errorCode: 'open_turn_conflict',
      });

      const res422 = await apiClient.sendMessage(
        { serverUrl: TEST_URL, apiKey: TEST_KEY },
        session.id,
        { message: 'm2', clientRequestId: 'mob-2' },
      );
      expect(res422).toEqual({
        ok: false,
        category: 'server_error',
        status: 422,
        retryAfterSeconds: null,
        errorCode: 'needs_human',
      });

      const res401 = await apiClient.sendMessage(
        { serverUrl: TEST_URL, apiKey: TEST_KEY },
        session.id,
        { message: 'm3', clientRequestId: 'mob-3' },
      );
      expect(res401).toEqual({
        ok: false,
        category: 'unauthorized',
        status: 401,
        retryAfterSeconds: null,
        errorCode: 'unauthorized',
      });

      const res429 = await apiClient.sendMessage(
        { serverUrl: TEST_URL, apiKey: TEST_KEY },
        session.id,
        { message: 'm4', clientRequestId: 'mob-4' },
      );
      expect(res429).toEqual({
        ok: false,
        category: 'rate_limited',
        status: 429,
        retryAfterSeconds: 14,
        errorCode: 'rate_limited',
      });
    } finally {
      if (hadOwnNativeModule) {
        nativeModulesRecord.SpawneaHttp = originalNativeModule;
      } else {
        delete nativeModulesRecord.SpawneaHttp;
      }
    }
  });

  test('(FIXTURE) F10 keeps Retry (same ID) enabled for unknown submission while session is working, while blocking new sends and respecting auth/foreground', async () => {
    const workingSession = makeSessionFixture({
      id: 'sess-f10',
      name: 'F10 Target',
      status: 'working',
    });

    // Unit gate invariants
    const unknownSub = {
      status: 'unknown' as const,
      clientRequestId: 'mob-f10',
      submittedText: 'check replay',
      message: 'Delivery unknown',
    };
    expect(
      evaluateRetryGate({
        submission: unknownSub,
        isForeground: true,
        hasUnlockedCredential: true,
        isAuthPaused: false,
        session: workingSession,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateRetryGate({
        submission: unknownSub,
        isForeground: false,
        hasUnlockedCredential: true,
        isAuthPaused: false,
        session: workingSession,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateRetryGate({
        submission: unknownSub,
        isForeground: true,
        hasUnlockedCredential: false,
        isAuthPaused: false,
        session: workingSession,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateRetryGate({
        submission: unknownSub,
        isForeground: true,
        hasUnlockedCredential: true,
        isAuthPaused: true,
        session: workingSession,
      }).allowed,
    ).toBe(false);
    // Failed submissions remain gated on idle/needs_input readiness
    expect(
      evaluateRetryGate({
        submission: {
          status: 'failed',
          clientRequestId: 'mob-f10-fail',
          submittedText: 'open turn failed',
          message: 'Conflict',
        },
        isForeground: true,
        hasUnlockedCredential: true,
        isAuthPaused: false,
        session: workingSession,
      }).allowed,
    ).toBe(false);

    // End-to-end screen regression: timeout -> unknown, refresh -> working, Retry (same ID) stays enabled & replays same ID
    let sessionStatus: 'idle' | 'working' = 'idle';
    let postAttempt = 0;
    const postedIds: string[] = [];

    const request = makeChatTransport({
      session: { ...workingSession, status: 'idle' },
      detailHandler: () => ({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          session: { ...workingSession, status: sessionStatus },
        }),
      }),
      messageHandler: async ({ body }) => {
        postAttempt += 1;
        const parsed = body ? JSON.parse(body) : {};
        postedIds.push(parsed.clientRequestId);
        if (postAttempt === 1) {
          sessionStatus = 'working';
          const err = new Error('timeout');
          (err as { code?: string }).code = 'E_TIMEOUT';
          throw err;
        }
        return {
          status: 200,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: workingSession.id,
            delivered: true,
            deliveryMethod: 'submit',
            status: 'working',
            replayed: true,
          }),
        };
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({
      sessionId: workingSession.id,
      request,
    });
    try {
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('recover my receipt');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(getAllText(renderer)).toContain('Delivery unknown');

      // Manual refresh now sees session status = working
      await ReactTestRenderer.act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
        await flushAsync(14);
      });

      expect(
        renderer.root.findByProps({ testID: 'session-chat-send-button' }).props
          .disabled,
      ).toBe(true);
      const retryBtn = renderer.root.findByProps({
        testID: 'session-chat-retry-send-button',
      });
      expect(retryBtn.props.disabled).toBe(false);

      await ReactTestRenderer.act(async () => {
        retryBtn.props.onPress();
        await flushAsync(12);
      });
      expect(postedIds).toHaveLength(2);
      expect(postedIds[0]).toBe(postedIds[1]);
      expect(getAllText(renderer)).toContain('Delivered (replayed)');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) F11 opens at bottom, follows new items while at bottom, and stays put when user has scrolled up during polling', async () => {
    expect(
      isScrollNearBottom({
        offsetY: 1360,
        viewportHeight: 600,
        contentHeight: 2000,
      }),
    ).toBe(true);
    expect(
      isScrollNearBottom({
        offsetY: 400,
        viewportHeight: 600,
        contentHeight: 2000,
      }),
    ).toBe(false);

    const scrollToEndSpy = jest
      .spyOn(ScrollView.prototype, 'scrollToEnd')
      .mockImplementation(() => undefined);

    const items: SessionHistoryItem[] = [
      {
        id: 'm1',
        role: 'user',
        source: 'transcript',
        text: 'Old prompt',
        turnId: 't1',
      },
      {
        id: 'm2',
        role: 'agent',
        source: 'transcript',
        text: 'Latest reply',
        turnId: 't1',
      },
    ];
    let nowMs = 1_760_000_000_000;
    const request = makeChatTransport({
      session: makeSessionFixture({
        id: 'sess-f11',
        name: 'F11 Scroll Target',
        status: 'idle',
      }),
      historyHandler: () => ({
        status: 200,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-f11',
          available: true,
          source: 'transcript',
          items,
          hasMore: false,
        }),
      }),
    });

    const { renderer, cache } = await renderUnlockedChatScreen({
      sessionId: 'sess-f11',
      request,
      now: () => nowMs,
    });
    try {
      const scrollView = renderer.root.findByProps({
        testID: 'session-chat-scroll',
      });

      // 1) Initial layout & content size -> lands on latest (scrollToEnd)
      await ReactTestRenderer.act(async () => {
        scrollView.props.onLayout({
          nativeEvent: { layout: { height: 600, width: 360 } },
        });
        scrollView.props.onContentSizeChange(360, 1800);
      });
      expect(scrollToEndSpy).toHaveBeenCalled();

      // Let initial transition settle timers complete, then verify unchanged polls stay quiet.
      await ReactTestRenderer.act(async () => {
        await new Promise<void>(resolve => setTimeout(() => resolve(), 320));
      });
      scrollToEndSpy.mockClear();

      // 2) Polling refresh with unchanged content -> no spurious scroll
      nowMs += 5_000;
      await ReactTestRenderer.act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
        await flushAsync(14);
      });
      await ReactTestRenderer.act(async () => {
        scrollView.props.onContentSizeChange(360, 1800);
      });
      expect(scrollToEndSpy).not.toHaveBeenCalled();

      // 3) New message arrives while pinned at bottom -> follows to bottom
      items.push({
        id: 'm3',
        role: 'agent',
        source: 'transcript',
        text: 'Brand new follow-up',
        turnId: 't2',
      });
      nowMs += 5_000;
      await ReactTestRenderer.act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
        await flushAsync(14);
      });
      await ReactTestRenderer.act(async () => {
        scrollView.props.onContentSizeChange(360, 2000);
      });
      expect(scrollToEndSpy).toHaveBeenCalled();

      // 4) User starts dragging up -> cancels pending follow and stays put across polls + new items
      scrollToEndSpy.mockClear();
      await ReactTestRenderer.act(async () => {
        scrollView.props.onScrollBeginDrag();
        scrollView.props.onScroll({
          nativeEvent: {
            contentOffset: { x: 0, y: 200 },
            layoutMeasurement: { height: 600, width: 360 },
            contentSize: { height: 2000, width: 360 },
          },
        });
        scrollView.props.onScrollEndDrag({
          nativeEvent: {
            contentOffset: { x: 0, y: 200 },
            layoutMeasurement: { height: 600, width: 360 },
            contentSize: { height: 2000, width: 360 },
          },
        });
      });

      items.push({
        id: 'm4',
        role: 'agent',
        source: 'transcript',
        text: 'Message arriving while reading above',
        turnId: 't3',
      });
      nowMs += 5_000;
      await ReactTestRenderer.act(async () => {
        renderer.root.findByType(RefreshControl).props.onRefresh();
        await flushAsync(14);
      });
      await ReactTestRenderer.act(async () => {
        scrollView.props.onContentSizeChange(360, 2200);
        await new Promise<void>(resolve => setTimeout(() => resolve(), 320));
      });
      expect(scrollToEndSpy).not.toHaveBeenCalled();
    } finally {
      scrollToEndSpy.mockRestore();
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });
});

describe('Round 3 review regression fixes (F12-F13 & submission state machine)', () => {
  test('(FIXTURE) F12 keeps unknown submission in unknown across 429, network, timeout, 5xx, and 401 retries without unlocking editing or rotating clientRequestId', async () => {
    const session = makeSessionFixture({
      id: 'sess-f12-retry',
      name: 'F12 Unknown Retry',
      status: 'idle',
    });

    type PostStep =
      | { kind: 'throw'; code: string; message: string }
      | {
          kind: 'response';
          status: number;
          retryAfter?: string | null;
          body: string;
        };

    const steps: PostStep[] = [
      // 0) Initial POST times out -> unknown
      { kind: 'throw', code: 'E_TIMEOUT', message: 'timeout' },
      // 1) Retry fails with 429 -> must stay unknown
      {
        kind: 'response',
        status: 429,
        retryAfter: '1',
        body: JSON.stringify({
          apiVersion: 'v1',
          error: { code: 'rate_limited', message: 'slow down' },
        }),
      },
      // 2) Retry fails with network error -> must stay unknown
      { kind: 'throw', code: 'E_NETWORK', message: 'network drop' },
      // 3) Retry fails with timeout -> must stay unknown
      { kind: 'throw', code: 'E_TIMEOUT', message: 'retry timeout' },
      // 4) Retry fails with 5xx -> must stay unknown
      {
        kind: 'response',
        status: 503,
        body: JSON.stringify({
          apiVersion: 'v1',
          error: { code: 'operation_failed', message: 'upstream restarting' },
        }),
      },
      // 5) Retry fails with 401 -> must stay unknown (with Open Settings + Discard, Retry paused)
      {
        kind: 'response',
        status: 401,
        body: JSON.stringify({
          apiVersion: 'v1',
          error: { code: 'unauthorized', message: 'expired key' },
        }),
      },
    ];

    let nowMs = 1_760_000_000_000;
    let stepIndex = 0;
    const postedIds: string[] = [];

    const request = makeChatTransport({
      session,
      messageHandler: async ({ body }) => {
        const parsed = body ? JSON.parse(body) : {};
        postedIds.push(parsed.clientRequestId);
        const step = steps[Math.min(stepIndex++, steps.length - 1)];
        if (step.kind === 'throw') {
          const err = new Error(step.message);
          (err as { code?: string }).code = step.code;
          throw err;
        }
        return {
          status: step.status,
          retryAfter: step.retryAfter ?? null,
          body: step.body,
        };
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({
      sessionId: session.id,
      request,
      now: () => nowMs,
    });

    try {
      const input = renderer.root.findByProps({
        testID: 'session-chat-input',
      });
      await ReactTestRenderer.act(async () => {
        input.props.onChangeText('unresolved prompt');
      });

      // Step 0: initial timeout -> unknown
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(postedIds).toHaveLength(1);
      const originalRequestId = postedIds[0];

      const assertLockedUnknown = () => {
        const statusText = renderer.root.findByProps({
          testID: 'session-chat-submission-status',
        });
        expect(statusText.props.children).toBe('Delivery unknown');
        const currentInput = renderer.root.findByProps({
          testID: 'session-chat-input',
        });
        expect(currentInput.props.editable).toBe(false);
        expect(currentInput.props.value).toBe('unresolved prompt');
        expect(
          renderer.root.findByProps({
            testID: 'session-chat-send-button',
          }).props.disabled,
        ).toBe(true);
        // Attempting to type must be ignored while unknown
        currentInput.props.onChangeText('edited duplicate');
        expect(
          renderer.root.findByProps({ testID: 'session-chat-input' }).props
            .value,
        ).toBe('unresolved prompt');
      };

      assertLockedUnknown();

      // Steps 1-4: 429, network, timeout, 503 all keep unknown and reuse originalRequestId
      for (let i = 1; i <= 4; i += 1) {
        nowMs += 15_000;
        await ReactTestRenderer.act(async () => {
          renderer.root
            .findByProps({ testID: 'session-chat-retry-send-button' })
            .props.onPress();
          await flushAsync(12);
        });
        expect(postedIds).toHaveLength(i + 1);
        expect(postedIds[i]).toBe(originalRequestId);
        assertLockedUnknown();
      }

      // Step 5: 401 preserves unknown, exposes Open Settings, pauses Retry, allows Discard
      nowMs += 5_000;
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-retry-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(postedIds).toHaveLength(6);
      expect(postedIds[5]).toBe(originalRequestId);
      assertLockedUnknown();
      expect(
        renderer.root.findByProps({
          testID: 'session-chat-retry-send-button',
        }).props.disabled,
      ).toBe(true);
      expect(getAllText(renderer)).toContain('HTTP 401');

      // Explicit Discard unlocks editing and wipes unresolved draft
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-discard-send-button' })
          .props.onPress();
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'session-chat-submission-banner',
        }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props
          .editable,
      ).toBe(true);
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props.value,
      ).toBe('');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) F12 state machine covers definitive resolution from unknown, 409 conflict send lock, and lock clearing', () => {
    const baseSub = {
      status: 'unknown' as const,
      clientRequestId: 'mob-req-1',
      submittedText: 'check me',
      message: 'unknown',
    };

    // Unit mapper verifies non-definitive retries stay unknown while definitive answers transition
    for (const nonDefinitive of [
      {
        ok: false as const,
        category: 'rate_limited' as const,
        status: 429,
        retryAfterSeconds: 8,
        errorCode: 'rate_limited',
      },
      {
        ok: false as const,
        category: 'network_error' as const,
        status: null,
        retryAfterSeconds: null,
      },
      {
        ok: false as const,
        category: 'timeout' as const,
        status: null,
        retryAfterSeconds: null,
      },
      {
        ok: false as const,
        category: 'unauthorized' as const,
        status: 401,
        retryAfterSeconds: null,
        errorCode: 'unauthorized',
      },
      {
        ok: false as const,
        category: 'server_error' as const,
        status: 502,
        retryAfterSeconds: null,
      },
      {
        ok: false as const,
        category: 'malformed_response' as const,
        status: 200,
        retryAfterSeconds: null,
      },
    ]) {
      const mapped = mapSendFailureToSubmission(
        nonDefinitive,
        baseSub.clientRequestId,
        baseSub.submittedText,
        { preserveUnknown: true },
      );
      expect(mapped.status).toBe('unknown');
      expect(mapped.clientRequestId).toBe(baseSub.clientRequestId);
      expect(mapped.submittedText).toBe(baseSub.submittedText);
    }

    // Definitive 409 request_id_conflict resolves unknown -> failed with conflictDifferentPrompt
    const conflictDiff = mapSendFailureToSubmission(
      {
        ok: false,
        category: 'server_error',
        status: 409,
        retryAfterSeconds: null,
        errorCode: 'request_id_conflict',
      },
      baseSub.clientRequestId,
      baseSub.submittedText,
      { preserveUnknown: true },
    );
    expect(conflictDiff.status).toBe('failed');
    expect(conflictDiff.conflictDifferentPrompt).toBe(true);

    // 409 request_id_conflict also blocks normal Send until user edits or discards
    const idleSession = makeSessionFixture({
      id: 'sess-f12-gate',
      name: 'Gate Target',
      status: 'idle',
    });
    expect(
      evaluateSendGate({
        isForeground: true,
        hasUnlockedCredential: true,
        isAuthPaused: false,
        session: idleSession,
        submissionStatus: 'failed',
        conflictDifferentPrompt: true,
        draftText: 'same draft',
      }).allowed,
    ).toBe(false);

    // Delivered replay resolves unknown -> delivered
    const replayed = mapSendResponseToSubmission(
      {
        apiVersion: 'v1',
        sessionId: 'sess-f12-gate',
        delivered: true,
        deliveryMethod: 'submit',
        status: 'delivered',
        replayed: true,
      },
      baseSub.clientRequestId,
      baseSub.submittedText,
    );
    expect(replayed.status).toBe('delivered');
    expect(replayed.replayed).toBe(true);
  });

  test('(FIXTURE) F12 hides unresolved unknown submission while backgrounded/locked and restores it for the same session on unlock', async () => {
    const appStateSpy = setupAppStateSpy();
    const request = makeChatTransport({
      session: makeSessionFixture({
        id: 'sess-f12-lock',
        name: 'Lock Restore',
        status: 'idle',
      }),
      messageHandler: async () => {
        const err = new Error('timeout');
        (err as { code?: string }).code = 'E_TIMEOUT';
        throw err;
      },
    });

    const { renderer, cache, apiClient } = await renderUnlockedChatScreen({
      sessionId: 'sess-f12-lock',
      request,
    });

    try {
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('sensitive pending');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivery unknown');

      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(8);
      });
      expect(
        renderer.root.findAllByProps({ testID: 'session-chat-composer' }),
      ).toHaveLength(0);
      expect(getAllText(renderer)).not.toContain('sensitive pending');

      // Re-unlock on return to foreground: same session restores the unknown guard so user resolves via Retry/Discard
      await cache.unlockAndGetCredentials({
        apiClient,
        allowDebugLoopback: true,
      });
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('active');
        await flushAsync(14);
      });
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivery unknown');
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props.value,
      ).toBe('sensitive pending');
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props
          .editable,
      ).toBe(false);
    } finally {
      appStateSpy.restore();
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) F13 discards accumulated screen pages when continuation restarts with a new fingerprint or line 0 cursor', async () => {
    const historyUrls: string[] = [];
    const request = makeChatTransport({
      session: makeSessionFixture({
        id: 'sess-f13-screen',
        name: 'Shell Screen Paging',
        harness: { id: 'shell', name: 'Shell', command: 'zsh' },
        status: 'idle',
      }),
      historyHandler: url => {
        historyUrls.push(url);
        if (!url.includes('cursor=')) {
          // Page 1 from old terminal snapshot
          return {
            status: 200,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-f13-screen',
              available: true,
              source: 'screen',
              cursor: 'line:5:fp:old-fp-1',
              hasMore: true,
              items: [
                {
                  id: 'sess-f13-screen-screen-l1',
                  role: 'agent',
                  source: 'screen',
                  text: 'STALE SCREEN PAGE 1',
                },
              ],
            }),
          };
        }
        if (url.includes('fp%3Aold-fp-1') || url.includes('fp:old-fp-1')) {
          // Terminal changed mid-drain -> server restarts pagination with fp-new-2
          return {
            status: 200,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-f13-screen',
              available: true,
              source: 'screen',
              cursor: 'line:5:fp:new-fp-2',
              hasMore: true,
              items: [
                {
                  id: 'sess-f13-screen-screen-l1',
                  role: 'agent',
                  source: 'screen',
                  text: 'FRESH SNAPSHOT PART 1',
                },
              ],
            }),
          };
        }
        // Page 2 of the replacement snapshot
        return {
          status: 200,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-f13-screen',
            available: true,
            source: 'screen',
            cursor: 'line:9:fp:new-fp-2',
            hasMore: false,
            items: [
              {
                id: 'sess-f13-screen-screen-l6',
                role: 'agent',
                source: 'screen',
                text: 'FRESH SNAPSHOT PART 2',
              },
            ],
          }),
        };
      },
    });

    const { renderer, cache } = await renderUnlockedChatScreen({
      sessionId: 'sess-f13-screen',
      request,
    });

    try {
      const text = getAllText(renderer);
      expect(historyUrls.length).toBeGreaterThanOrEqual(3);
      expect(text).not.toContain('STALE SCREEN PAGE 1');
      expect(text).toContain('FRESH SNAPSHOT PART 1');
      expect(text).toContain('FRESH SNAPSHOT PART 2');
      // Only one host element should hold the restarted l1 testID (no duplicate IDs)
      expect(
        renderer.root.findAll(
          node =>
            node.props?.testID === 'session-chat-item-sess-f13-screen-screen-l1' &&
            typeof node.type === 'string',
        ),
      ).toHaveLength(1);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });
});

describe('Final round fixes (K1, K2, J72-1, J72-2)', () => {
  test('(FIXTURE) K1 classifies initial HTTP 5xx and post-dispatch failures as unknown, and only definitive pre-delivery rejections as failed', async () => {
    for (const status5xx of [500, 502, 503, 504] as const) {
      const sub = mapSendFailureToSubmission(
        {
          ok: false,
          category: 'server_error',
          status: status5xx,
          retryAfterSeconds: null,
        },
        'mob-k1-5xx',
        'initial prompt',
      );
      expect(sub.status).toBe('unknown');
      expect(sub.clientRequestId).toBe('mob-k1-5xx');
      expect(sub.submittedText).toBe('initial prompt');
    }

    const timeout408 = mapSendFailureToSubmission(
      {
        ok: false,
        category: 'server_error',
        status: 408,
        retryAfterSeconds: null,
      },
      'mob-k1-408',
      'initial prompt',
    );
    expect(timeout408.status).toBe('unknown');

    const preDeliveryCases: Array<{
      category:
        | 'invalid_request'
        | 'unauthorized'
        | 'rate_limited'
        | 'server_error';
      status: number;
      errorCode?: string;
    }> = [
      { category: 'invalid_request', status: 400 },
      { category: 'unauthorized', status: 401 },
      { category: 'server_error', status: 404 },
      { category: 'server_error', status: 409, errorCode: 'open_turn_conflict' },
      { category: 'server_error', status: 422, errorCode: 'needs_human' },
      { category: 'rate_limited', status: 429 },
    ];
    for (const c of preDeliveryCases) {
      const sub = mapSendFailureToSubmission(
        {
          ok: false,
          category: c.category,
          status: c.status,
          retryAfterSeconds: null,
          errorCode: c.errorCode,
        },
        'mob-k1-pre',
        'initial prompt',
      );
      expect(sub.status).toBe('failed');
    }

    // Full UI proof: HTTP 503 on initial Send locks composer under unknown with Retry (same ID)
    const sentIds: string[] = [];
    const request = makeChatTransport({
      messageHandler: async req => {
        const parsed = req.body
          ? (JSON.parse(req.body) as { clientRequestId: string })
          : { clientRequestId: '' };
        sentIds.push(parsed.clientRequestId);
        if (sentIds.length === 1) {
          return {
            status: 503,
            retryAfter: null,
            body: JSON.stringify({ error: { code: 'upstream_unavailable' } }),
          };
        }
        return {
          status: 202,
          retryAfter: null,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-fixture-codex-1',
            delivered: true,
            replayed: true,
            deliveryMethod: 'submit',
            status: 'delivered',
          }),
        };
      },
    });
    const { renderer, cache } = await renderUnlockedChatScreen({ request });
    try {
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('k1 503 test');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivery unknown');

      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-retry-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(sentIds).toHaveLength(2);
      expect(sentIds[1]).toBe(sentIds[0]);
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivered (replayed)');
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) K2 detects transcript cursor reset and replaces cached history without stale or out-of-order items', async () => {
    expect(
      didTranscriptCursorReset({
        prevCursor: 'offset:420:file:rollout-1.jsonl:head:aaaa1111',
        nextCursor: 'offset:180:file:rollout-2.jsonl:head:bbbb2222',
      }),
    ).toBe(true);
    expect(
      didTranscriptCursorReset({
        prevCursor: 'offset:420:file:rollout-1.jsonl:head:aaaa1111',
        nextCursor: 'offset:420:file:rollout-1.jsonl:head:cccc3333',
      }),
    ).toBe(true);
    expect(
      didTranscriptCursorReset({
        prevCursor: 'offset:420:file:rollout-1.jsonl:head:aaaa1111',
        nextCursor: 'offset:100:file:rollout-1.jsonl:head:aaaa1111',
      }),
    ).toBe(true);
    expect(
      didTranscriptCursorReset({
        prevCursor: 'offset:420:file:rollout-1.jsonl:head:aaaa1111',
        nextCursor: 'offset:0:file:rollout-1.jsonl',
      }),
    ).toBe(true);
    expect(
      didTranscriptCursorReset({
        prevCursor: 'offset:420:file:rollout-1.jsonl:head:aaaa1111',
        nextCursor: 'offset:512:file:rollout-1.jsonl:head:aaaa1111',
      }),
    ).toBe(false);

    const prevSnapshot: SessionChatSnapshot = {
      session: makeSessionFixture(),
      historyAvailable: true,
      historySource: 'transcript',
      historyItems: [
        {
          id: 'old-1',
          role: 'user',
          source: 'transcript',
          text: 'stale first message',
        },
        {
          id: 'old-2',
          role: 'agent',
          source: 'transcript',
          text: 'stale second message',
        },
      ],
      historyHasMore: true,
      historyCursor: 'offset:500:file:rollout-1.jsonl:head:aaaa1111',
      outputAvailable: true,
      outputStatus: 'live',
      outputText: '',
      lastFetchedAtMs: 1000,
      serverUrl: TEST_URL,
      credentialGeneration: 1,
    };

    const emptyReplaced = applyHistoryFetchResult(
      prevSnapshot,
      {
        apiVersion: 'v1',
        sessionId: prevSnapshot.session.id,
        available: true,
        source: 'transcript',
        hasMore: false,
        cursor: 'offset:0:file:rollout-1.jsonl',
        items: [],
      },
      true,
    );
    expect(emptyReplaced.historyItems).toEqual([]);
    expect(emptyReplaced.historyHasMore).toBe(false);

    const fileReplaced = applyHistoryFetchResult(
      prevSnapshot,
      {
        apiVersion: 'v1',
        sessionId: prevSnapshot.session.id,
        available: true,
        source: 'transcript',
        hasMore: false,
        cursor: 'offset:120:file:rollout-2.jsonl:head:bbbb2222',
        items: [
          {
            id: 'new-1',
            role: 'user',
            source: 'transcript',
            text: 'fresh file start',
          },
        ],
      },
      true,
    );
    expect(fileReplaced.historyItems.map(i => i.id)).toEqual(['new-1']);

    // End-to-end Screen cursor poll + multi-page continuation reset proof
    jest.useFakeTimers();
    let phase: 'initial' | 'poll_reset' = 'initial';
    const request = makeChatTransport({
      historyHandler: url => {
        if (phase === 'initial') {
          return {
            status: 200,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-fixture-codex-1',
              available: true,
              source: 'transcript',
              hasMore: false,
              cursor: 'offset:400:file:rollout-a.jsonl:head:1111',
              items: [
                {
                  id: 't-stale-1',
                  role: 'agent',
                  source: 'transcript',
                  text: 'STALE LIVE TURN',
                },
              ],
            }),
          };
        }
        if (url.includes('rollout-a.jsonl')) {
          return {
            status: 200,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-fixture-codex-1',
              available: true,
              source: 'transcript',
              hasMore: true,
              cursor: 'offset:160:file:rollout-b.jsonl:head:2222',
              items: [
                {
                  id: 't-stale-page1',
                  role: 'agent',
                  source: 'transcript',
                  text: 'STALE MID-DRAIN PAGE 1',
                },
              ],
            }),
          };
        }
        if (url.includes('rollout-b.jsonl')) {
          return {
            status: 200,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: 'sess-fixture-codex-1',
              available: true,
              source: 'transcript',
              hasMore: true,
              cursor: 'offset:80:file:rollout-c.jsonl:head:3333',
              items: [
                {
                  id: 't-fresh-1',
                  role: 'user',
                  source: 'transcript',
                  text: 'FRESH ORDER 1',
                },
              ],
            }),
          };
        }
        return {
          status: 200,
          body: JSON.stringify({
            apiVersion: 'v1',
            sessionId: 'sess-fixture-codex-1',
            available: true,
            source: 'transcript',
            hasMore: false,
            cursor: 'offset:200:file:rollout-c.jsonl:head:3333',
            items: [
              {
                id: 't-fresh-2',
                role: 'agent',
                source: 'transcript',
                text: 'FRESH ORDER 2',
              },
            ],
          }),
        };
      },
    });
    const { renderer, cache } = await renderUnlockedChatScreen({
      request,
      pollIntervalMs: 5000,
    });
    try {
      expect(getAllText(renderer)).toContain('STALE LIVE TURN');
      phase = 'poll_reset';
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(5000);
        await flushAsync(18);
      });
      const updatedText = getAllText(renderer);
      expect(updatedText).not.toContain('STALE LIVE TURN');
      expect(updatedText).not.toContain('STALE MID-DRAIN PAGE 1');
      expect(updatedText.indexOf('FRESH ORDER 1')).toBeGreaterThan(-1);
      expect(updatedText.indexOf('FRESH ORDER 2')).toBeGreaterThan(
        updatedText.indexOf('FRESH ORDER 1'),
      );
    } finally {
      jest.useRealTimers();
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) J72-1 preserves unknown and in-flight pending submissions across background/lock for the same session only', async () => {
    const appStateSpy = setupAppStateSpy();
    const sentRequests: Array<{ sessionId: string; clientRequestId: string; message: string }> = [];
    let attempt = 0;

    const sessionA = makeSessionFixture({
      id: 'sess-j72-a',
      name: 'Session Alpha',
      status: 'idle',
    });
    const sessionB = makeSessionFixture({
      id: 'sess-j72-b',
      name: 'Session Beta',
      status: 'idle',
    });

    const request = jest.fn(
      async (req: { method: string; url: string; body?: string }) => {
        const sid = req.url.includes('sess-j72-b') ? 'sess-j72-b' : 'sess-j72-a';
        const target = sid === 'sess-j72-b' ? sessionB : sessionA;
        if (req.method === 'POST' && req.url.includes('/message')) {
          attempt += 1;
          const parsed = req.body
            ? (JSON.parse(req.body) as { clientRequestId: string; message: string })
            : { clientRequestId: '', message: '' };
          sentRequests.push({
            sessionId: sid,
            clientRequestId: parsed.clientRequestId,
            message: parsed.message,
          });
          if (attempt === 1) {
            const err = new Error('request timed out');
            (err as { code?: string }).code = 'E_TIMEOUT';
            throw err;
          }
          return {
            status: 202,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: sid,
              delivered: true,
              replayed: attempt === 2,
              deliveryMethod: 'submit',
              status: 'delivered',
            }),
          };
        }
        if (req.url.includes('/history')) {
          return {
            status: 200,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: sid,
              available: true,
              source: 'transcript',
              hasMore: false,
              items: [],
            }),
          };
        }
        if (req.url.includes('/output')) {
          return {
            status: 200,
            retryAfter: null,
            body: JSON.stringify({
              apiVersion: 'v1',
              sessionId: sid,
              available: true,
              status: 'live',
              output: '',
            }),
          };
        }
        return {
          status: 200,
          retryAfter: null,
          body: JSON.stringify({ apiVersion: 'v1', session: target }),
        };
      },
    );

    const { renderer, cache, apiClient } = await renderUnlockedChatScreen({
      sessionId: 'sess-j72-a',
      request: jest.fn(async req => {
        const res = await request(req);
        return { ...res, retryAfter: res.retryAfter ?? null };
      }),
    });

    try {
      // 1) Initial send times out -> unknown
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('critical prompt');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(sentRequests).toHaveLength(1);
      const originalRequestId = sentRequests[0].clientRequestId;
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivery unknown');

      // 2) Background/lock hides all sensitive UI & banner
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(8);
      });
      expect(
        renderer.root.findAllByProps({ testID: 'session-chat-composer' }),
      ).toHaveLength(0);
      expect(getAllText(renderer)).not.toContain('critical prompt');

      // 3) Unlock into a DIFFERENT session B -> must never restore A's draft/requestId
      await cache.unlockAndGetCredentials({
        apiClient,
        allowDebugLoopback: true,
      });
      await ReactTestRenderer.act(async () => {
        renderer.update(
          <SessionChatScreen
            route={{ params: { sessionId: 'sess-j72-b' } }}
            credentialCache={cache}
            apiClient={apiClient}
            allowDebugLoopback={true}
            pollIntervalMs={60_000}
          />,
        );
        appStateSpy.emit('active');
        await flushAsync(14);
      });
      expect(getAllText(renderer)).toContain('Session Beta');
      expect(
        renderer.root.findAllByProps({
          testID: 'session-chat-submission-banner',
        }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props.value,
      ).toBe('');

      // 4) Switch back to Session A -> restores A's unresolved unknown submission with original ID
      await ReactTestRenderer.act(async () => {
        renderer.update(
          <SessionChatScreen
            route={{ params: { sessionId: 'sess-j72-a' } }}
            credentialCache={cache}
            apiClient={apiClient}
            allowDebugLoopback={true}
            pollIntervalMs={60_000}
          />,
        );
        await flushAsync(14);
      });
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivery unknown');
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props.value,
      ).toBe('critical prompt');
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props
          .editable,
      ).toBe(false);
      // Pressing send button while unknown must NOT dispatch a second POST with a new ID
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(6);
      });
      expect(sentRequests).toHaveLength(1);

      // 5) Retry (same ID) resolves with replayed receipt -> clears store so subsequent lock/unlock is clean
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-retry-send-button' })
          .props.onPress();
        await flushAsync(12);
      });
      expect(sentRequests).toHaveLength(2);
      expect(sentRequests[1].clientRequestId).toBe(originalRequestId);
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivered (replayed)');

      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(8);
      });
      await cache.unlockAndGetCredentials({
        apiClient,
        allowDebugLoopback: true,
      });
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('active');
        await flushAsync(14);
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'session-chat-submission-banner',
        }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props.value,
      ).toBe('');
    } finally {
      appStateSpy.restore();
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) J72-1 preserves an in-flight pending send that settles to unknown while backgrounded and restores on unlock', async () => {
    const appStateSpy = setupAppStateSpy();
    let resolveInFlight!: (res: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;
    const sentIds: string[] = [];

    const request = makeChatTransport({
      session: makeSessionFixture({
        id: 'sess-j72-pending',
        name: 'Pending Across Lock',
        status: 'idle',
      }),
      messageHandler: req => {
        const parsed = req.body
          ? (JSON.parse(req.body) as { clientRequestId: string })
          : { clientRequestId: '' };
        sentIds.push(parsed.clientRequestId);
        return new Promise(resolve => {
          resolveInFlight = resolve;
        });
      },
    });

    const { renderer, cache, apiClient } = await renderUnlockedChatScreen({
      sessionId: 'sess-j72-pending',
      request,
    });

    try {
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-input' })
          .props.onChangeText('pending across lock');
      });
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-send-button' })
          .props.onPress();
        await flushAsync(4);
      });

      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(6);
      });

      // Server responds with HTTP 503 while backgrounded/locked
      await ReactTestRenderer.act(async () => {
        resolveInFlight({
          status: 503,
          retryAfter: null,
          body: JSON.stringify({ error: { code: 'upstream_unavailable' } }),
        });
        await flushAsync(10);
      });
      expect(getAllText(renderer)).not.toContain('pending across lock');

      await cache.unlockAndGetCredentials({
        apiClient,
        allowDebugLoopback: true,
      });
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('active');
        await flushAsync(14);
      });
      expect(
        renderer.root.findByProps({ testID: 'session-chat-submission-status' })
          .props.children,
      ).toBe('Delivery unknown');
      expect(
        renderer.root.findByProps({ testID: 'session-chat-input' }).props.value,
      ).toBe('pending across lock');

      // Explicit Discard removes it so future unlocks stay clean
      await ReactTestRenderer.act(async () => {
        renderer.root
          .findByProps({ testID: 'session-chat-discard-send-button' })
          .props.onPress();
        await flushAsync(6);
      });
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('background');
        await flushAsync(6);
      });
      await cache.unlockAndGetCredentials({
        apiClient,
        allowDebugLoopback: true,
      });
      await ReactTestRenderer.act(async () => {
        appStateSpy.emit('active');
        await flushAsync(14);
      });
      expect(
        renderer.root.findAllByProps({
          testID: 'session-chat-submission-banner',
        }),
      ).toHaveLength(0);
    } finally {
      appStateSpy.restore();
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });

  test('(FIXTURE) J72-2 unknown copy states the desktop-restart deduplication limit and does not claim unconditional safety', () => {
    const unknownCases = [
      mapSendResponseToSubmission(
        {
          apiVersion: 'v1',
          sessionId: 'sess-fixture-1',
          delivered: false,
          deliveryMethod: 'submit',
          status: 'unknown',
        },
        'mob-j72-1',
        'hello',
      ),
      mapSendFailureToSubmission(
        {
          ok: false,
          category: 'timeout',
          status: null,
          retryAfterSeconds: null,
        },
        'mob-j72-2',
        'hello',
      ),
      mapSendFailureToSubmission(
        {
          ok: false,
          category: 'server_error',
          status: 500,
          retryAfterSeconds: null,
        },
        'mob-j72-3',
        'hello',
      ),
      mapSendFailureToSubmission(
        {
          ok: false,
          category: 'rate_limited',
          status: 429,
          retryAfterSeconds: 8,
        },
        'mob-j72-4',
        'hello',
        { preserveUnknown: true },
      ),
      mapSendFailureToSubmission(
        {
          ok: false,
          category: 'server_error',
          status: 503,
          retryAfterSeconds: null,
        },
        'mob-j72-5',
        'hello',
        { preserveUnknown: true },
      ),
    ];

    for (const sub of unknownCases) {
      expect(sub.status).toBe('unknown');
      expect(sub.message.toLowerCase()).not.toContain('safely');
      expect(sub.message).toContain('while the desktop app stays running');
      expect(sub.message).toContain('desktop restart loses that protection');
      expect(sub.message).toContain('check the conversation before retrying');
    }
  });
});
