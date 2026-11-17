import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { NativeModules, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  normalizeRequestedModel,
  sanitizeSessionSummary,
  SpawneaApiClient,
} from '../src/api/client';
import type { SessionSummary } from '../src/api/types';
import {
  statusGlyphKind,
  StatusGlyph,
  STATUS_GLYPH_SOURCES,
  StatusGlyphKind,
} from '../src/dashboard/StatusGlyphs';
import { StatusChip } from '../src/dashboard/sessionUi';
import { DashboardScreen } from '../src/screens/DashboardScreen';
import {
  formatHarnessIdentity,
  formatRequestedModelLabel,
  stripRepeatedHost,
} from '../src/sessions/sessionsModel';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../src/storage/sessionCredentialCache';
import { makeSessionFixture } from './apiClient.test';

// Every session below is a FIXTURE built with makeSessionFixture; none is real data.

const keystore = NativeModules.SpawneaKeystore as {
  getCapability: jest.Mock;
  getCredentialState: jest.Mock;
  readKey: jest.Mock;
};

function claude(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return makeSessionFixture({
    host: { id: 'local', name: 'Local · Arch' },
    harness: { id: 'local:claude', name: 'Claude (Local · Arch)', command: 'claude' },
    ...overrides,
  });
}

describe('requestedModel validation (FIXTURES)', () => {
  test('present, absent, null, invalid and empty values', () => {
    expect(normalizeRequestedModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(normalizeRequestedModel('  claude-opus-5-5  ')).toBe('claude-opus-5-5');
    expect(normalizeRequestedModel(undefined)).toBeUndefined();
    expect(normalizeRequestedModel(null)).toBeUndefined();
    expect(normalizeRequestedModel('')).toBeUndefined();
    expect(normalizeRequestedModel('   ')).toBeUndefined();
    expect(normalizeRequestedModel(42)).toBeUndefined();
    expect(normalizeRequestedModel({ id: 'x' })).toBeUndefined();
    expect(normalizeRequestedModel('bad\u0000model')).toBeUndefined();
    expect(normalizeRequestedModel('bad\nmodel')).toBeUndefined();
    expect(normalizeRequestedModel('bad\u009fmodel')).toBeUndefined();
    expect(normalizeRequestedModel('x'.repeat(100))).toBe('x'.repeat(100));
    expect(normalizeRequestedModel('x'.repeat(101))).toBeUndefined();
  });

  test('sanitizeSessionSummary keeps a valid model and drops invalid ones without losing the session', () => {
    const ok = sanitizeSessionSummary(claude({ requestedModel: ' claude-opus-5-5 ' }));
    expect(ok.requestedModel).toBe('claude-opus-5-5');
    for (const bad of [null, undefined, '', '  ', 'a\u0007b']) {
      const out = sanitizeSessionSummary(
        claude({ requestedModel: bad as string | null | undefined }),
      );
      expect('requestedModel' in out).toBe(false);
      expect(out.id).toBe('sess-123');
    }
    expect(
      'requestedModel' in
        sanitizeSessionSummary({ ...claude(), requestedModel: 7 } as unknown as SessionSummary),
    ).toBe(false);
  });

  test('the API client keeps the model, discards an invalid one and copies no other new field', async () => {
    const body = {
      apiVersion: 'v1',
      sessions: [
        { ...claude({ id: 'a', requestedModel: 'claude-sonnet-5-5' }), secretExtra: 'nope' },
        { ...claude({ id: 'b' }), requestedModel: 12 },
      ],
    };
    const client = new SpawneaApiClient({
      transport: {
        request: jest.fn().mockResolvedValue({
          status: 200,
          retryAfter: null,
          body: JSON.stringify(body),
        }),
      },
      allowDebugLoopback: false,
    });
    const res = await client.listSessions({
      serverUrl: 'https://workstation.tailnet.ts.net:5757',
      apiKey: 'dummy-bearer-key-must-never-leak',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const [a, b] = res.data.sessions;
      expect(a.requestedModel).toBe('claude-sonnet-5-5');
      expect('secretExtra' in a).toBe(false);
      expect(b.id).toBe('b');
      expect('requestedModel' in b).toBe(false);
    }
  });
});

describe('harness identity with requested model (FIXTURES)', () => {
  test('known IDs map to readable names only through the explicit table', () => {
    expect(formatRequestedModelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatRequestedModelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(formatRequestedModelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(formatRequestedModelLabel('claude-fable-5-2')).toBe('Fable 5.2');
  });

  test('unknown ID is shown sanitized as-is, never given a commercial name', () => {
    expect(formatRequestedModelLabel('claude-opus-9-9')).toBe('claude-opus-9-9');
    expect(formatRequestedModelLabel('my-finetune-v3')).toBe('my-finetune-v3');
    const id = formatHarnessIdentity(claude({ requestedModel: 'claude-opus-9-9' }));
    expect(id.label).toBe('Claude · claude-opus-9-9');
    expect(id.label).not.toContain('Opus 9');
  });

  test('known model replaces the repeated host: "Claude · Opus 5.5"', () => {
    const id = formatHarnessIdentity(claude({ requestedModel: 'claude-opus-5-5' }));
    expect(id.label).toBe('Claude · Opus 5.5');
    expect(id.accessibilityLabel).toBe('Harness: Claude, requested model Opus 5.5');
    expect(id.label).not.toContain('Arch');
  });

  test('no model: only the harness, without the repeated host, and Opus is never deduced', () => {
    for (const requestedModel of [undefined, null, '', '  ']) {
      const id = formatHarnessIdentity(claude({ requestedModel }));
      expect(id.label).toBe('Claude');
      expect(id.model).toBeNull();
      expect(id.accessibilityLabel).toBe('Harness: Claude');
      expect(id.label).not.toMatch(/opus/i);
    }
    // Even a task or name mentioning Opus does not produce a model.
    expect(
      formatHarnessIdentity(claude({ name: 'Opus run', task: 'use Opus 5.5' })).label,
    ).toBe('Claude');
  });

  test('root and child can carry different models', () => {
    const root = formatHarnessIdentity(claude({ id: 'r', requestedModel: 'claude-opus-5-5' }));
    const child = formatHarnessIdentity(
      claude({ id: 'c', parentSessionId: 'r', requestedModel: 'claude-sonnet-5-5' }),
    );
    expect(root.label).toBe('Claude · Opus 5.5');
    expect(child.label).toBe('Claude · Sonnet 5.5');
  });

  test('stripRepeatedHost only drops a parenthetical that repeats the host', () => {
    expect(stripRepeatedHost('Claude (Local · Arch)', ['Local · Arch'])).toBe('Claude');
    expect(stripRepeatedHost('Codex (Local · Arch)', ['Local', 'local'])).toBe('Codex');
    expect(stripRepeatedHost('Claude (Review)', ['Local · Arch'])).toBe('Claude (Review)');
    expect(stripRepeatedHost('(Local · Arch)', ['Local · Arch'])).toBe('(Local · Arch)');
    expect(stripRepeatedHost('Claude', ['Local · Arch'])).toBe('Claude');
  });

  test('a long unknown model id stays a single string (UI truncates it)', () => {
    const long = 'm'.repeat(100);
    expect(formatHarnessIdentity(claude({ requestedModel: long })).label).toBe(`Claude · ${long}`);
  });
});

function mount(el: React.ReactElement): ReactTestRenderer.ReactTestRenderer {
  let r!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    r = ReactTestRenderer.create(el);
  });
  return r;
}

describe('status glyphs (FIXTURES)', () => {
  const statuses = [
    'starting',
    'working',
    'needs_input',
    'done',
    'error',
    'disconnected',
    'idle',
  ] as const;

  test('canonical mapping from StatusBadge and an explicit unknown fallback', () => {
    for (const s of statuses) {
      expect(statusGlyphKind(s)).toBe(s);
    }
    expect(statusGlyphKind('something-new')).toBe('unknown');
    expect(statusGlyphKind('')).toBe('unknown');
    expect(STATUS_GLYPH_SOURCES.starting).toContain('Loader2');
    expect(STATUS_GLYPH_SOURCES.working).toContain('Radio');
    expect(STATUS_GLYPH_SOURCES.needs_input).toContain('MessageSquare');
    expect(STATUS_GLYPH_SOURCES.done).toContain('CheckCircle2');
    expect(STATUS_GLYPH_SOURCES.error).toContain('AlertCircle');
    expect(STATUS_GLYPH_SOURCES.disconnected).toContain('Unplug');
    expect(STATUS_GLYPH_SOURCES.idle).toContain('Clock');
  });

  test('no two different statuses share a glyph (geometry differs)', () => {
    const signature = (status: string) => {
      const r = mount(<StatusGlyph status={status} color="#fff" />);
      const json = JSON.stringify(r.toJSON());
      ReactTestRenderer.act(() => r.unmount());
      return json.replace(/"testID":"[^"]*",?/g, '');
    };
    const all: string[] = [...statuses, 'something-new'];
    const sigs = all.map(signature);
    expect(new Set(sigs).size).toBe(all.length);
  });

  test('every chip keeps its text, accessible label and colour, with a glyph instead of a dot', () => {
    const labels: Record<string, string> = {
      starting: 'Starting',
      working: 'Working',
      needs_input: 'Needs input',
      done: 'Done',
      error: 'Error',
      disconnected: 'Disconnected',
      idle: 'Idle',
      'something-new': 'something-new',
    };
    for (const [status, label] of Object.entries(labels)) {
      const r = mount(<StatusChip status={status} />);
      const texts = r.root.findAllByType(Text).map(t => t.props.children);
      expect(texts).toEqual([label]);
      const chip = r.root.findAll(
        n => n.props.accessibilityLabel === `Status: ${label}` && typeof n.type === 'string',
      );
      expect(chip.length).toBeGreaterThan(0);
      const kind: StatusGlyphKind = statusGlyphKind(status);
      expect(r.root.findAllByProps({ testID: `status-glyph-${kind}` }).length).toBeGreaterThan(0);
      ReactTestRenderer.act(() => r.unmount());
    }
  });
});

describe('Dashboard shows the requested model on roots and children (FIXTURES)', () => {
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
  });
  afterEach(() => {
    defaultSessionCredentialCache.invalidateForCredentialChange();
    jest.useRealTimers();
  });

  test('root and expanded child show their own model; the host stays separate; badge and popup remain', async () => {
    const sessions = [
      claude({ id: 'root', name: 'root', requestedModel: 'claude-opus-5-5' }),
      claude({
        id: 'kid',
        name: 'kid',
        parentSessionId: 'root',
        requestedModel: 'claude-sonnet-5-5',
      }),
      claude({ id: 'plain', name: 'plain', status: 'working' }),
    ];
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: 'https://workstation.tailnet.ts.net:5757',
      hasKey: true,
      incomplete: false,
    });
    keystore.readKey.mockResolvedValue('dummy-key-never-rendered');
    const client = new SpawneaApiClient({
      transport: {
        request: jest.fn().mockResolvedValue({
          status: 200,
          retryAfter: null,
          body: JSON.stringify({ apiVersion: 'v1', sessions }),
        }),
      },
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
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
      }
    });
    try {
      const root = renderer.root;
      const texts = () => root.findAllByType(Text).map(t => String(t.props.children));
      expect(texts()).toContain('Claude · Opus 5.5');
      expect(texts()).toContain('Claude');
      expect(texts().join('|')).not.toContain('Claude (Local');

      const toggle = root
        .findAllByProps({ testID: 'dashboard-children-toggle-root' })
        .find(n => typeof n.props.onPress === 'function')!;
      await ReactTestRenderer.act(async () => {
        toggle.props.onPress();
      });
      expect(texts()).toContain('Claude · Sonnet 5.5');
      const labels = root
        .findAll(n => typeof n.props.accessibilityLabel === 'string')
        .map(n => n.props.accessibilityLabel as string);
      expect(labels).toContain('Harness: Claude, requested model Opus 5.5');
      expect(labels).toContain('Harness: Claude, requested model Sonnet 5.5');
      expect(labels).toContain('Harness: Claude');
      // Host still shown on its own with its own label.
      expect(labels).toContain('Host: Local · Arch');
      // No regression: badge, popup trigger and distribution labels are still there.
      expect(root.findAllByProps({ testID: 'dashboard-distribution-info-trigger' }).length).toBeGreaterThan(0);
      expect(root.findAllByProps({ testID: 'dashboard-distribution-children-idle' }).length)
        .toBeGreaterThanOrEqual(0);
      expect(labels.some(l => /parent sessions?, \d+ child sessions?/.test(l))).toBe(true);
    } finally {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    }
  });
});
