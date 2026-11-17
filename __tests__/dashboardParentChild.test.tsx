import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { NativeModules, PixelRatio, StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { SpawneaApiClient } from '../src/api/client';
import type { SessionSummary } from '../src/api/types';
import {
  computeDistributionSummary,
  formatDistributionAccessibilityLabel,
  isChildSession,
} from '../src/dashboard/dashboardModel';
import { DashboardScreen } from '../src/screens/DashboardScreen';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../src/storage/sessionCredentialCache';
import { makeSessionFixture } from './apiClient.test';

// All sessions in this file are FIXTURES built with makeSessionFixture; none are real data.

const keystore = NativeModules.SpawneaKeystore as {
  getCapability: jest.Mock;
  getCredentialState: jest.Mock;
  readKey: jest.Mock;
};

type Status = SessionSummary['status'];

function fx(
  id: string,
  status: Status,
  parentSessionId?: string | null,
): SessionSummary {
  return makeSessionFixture({ id, name: id, status, parentSessionId });
}

function byCategory(sessions: SessionSummary[]) {
  const summary = computeDistributionSummary(sessions);
  return {
    summary,
    pc: Object.fromEntries(
      summary.categories.map(c => [c.category, [c.parentCount, c.childCount]]),
    ),
  };
}

describe('computeDistributionSummary parents vs children (FIXTURES)', () => {
  test('mixed counts, parent and child in different states, each counted once by its own status', () => {
    const { summary, pc } = byCategory([
      fx('root-working', 'working'),
      fx('child-idle-of-working', 'idle', 'root-working'),
      fx('child-starting', 'starting', 'root-working'),
      fx('root-done', 'done', null),
      fx('child-error', 'error', 'root-done'),
      fx('child-disconnected', 'disconnected', 'root-done'),
      fx('root-needs', 'needs_input', undefined),
    ]);
    expect(pc).toEqual({
      'need-input': [1, 0],
      running: [1, 1],
      'done/idle': [1, 1],
      error: [0, 2],
    });
    expect(summary.total).toBe(7);
    expect(summary.unknownCount).toBe(0);
    // Total and bar proportions stay on all sessions.
    expect(summary.categories.map(c => c.count)).toEqual([1, 2, 2, 2]);
    expect(
      summary.categories.reduce((acc, c) => acc + c.parentCount + c.childCount, 0),
    ).toBe(summary.total);
  });

  test('root = null, undefined, empty or whitespace parentSessionId; child = any non-empty id', () => {
    for (const parent of [null, undefined, '', '   ', '\t\n']) {
      expect([parent, isChildSession(fx('r', 'idle', parent))]).toEqual([parent, false]);
    }
    for (const parent of ['p1', ' p1 ', 'missing-parent']) {
      expect([parent, isChildSession(fx('c', 'idle', parent))]).toEqual([parent, true]);
    }
  });

  test('zeros: no sessions and groups without sessions', () => {
    const empty = byCategory([]);
    expect(empty.summary.total).toBe(0);
    expect(empty.pc).toEqual({
      'need-input': [0, 0],
      running: [0, 0],
      'done/idle': [0, 0],
      error: [0, 0],
    });
    expect(byCategory([fx('a', 'working')]).pc.error).toEqual([0, 0]);
  });

  test('only children: parents is 0 and children keep counting', () => {
    const { pc } = byCategory([
      fx('c1', 'working', 'p'),
      fx('c2', 'working', 'p'),
      fx('c3', 'working', 'p'),
    ]);
    expect(pc.running).toEqual([0, 3]);
  });

  test('absent parent stays a child; a child with descendants stays a child', () => {
    const { pc } = byCategory([
      fx('orphan-child', 'working', 'not-in-list'),
      fx('mid', 'working', 'root'),
      fx('grandchild', 'working', 'mid'),
      fx('root', 'working'),
    ]);
    expect(pc.running).toEqual([1, 3]);
  });

  test('unknown statuses are counted apart, whether root or child, without a fifth group', () => {
    const { summary, pc } = byCategory([
      fx('u-root', 'archived' as Status),
      fx('u-child', 'mystery' as Status, 'u-root'),
      fx('k', 'working'),
    ]);
    expect(summary.unknownCount).toBe(2);
    expect(summary.categories).toHaveLength(4);
    expect(summary.total).toBe(3);
    expect(pc.running).toEqual([1, 0]);
  });

  test('large numbers: 999, 1000 and 1500 are exact', () => {
    const many: SessionSummary[] = [
      ...Array.from({ length: 999 }, (_, i) => fx(`r${i}`, 'working')),
      ...Array.from({ length: 1000 }, (_, i) => fx(`d${i}`, 'idle', 'p')),
      ...Array.from({ length: 1500 }, (_, i) => fx(`e${i}`, 'error', 'p')),
      ...Array.from({ length: 1001 }, (_, i) => fx(`x${i}`, 'error')),
    ];
    const { summary, pc } = byCategory(many);
    expect(pc.running).toEqual([999, 0]);
    expect(pc['done/idle']).toEqual([0, 1000]);
    expect(pc.error).toEqual([1001, 1500]);
    expect(summary.total).toBe(999 + 1000 + 1500 + 1001);
  });

  test('accessible labels state both numbers with singular/plural', () => {
    const labelFor = (parentCount: number, childCount: number) =>
      formatDistributionAccessibilityLabel({ label: 'Running', parentCount, childCount });
    expect(labelFor(2, 3)).toBe('Running: 2 parent sessions, 3 child sessions');
    expect(labelFor(1, 1)).toBe('Running: 1 parent session, 1 child session');
    expect(labelFor(0, 4)).toBe('Running: 0 parent sessions, 4 child sessions');
    expect(labelFor(5, 0)).toBe('Running: 5 parent sessions, 0 child sessions');
    expect(labelFor(1000, 1500)).toBe(
      'Running: 1000 parent sessions, 1500 child sessions',
    );
  });
});

async function flushAsync(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

async function renderDashboard(
  sessions: SessionSummary[],
  barWidth?: number,
): Promise<{
  renderer: ReactTestRenderer.ReactTestRenderer;
  cleanup: () => Promise<void>;
}> {
  keystore.getCredentialState.mockResolvedValue({
    serverUrl: 'https://workstation.tailnet.ts.net:5757',
    hasKey: true,
    incomplete: false,
  });
  keystore.readKey.mockResolvedValue('dummy-key-never-rendered');
  const request = jest.fn().mockResolvedValue({
    status: 200,
    retryAfter: null,
    body: JSON.stringify({ apiVersion: 'v1', sessions }),
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
  if (barWidth !== undefined) {
    const bar = renderer.root.findByProps({
      testID: 'dashboard-distribution-bar',
    });
    await ReactTestRenderer.act(async () => {
      bar.props.onLayout({ nativeEvent: { layout: { width: barWidth } } });
    });
  }
  return {
    renderer,
    cleanup: async () => {
      await ReactTestRenderer.act(async () => {
        renderer.unmount();
      });
      cache.dispose();
    },
  };
}

function textsIn(node: ReactTestRenderer.ReactTestInstance): string[] {
  return node.findAllByType(Text).map(t => String(t.props.children));
}

describe('DashboardScreen parent/child distribution (FIXTURES)', () => {
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
    jest.restoreAllMocks();
  });

  const mixed = [
    fx('r1', 'working'),
    fx('r2', 'working'),
    fx('c1', 'working', 'r1'),
    fx('c2', 'idle', 'r1'),
    fx('c3', 'error', 'ghost-parent'),
    fx('c4', 'needs_input', 'r2'),
    fx('c5', 'needs_input', 'r2'),
  ];

  test('legend shows "parents [children] label", omits the 0 badge, shows 0 parents for children-only groups', async () => {
    const { renderer, cleanup } = await renderDashboard(mixed);
    try {
      const parents = (cat: string) =>
        renderer.root.findByProps({ testID: `dashboard-distribution-parents-${cat}` })
          .props.children;
      const badge = (cat: string) =>
        renderer.root.findAllByProps({ testID: `dashboard-distribution-children-${cat}` });

      expect(parents('running')).toBe(2);
      expect(badge('running').length).toBeGreaterThan(0);
      expect(textsIn(badge('running')[0])).toEqual(['1']);
      // Only children: main number is 0.
      expect(parents('need-input')).toBe(0);
      expect(textsIn(badge('need-input')[0])).toEqual(['2']);
      expect(parents('error')).toBe(0);
      expect(textsIn(badge('error')[0])).toEqual(['1']);
      expect(parents('done/idle')).toBe(0);
      expect(badge('done/idle').length).toBeGreaterThan(0); // c2 is an idle child
      // No "parents/children" notation anywhere in the summary (the label "Done/idle" is not one).
      const summaryTexts = textsIn(
        renderer.root.findByProps({ testID: 'dashboard-summary-card' }),
      ).join('|');
      expect(summaryTexts).not.toMatch(/\d\s*\/\s*\d/);
    } finally {
      await cleanup();
    }
  });

  test('badge is omitted when a group has no children', async () => {
    const { renderer, cleanup } = await renderDashboard([
      fx('a', 'working'),
      fx('b', 'working'),
    ]);
    try {
      expect(
        renderer.root.findAllByProps({ testID: 'dashboard-distribution-children-running' }),
      ).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-distribution-parents-running' })
          .props.children,
      ).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test('each group has one complete accessible label and Total stays on all sessions', async () => {
    const { renderer, cleanup } = await renderDashboard(mixed);
    try {
      const label = (cat: string) =>
        renderer.root.findByProps({ testID: `dashboard-legend-item-${cat}` }).props;
      expect(label('running').accessibilityLabel).toBe(
        'Running: 2 parent sessions, 1 child session',
      );
      expect(label('need-input').accessibilityLabel).toBe(
        'Need input: 0 parent sessions, 2 child sessions',
      );
      expect(label('error').accessibilityLabel).toBe(
        'Error: 0 parent sessions, 1 child session',
      );
      expect(label('done/idle').accessibilityLabel).toBe(
        'Done/idle: 0 parent sessions, 1 child session',
      );
      expect(label('running').accessible).toBe(true);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-total-sessions' }).props.children,
      ).toEqual(['Total: ', 7]);
    } finally {
      await cleanup();
    }
  });

  test('child badge is a filled red overlay with light text, round for one digit and capsule for several (FIXTURES)', async () => {
    const sessions = [
      fx('p1', 'working'),
      ...Array.from({ length: 12 }, (_, i) => fx(`c${i}`, 'working', 'p1')),
      ...Array.from({ length: 3 }, (_, i) => fx(`i${i}`, 'idle')),
      ...Array.from({ length: 2 }, (_, i) => fx(`ic${i}`, 'idle', 'i0')),
    ];
    const { renderer, cleanup } = await renderDashboard(sessions);
    try {
      const flat = (id: string) =>
        StyleSheet.flatten(
          renderer.root.findAllByProps({ testID: id }).find(n => typeof n.type === 'string')!
            .props.style,
        );
      const multi = flat('dashboard-distribution-children-running');
      const single = flat('dashboard-distribution-children-done/idle');
      for (const st of [multi, single]) {
        expect(st.position).toBe('absolute');
        expect(st.backgroundColor).toBe('#dc2626');
        expect(st.borderRadius).toBeGreaterThanOrEqual(st.height / 2);
        expect(st.top).toBeLessThan(0);
        expect(st.right).toBeLessThan(0);
      }
      // minWidth === height -> circle for one digit; wider content grows into a capsule.
      expect(single.minWidth).toBe(single.height);
      const text = renderer.root
        .findAllByProps({ testID: 'dashboard-distribution-children-running' })
        .find(n => typeof n.type === 'string')!
        .findByType(Text);
      expect(StyleSheet.flatten(text.props.style).color).toBe('#ffffff');
    } finally {
      await cleanup();
    }
  });

  test('no fixed key at rest; an info trigger opens a compact popup that closes with button, backdrop and Back (FIXTURES)', async () => {
    const { renderer, cleanup } = await renderDashboard(mixed);
    try {
      const root = renderer.root;
      expect(root.findAllByProps({ testID: 'dashboard-distribution-key' })).toHaveLength(0);
      const allText = () => root.findAllByType(Text).map(t => String(t.props.children));
      expect(allText().join('|')).not.toContain('Number = parent');

      const pressable = (id: string) =>
        root.findAllByProps({ testID: id }).find(n => typeof n.props.onPress === 'function')!;
      const trigger = pressable('dashboard-distribution-info-trigger');
      expect(trigger.props.accessibilityLabel).toBe('About session counts');
      expect(trigger.props.accessibilityRole).toBe('button');
      expect(root.findByProps({ testID: 'dashboard-distribution-info-modal' }).props.visible).toBe(false);

      const modal = () => root.findByProps({ testID: 'dashboard-distribution-info-modal' });
      for (const closer of ['close', 'backdrop', 'back'] as const) {
        await ReactTestRenderer.act(async () => {
          trigger.props.onPress();
        });
        expect(modal().props.visible).toBe(true);
        const text = allText();
        expect(text).toEqual(
          expect.arrayContaining([
            'Session counts',
            'Number = parent sessions',
            'Red badge = child sessions',
            'Total and bar include all sessions',
          ]),
        );
        await ReactTestRenderer.act(async () => {
          if (closer === 'close') {
            pressable('dashboard-distribution-info-close').props.onPress();
          } else if (closer === 'backdrop') {
            pressable('dashboard-distribution-info-backdrop').props.onPress();
          } else {
            modal().props.onRequestClose();
          }
        });
        expect(modal().props.visible).toBe(false);
      }
      // Counts and labels are unchanged by the popup.
      expect(
        root.findByProps({ testID: 'dashboard-legend-item-running' }).props.accessibilityLabel,
      ).toBe('Running: 2 parent sessions, 1 child session');
    } finally {
      await cleanup();
    }
  });

  test('badge hangs past the number corner without covering the digits, for multi-digit counts (FIXTURES)', async () => {
    const sessions = [
      ...Array.from({ length: 12 }, (_, i) => fx(`p${i}`, 'working')),
      ...Array.from({ length: 3 }, (_, i) => fx(`pc${i}`, 'working', 'p0')),
      ...Array.from({ length: 1000 }, (_, i) => fx(`q${i}`, 'idle')),
      ...Array.from({ length: 25 }, (_, i) => fx(`qc${i}`, 'idle', 'q0')),
    ];
    const { renderer, cleanup } = await renderDashboard(sessions, 600);
    try {
      const host = (id: string) =>
        renderer.root.findAllByProps({ testID: id }).find(n => typeof n.type === 'string')!;
      for (const [cat, digits] of [['running', 1], ['done/idle', 2]] as const) {
        for (const prefix of ['dashboard-distribution-children-']) {
          const st = StyleSheet.flatten(host(prefix + cat).props.style);
          // right edge = -width: the badge starts exactly where the number box ends.
          expect(st.right).toBe(-st.width);
          expect(st.width).toBeGreaterThanOrEqual(digits === 1 ? 15 : 22);
        }
        // The wrapper reserves the badge width on the right so nothing is clipped.
        const parents = host(`dashboard-distribution-parents-${cat}`);
        let node = parents.parent;
        while (node && StyleSheet.flatten(node.props.style)?.marginRight === undefined) {
          node = node.parent;
        }
        const wrap = StyleSheet.flatten(node!.props.style);
        const badge = StyleSheet.flatten(host(`dashboard-distribution-children-${cat}`).props.style);
        expect(wrap.marginRight).toBe(badge.width);
      }
      expect(host('dashboard-distribution-parents-running').props.children).toBe(12);
      expect(host('dashboard-distribution-parents-done/idle').props.children).toBe(1000);
      expect(host('dashboard-distribution-children-done/idle').findByType(Text).props.children).toBe(25);
    } finally {
      await cleanup();
    }
  });

  test('multi-digit badge also fits in a wide bar segment, anchored the same way (FIXTURES)', async () => {
    const sessions = [
      ...Array.from({ length: 12 }, (_, i) => fx(`p${i}`, 'working')),
      ...Array.from({ length: 3 }, (_, i) => fx(`pc${i}`, 'working', 'p0')),
      ...Array.from({ length: 12 }, (_, i) => fx(`q${i}`, 'idle')),
      ...Array.from({ length: 25 }, (_, i) => fx(`qc${i}`, 'idle', 'q0')),
    ];
    const { renderer, cleanup } = await renderDashboard(sessions, 600);
    try {
      for (const cat of ['running', 'done/idle']) {
        const badge = renderer.root
          .findAllByProps({ testID: `dashboard-bar-child-badge-${cat}` })
          .find(n => typeof n.type === 'string')!;
        const st = StyleSheet.flatten(badge.props.style);
        expect(st.right).toBe(-st.width);
        expect(st.position).toBe('absolute');
      }
    } finally {
      await cleanup();
    }
  });

  test('segments show "parents [children]" when wide enough and keep only the full accessibility label when narrow', async () => {
    const { renderer, cleanup } = await renderDashboard(mixed, 302);
    try {
      const seg = (cat: string) =>
        renderer.root.findByProps({ testID: `dashboard-bar-segment-${cat}` });
      // running: 3 of 7 sessions, 3/7*300 = 128dp: parent '2' + badge '1' fit.
      expect(textsIn(seg('running'))).toEqual(['2', '1']);
      expect(seg('running').props.accessibilityLabel).toBe(
        'Running: 2 parent sessions, 1 child session',
      );
      expect(seg('error').props.accessibilityLabel).toBe(
        'Error: 0 parent sessions, 1 child session',
      );
    } finally {
      await cleanup();
    }
  });

  test('narrow segments keep no inner text but still expose the label', async () => {
    const many = [
      ...Array.from({ length: 40 }, (_, i) => fx(`i${i}`, 'idle')),
      fx('tiny-child', 'error', 'i0'),
    ];
    const { renderer, cleanup } = await renderDashboard(many, 322);
    try {
      const err = renderer.root.findByProps({ testID: 'dashboard-bar-segment-error' });
      expect(err.findAllByType(Text)).toHaveLength(0);
      expect(err.props.accessibilityLabel).toBe('Error: 0 parent sessions, 1 child session');
      const idle = renderer.root.findByProps({ testID: 'dashboard-bar-segment-done/idle' });
      expect(textsIn(idle)).toEqual(['40']);
    } finally {
      await cleanup();
    }
  });

  test('large system font drops segment text that no longer fits but keeps the legend and labels', async () => {
    const sessions = [
      ...Array.from({ length: 3 }, (_, i) => fx(`w${i}`, 'working')),
      ...Array.from({ length: 4 }, (_, i) => fx(`wc${i}`, 'working', 'w0')),
      ...Array.from({ length: 13 }, (_, i) => fx(`d${i}`, 'idle')),
    ];
    // running = 7/20 of 120dp = 42dp. '3' + badge '4' needs 9 * scale + 17 + 8.
    const normal = await renderDashboard(sessions, 122);
    try {
      expect(
        textsIn(normal.renderer.root.findByProps({ testID: 'dashboard-bar-segment-running' })),
      ).toEqual(['3', '4']);
    } finally {
      await normal.cleanup();
    }

    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2.4);
    const large = await renderDashboard(sessions, 122);
    try {
      const seg = large.renderer.root.findByProps({ testID: 'dashboard-bar-segment-running' });
      expect(seg.findAllByType(Text)).toHaveLength(0);
      expect(seg.props.accessibilityLabel).toBe('Running: 3 parent sessions, 4 child sessions');
      expect(
        large.renderer.root.findByProps({ testID: 'dashboard-legend-item-running' }).props
          .accessibilityLabel,
      ).toBe('Running: 3 parent sessions, 4 child sessions');
      expect(
        large.renderer.root.findByProps({ testID: 'dashboard-distribution-parents-running' })
          .props.children,
      ).toBe(3);
    } finally {
      await large.cleanup();
    }
  });

  test('large numbers render in full in the legend and labels (999, 1000, 1500)', async () => {
    const sessions = [
      ...Array.from({ length: 999 }, (_, i) => fx(`r${i}`, 'working')),
      ...Array.from({ length: 1500 }, (_, i) => fx(`c${i}`, 'working', 'r0')),
      ...Array.from({ length: 1000 }, (_, i) => fx(`d${i}`, 'idle')),
    ];
    const { renderer, cleanup } = await renderDashboard(sessions, 302);
    try {
      expect(
        renderer.root.findByProps({ testID: 'dashboard-distribution-parents-running' })
          .props.children,
      ).toBe(999);
      expect(
        textsIn(
          renderer.root.findByProps({ testID: 'dashboard-distribution-children-running' }),
        ),
      ).toEqual(['1500']);
      expect(
        renderer.root.findByProps({ testID: 'dashboard-legend-item-done/idle' }).props
          .accessibilityLabel,
      ).toBe('Done/idle: 1000 parent sessions, 0 child sessions');
      expect(
        renderer.root.findByProps({ testID: 'dashboard-total-sessions' }).props.children,
      ).toEqual(['Total: ', 3499]);
    } finally {
      await cleanup();
    }
  });
});
