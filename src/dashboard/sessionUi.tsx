import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  DashboardErrorKind,
  formatSessionStatusLabel,
} from './dashboardModel';

export type ConnectionBadgeState =
  | { status: 'live' | 'empty' | 'loading' }
  | {
      status: 'stale';
      errorKind: DashboardErrorKind | 'locked';
    }
  | { status: 'locked' }
  | {
      status: 'not_configured';
      reason: 'not_configured' | 'incomplete_config' | 'invalid_url';
    }
  | {
      status: 'error';
      error: { kind: DashboardErrorKind };
    };

export function connectionBadgeLabel(viewState: ConnectionBadgeState): string {
  switch (viewState.status) {
    case 'live':
    case 'empty':
      return 'Live';
    case 'stale':
      switch (viewState.errorKind) {
        case 'auth_rejected':
          return 'Stale · Auth rejected';
        case 'rate_limited':
          return 'Stale · Rate limited';
        case 'offline':
          return 'Stale · Offline';
        case 'server_error':
          return 'Stale · Server error';
        case 'locked':
          return 'Stale · Locked';
        default:
          return 'Stale';
      }
    case 'loading':
      return 'Loading';
    case 'locked':
      return 'Locked';
    case 'not_configured':
      return viewState.reason === 'incomplete_config'
        ? 'Incomplete configuration'
        : 'Not configured';
    case 'error':
      switch (viewState.error.kind) {
        case 'auth_rejected':
          return 'Auth rejected (HTTP 401)';
        case 'rate_limited':
          return 'Rate limited (HTTP 429)';
        case 'offline':
          return 'Offline / unreachable';
        case 'server_error':
          return 'Server error';
        case 'not_configured':
          return 'Not configured';
      }
  }
}

export function errorHeadingForKind(kind: DashboardErrorKind): string {
  switch (kind) {
    case 'auth_rejected':
      return 'Authentication rejected';
    case 'rate_limited':
      return 'Rate limited by server';
    case 'offline':
      return 'Server offline or unreachable';
    case 'server_error':
      return 'Server error';
    case 'not_configured':
      return 'Not configured';
  }
}

export function statusChipVisuals(status: string): {
  container: object;
  dot: string;
  text: string;
} {
  switch (status) {
    case 'needs_input':
      return {
        container: sessionUiStyles.chipNeedsInput,
        dot: '#fbbf24',
        text: '#fde68a',
      };
    case 'working':
    case 'starting':
      return {
        container: sessionUiStyles.chipRunning,
        dot: '#34d399',
        text: '#a7f3d0',
      };
    case 'error':
    case 'disconnected':
      return {
        container: sessionUiStyles.chipError,
        dot: '#f87171',
        text: '#fecaca',
      };
    default:
      return {
        container: sessionUiStyles.chipNeutral,
        dot: '#94a3b8',
        text: '#cbd5e1',
      };
  }
}

export function badgeVisuals(viewState: ConnectionBadgeState): {
  container: object;
  dot: string;
  text: string;
} {
  switch (viewState.status) {
    case 'live':
    case 'empty':
      return {
        container: sessionUiStyles.badgeLive,
        dot: '#34d399',
        text: '#6ee7b7',
      };
    case 'stale':
      return {
        container: sessionUiStyles.badgeStale,
        dot: '#fbbf24',
        text: '#fde68a',
      };
    case 'error':
      return {
        container: sessionUiStyles.badgeError,
        dot: '#f87171',
        text: '#fecaca',
      };
    default:
      return {
        container: sessionUiStyles.badgeNeutral,
        dot: '#94a3b8',
        text: '#cbd5e1',
      };
  }
}

export function StatusChip({ status }: { status: string }): React.JSX.Element {
  const visuals = statusChipVisuals(status);
  const label = formatSessionStatusLabel(status);
  return (
    <View
      style={[sessionUiStyles.statusChip, visuals.container]}
      accessible
      accessibilityLabel={`Status: ${label}`}>
      <View
        style={[sessionUiStyles.statusChipDot, { backgroundColor: visuals.dot }]}
      />
      <Text style={[sessionUiStyles.statusChipText, { color: visuals.text }]}>
        {label}
      </Text>
    </View>
  );
}

export const sessionUiStyles = StyleSheet.create({
  badgeLive: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderColor: '#059669',
  },
  badgeStale: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: '#d97706',
  },
  badgeError: {
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    borderColor: '#dc2626',
  },
  badgeNeutral: {
    backgroundColor: '#161b22',
    borderColor: '#30363d',
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipNeedsInput: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: '#d97706',
  },
  chipRunning: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderColor: '#059669',
  },
  chipError: {
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    borderColor: '#dc2626',
  },
  chipNeutral: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
    borderColor: '#475569',
  },
  statusChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusChipText: {
    fontSize: 11,
    fontWeight: '700',
  },
});
