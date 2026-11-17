import { formatApiErrorMessage } from '../api/client';
import type { ApiErrorCategory, ApiResult, SessionSummary } from '../api/types';

/**
 * Exact session status values defined by the Spawnea backend contract
 * (`SessionStatus` in `packages/domain`).
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

export type DashboardDistributionCategory =
  | 'need-input'
  | 'running'
  | 'done/idle'
  | 'error';

export interface DistributionCategoryItem {
  category: DashboardDistributionCategory;
  label: string;
  /** All sessions in the group (parents + children); drives the bar proportions. */
  count: number;
  /** Root sessions: `parentSessionId` null, undefined, empty or whitespace. */
  parentCount: number;
  /** Child sessions: non-empty `parentSessionId`, resolved or not, with or without descendants. */
  childCount: number;
}

export interface DashboardDistributionSummary {
  total: number;
  unknownCount: number;
  categories: DistributionCategoryItem[];
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
 * Maps a raw API `status` into one of the four Dashboard distribution groups:
 * `needs_input` -> `need-input`, `working`+`starting` -> `running`,
 * `idle`+`done` -> `done/idle`, `error`+`disconnected` -> `error`.
 * Unrecognized statuses return `null` so they are counted separately without
 * creating a fifth category or inferring semantics.
 */
export function mapSessionStatusToCategory(
  status: string,
): DashboardDistributionCategory | null {
  switch (status) {
    case 'needs_input':
      return 'need-input';
    case 'working':
    case 'starting':
      return 'running';
    case 'idle':
    case 'done':
      return 'done/idle';
    case 'error':
    case 'disconnected':
      return 'error';
    default:
      return null;
  }
}

/**
 * A session is a child when it has a non-empty `parentSessionId`, even if that
 * parent is not in the list and even if the session has descendants itself.
 */
export function isChildSession(session: SessionSummary): boolean {
  const parentId = session.parentSessionId;
  return typeof parentId === 'string' && parentId.trim() !== '';
}

function pluralizeSessions(count: number, kind: 'parent' | 'child'): string {
  return `${count} ${kind} ${count === 1 ? 'session' : 'sessions'}`;
}

/**
 * Full accessible label for a distribution group, e.g.
 * "Running: 2 parent sessions, 3 child sessions". Always states both numbers.
 */
export function formatDistributionAccessibilityLabel(
  item: Pick<DistributionCategoryItem, 'label' | 'parentCount' | 'childCount'>,
): string {
  return `${item.label}: ${pluralizeSessions(
    item.parentCount,
    'parent',
  )}, ${pluralizeSessions(item.childCount, 'child')}`;
}

/**
 * Aggregates real API sessions into the four Dashboard summary categories plus
 * `unknownCount` for unrecognized statuses, with `total` equal to all sessions.
 * Each session is counted once, by its own status, as a parent (root) or a child.
 */
export function computeDistributionSummary(
  sessions: SessionSummary[],
): DashboardDistributionSummary {
  const emptyCounts = () => ({ parents: 0, children: 0 });
  const counts: Record<
    DashboardDistributionCategory,
    { parents: number; children: number }
  > = {
    'need-input': emptyCounts(),
    running: emptyCounts(),
    'done/idle': emptyCounts(),
    error: emptyCounts(),
  };
  let unknownCount = 0;

  for (const session of sessions) {
    const category = mapSessionStatusToCategory(session.status);
    if (category === null) {
      unknownCount += 1;
    } else if (isChildSession(session)) {
      counts[category].children += 1;
    } else {
      counts[category].parents += 1;
    }
  }

  const labels: Array<[DashboardDistributionCategory, string]> = [
    ['need-input', 'Need input'],
    ['running', 'Running'],
    ['done/idle', 'Done/idle'],
    ['error', 'Error'],
  ];
  const categories: DistributionCategoryItem[] = labels.map(
    ([category, label]) => ({
      category,
      label,
      count: counts[category].parents + counts[category].children,
      parentCount: counts[category].parents,
      childCount: counts[category].children,
    }),
  );

  return {
    total: sessions.length,
    unknownCount,
    categories,
  };
}

/**
 * Formats a display title for a session without exposing its technical ID.
 */
export function formatSessionTitle(session: SessionSummary): string {
  return (
    session.name.trim() ||
    session.task.trim() ||
    session.childAlias?.trim() ||
    'Untitled session'
  );
}

/**
 * Formats raw API status strings into concise readable chip labels.
 */
export function formatSessionStatusLabel(status: string): string {
  switch (status) {
    case 'needs_input':
      return 'Needs input';
    case 'working':
      return 'Working';
    case 'starting':
      return 'Starting';
    case 'idle':
      return 'Idle';
    case 'done':
      return 'Done';
    case 'error':
      return 'Error';
    case 'disconnected':
      return 'Disconnected';
    default:
      return status;
  }
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

export interface DashboardPartitionedSessions {
  needsInput: SessionSummary[];
  otherSessions: SessionSummary[];
  childrenByParentId: Map<string, SessionSummary[]>;
  parentTitleById: Map<string, string>;
}

/**
 * Splits sorted sessions into `needsInput` (always surfaced) and top-level
 * `otherSessions` (children whose parent exists in the snapshot are grouped
 * under their parent instead of duplicated as top-level cards).
 */
export function partitionDashboardSessions(
  sessions: SessionSummary[],
): DashboardPartitionedSessions {
  const sorted = sortDashboardSessions(sessions);
  const sessionIds = new Set(sorted.map(session => session.id));
  const childrenByParentId = new Map<string, SessionSummary[]>();
  const parentTitleById = new Map<string, string>();

  for (const session of sorted) {
    parentTitleById.set(session.id, formatSessionTitle(session));
    const parentId = session.parentSessionId?.trim();
    if (parentId && parentId !== session.id && sessionIds.has(parentId)) {
      const existing = childrenByParentId.get(parentId);
      if (existing) {
        existing.push(session);
      } else {
        childrenByParentId.set(parentId, [session]);
      }
    }
  }

  const needsInput: SessionSummary[] = [];
  const otherSessions: SessionSummary[] = [];
  for (const session of sorted) {
    if (session.status === 'needs_input') {
      needsInput.push(session);
      continue;
    }
    const parentId = session.parentSessionId?.trim();
    const hasParentInSnapshot = Boolean(
      parentId && parentId !== session.id && sessionIds.has(parentId),
    );
    if (!hasParentInSnapshot) {
      otherSessions.push(session);
    }
  }

  return {
    needsInput,
    otherSessions,
    childrenByParentId,
    parentTitleById,
  };
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
