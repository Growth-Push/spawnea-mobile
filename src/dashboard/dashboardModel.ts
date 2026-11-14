import { formatApiErrorMessage } from '../api/client';
import type { ApiErrorCategory, ApiResult, SessionSummary } from '../api/types';

/**
 * Exact session status values defined by the Spawnea backend contract
 * (`SessionStatus` in `packages/domain`). Ordered with `needs_input` first so
 * actionable prompts stay highlighted in summaries.
 */
export const CANONICAL_SESSION_STATUSES = [
  'needs_input',
  'working',
  'starting',
  'idle',
  'done',
  'error',
  'disconnected',
] as const;

export type CanonicalSessionStatus =
  (typeof CANONICAL_SESSION_STATUSES)[number];

export interface StatusCountItem {
  status: string;
  count: number;
  isCanonical: boolean;
}

export interface DashboardStatusSummary {
  total: number;
  counts: StatusCountItem[];
}

export type DashboardErrorKind =
  | 'not_configured'
  | 'auth_rejected'
  | 'rate_limited'
  | 'offline'
  | 'server_error';

export interface DashboardRefreshError {
  kind: DashboardErrorKind;
  category: ApiErrorCategory;
  status: number | null;
  retryAfterSeconds: number | null;
  message: string;
}

export interface DashboardSnapshot {
  sessions: SessionSummary[];
  lastUpdatedAtMs: number;
  serverUrl: string;
  credentialGeneration: number;
}

export type DashboardViewState =
  | {
      status: 'not_configured';
      reason: 'not_configured' | 'incomplete_config' | 'invalid_url';
      message: string;
    }
  | {
      status: 'locked';
      reason: string;
      message: string;
    }
  | {
      status: 'loading';
      message: string;
    }
  | {
      status: 'error';
      error: DashboardRefreshError;
    }
  | {
      status: 'live';
      snapshot: DashboardSnapshot;
    }
  | {
      status: 'empty';
      snapshot: DashboardSnapshot;
    }
  | {
      status: 'stale';
      snapshot: DashboardSnapshot;
      staleReason: string;
      errorKind: DashboardErrorKind | 'locked';
      retryAfterSeconds: number | null;
    };

function parseTimestampMs(session: SessionSummary): number {
  const activityMs = Date.parse(session.lastActivityAt);
  if (Number.isFinite(activityMs)) {
    return activityMs;
  }
  const createdMs = Date.parse(session.createdAt);
  return Number.isFinite(createdMs) ? createdMs : 0;
}

/**
 * Computes exact session counts grouped by real API `status` strings from the
 * `/api/v1/sessions` list response without synthesizing metrics or states.
 */
export function computeStatusSummary(
  sessions: SessionSummary[],
): DashboardStatusSummary {
  const tally = new Map<string, number>();
  for (const session of sessions) {
    tally.set(session.status, (tally.get(session.status) ?? 0) + 1);
  }

  const canonicalSet = new Set<string>(CANONICAL_SESSION_STATUSES);
  const counts: StatusCountItem[] = CANONICAL_SESSION_STATUSES.map(status => ({
    status,
    count: tally.get(status) ?? 0,
    isCanonical: true,
  }));

  const extraStatuses = Array.from(tally.keys())
    .filter(status => !canonicalSet.has(status))
    .sort((a, b) => a.localeCompare(b));

  for (const status of extraStatuses) {
    counts.push({
      status,
      count: tally.get(status) ?? 0,
      isCanonical: false,
    });
  }

  return {
    total: sessions.length,
    counts,
  };
}

/**
 * Orders sessions with `needs_input` strictly first, then by `lastActivityAt`
 * descending, with stable `id` tie-breaking.
 */
export function sortDashboardSessions(
  sessions: SessionSummary[],
): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const aNeedsInput = a.status === 'needs_input';
    const bNeedsInput = b.status === 'needs_input';
    if (aNeedsInput !== bNeedsInput) {
      return aNeedsInput ? -1 : 1;
    }
    const timeDelta = parseTimestampMs(b) - parseTimestampMs(a);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return a.id.localeCompare(b.id);
  });
}

export function partitionDashboardSessions(sessions: SessionSummary[]): {
  needsInput: SessionSummary[];
  otherSessions: SessionSummary[];
} {
  const sorted = sortDashboardSessions(sessions);
  const needsInput: SessionSummary[] = [];
  const otherSessions: SessionSummary[] = [];
  for (const session of sorted) {
    if (session.status === 'needs_input') {
      needsInput.push(session);
    } else {
      otherSessions.push(session);
    }
  }
  return { needsInput, otherSessions };
}

export function mapApiFailureToDashboardError(
  failure: Extract<ApiResult<unknown>, { ok: false }>,
): DashboardRefreshError {
  const message = formatApiErrorMessage(
    failure.category,
    failure.status,
    failure.retryAfterSeconds,
  );
  let kind: DashboardErrorKind;
  switch (failure.category) {
    case 'unauthorized':
    case 'polling_paused_auth':
      kind = 'auth_rejected';
      break;
    case 'rate_limited':
      kind = 'rate_limited';
      break;
    case 'network_error':
    case 'timeout':
    case 'tls_error':
      kind = 'offline';
      break;
    case 'incomplete_config':
    case 'invalid_url':
      kind = 'not_configured';
      break;
    case 'server_error':
    case 'malformed_response':
    case 'invalid_request':
      kind = 'server_error';
      break;
  }

  return {
    kind,
    category: failure.category,
    status: failure.status,
    retryAfterSeconds: failure.retryAfterSeconds,
    message,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Formats a UTC-based or local wall-clock time string deterministically.
 */
export function formatLastUpdatedTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds(),
  )}`;
}

/**
 * Formats a non-negative duration in human-readable age units (`0s`, `15s`, `2m 5s`, `1h 3m`).
 */
export function formatAgeDuration(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return remainingSeconds > 0
      ? `${totalMinutes}m ${remainingSeconds}s`
      : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
