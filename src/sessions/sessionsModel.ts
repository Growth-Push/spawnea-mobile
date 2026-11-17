import type { SessionSummary } from '../api/types';
import {
  DashboardDistributionCategory,
  formatSessionStatusLabel,
  formatSessionTitle,
  mapSessionStatusToCategory,
  sortDashboardSessions,
} from '../dashboard/dashboardModel';

export type SessionFilterKey = 'all' | DashboardDistributionCategory;

export interface SessionFilterOption {
  key: SessionFilterKey;
  label: string;
}

export const SESSION_FILTER_OPTIONS: readonly SessionFilterOption[] = [
  { key: 'all', label: 'All' },
  { key: 'need-input', label: 'Need input' },
  { key: 'running', label: 'Running' },
  { key: 'error', label: 'Error' },
  { key: 'done/idle', label: 'Done/idle' },
];

export interface SessionsHeaderSummary {
  sessionCount: number;
  hostCount: number;
  needsInputCount: number;
}

export interface SessionsListTree {
  totalLoadedCount: number;
  filteredCount: number;
  rootSessions: SessionSummary[];
  childrenByParentId: Map<string, SessionSummary[]>;
  parentTitleById: Map<string, string>;
  needsInputParentIds: Set<string>;
  needsInputDescendantCounts: Map<string, number>;
}

export interface ChildrenToggleLabels {
  visibleLabel: string;
  accessibilityLabel: string;
}

/**
 * Formats the visible chip label and accessibility label for a parent/ancestor
 * session's children toggle, including descendant `needs_input` attention text
 * whenever the branch is collapsed so status is never conveyed by color alone.
 */
export function formatChildrenToggleLabels(
  childCount: number,
  isExpanded: boolean,
  needsInputDescendantCount: number,
): ChildrenToggleLabels {
  const countLabel = `${childCount} ${childCount === 1 ? 'child' : 'children'}`;
  const actionLabel = `${isExpanded ? 'Collapse' : 'Expand'} child sessions`;

  if (!isExpanded && needsInputDescendantCount > 0) {
    const attentionLabel = `${needsInputDescendantCount} need input`;
    return {
      visibleLabel: `${countLabel} · ${attentionLabel}`,
      accessibilityLabel: `${countLabel}, ${attentionLabel}. ${actionLabel}`,
    };
  }

  return {
    visibleLabel: countLabel,
    accessibilityLabel: `${countLabel}. ${actionLabel}`,
  };
}

function parseActivityTimestampMs(session: SessionSummary): number {
  const activityMs = Date.parse(session.lastActivityAt);
  if (Number.isFinite(activityMs)) {
    return activityMs;
  }
  const createdMs = Date.parse(session.createdAt);
  return Number.isFinite(createdMs) ? createdMs : 0;
}

/**
 * Deduplicates sessions by `id`, retaining the entry with the most recent
 * activity timestamp if the API returns duplicate records.
 */
export function deduplicateSessionsById(
  sessions: SessionSummary[],
): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const session of sessions) {
    const existing = byId.get(session.id);
    if (!existing) {
      byId.set(session.id, session);
      continue;
    }
    if (
      parseActivityTimestampMs(session) > parseActivityTimestampMs(existing)
    ) {
      byId.set(session.id, session);
    }
  }
  return Array.from(byId.values());
}

/**
 * Computes deduplicated session, distinct host, and pending `needs_input` counts
 * for the Sessions header.
 */
export function computeSessionsHeaderSummary(
  sessions: SessionSummary[],
): SessionsHeaderSummary {
  const deduped = deduplicateSessionsById(sessions);
  const hosts = new Set<string>();
  let needsInputCount = 0;

  for (const session of deduped) {
    const hostKey = session.host.id.trim() || session.host.name.trim();
    if (hostKey) {
      hosts.add(hostKey);
    }
    if (session.status === 'needs_input') {
      needsInputCount += 1;
    }
  }

  return {
    sessionCount: deduped.length,
    hostCount: hosts.size,
    needsInputCount,
  };
}

/**
 * Filters a deduplicated session list using the Dashboard status category
 * mapping. Unknown statuses appear only under `all`.
 */
export function filterSessionsByCategory(
  sessions: SessionSummary[],
  filter: SessionFilterKey,
): SessionSummary[] {
  if (filter === 'all') {
    return sessions;
  }
  return sessions.filter(
    session => mapSessionStatusToCategory(session.status) === filter,
  );
}

/**
 * Builds the parent -> children tree for the Sessions screen:
 * - Deduplicates sessions by `id` so each session appears at most once.
 * - Filters by category (unknown statuses appear only in `all`).
 * - Groups children under their parent when the parent is present in the
 *   filtered set; children whose parent is absent or filtered out become roots.
 * - Breaks any cyclic `parentSessionId` links deterministically so no session
 *   is dropped.
 * - Prioritizes `needs_input` roots and roots with `needs_input` descendants.
 */
export function buildSessionsListTree(
  sessions: SessionSummary[],
  filter: SessionFilterKey,
): SessionsListTree {
  const deduped = deduplicateSessionsById(sessions);
  const parentTitleById = new Map<string, string>();
  for (const session of deduped) {
    parentTitleById.set(session.id, formatSessionTitle(session));
  }

  const filtered = filterSessionsByCategory(deduped, filter);
  const sorted = sortDashboardSessions(filtered);
  const visibleIds = new Set(sorted.map(session => session.id));
  const orderIndex = new Map<string, number>();
  sorted.forEach((session, idx) => {
    orderIndex.set(session.id, idx);
  });

  const parentOf = new Map<string, string>();
  for (const session of sorted) {
    const parentId = session.parentSessionId?.trim();
    if (parentId && parentId !== session.id && visibleIds.has(parentId)) {
      parentOf.set(session.id, parentId);
    }
  }

  // Break any cycle deterministically at its highest-priority (lowest index) member.
  for (const session of sorted) {
    const path: string[] = [];
    const seen = new Set<string>();
    let curr: string | undefined = session.id;
    while (curr !== undefined && !seen.has(curr)) {
      seen.add(curr);
      path.push(curr);
      curr = parentOf.get(curr);
    }
    if (curr !== undefined) {
      const cycleStart = path.indexOf(curr);
      const cycleNodes = path.slice(cycleStart);
      let rootCandidate = cycleNodes[0];
      let bestOrder = orderIndex.get(rootCandidate) ?? Number.MAX_SAFE_INTEGER;
      for (let i = 1; i < cycleNodes.length; i += 1) {
        const node = cycleNodes[i];
        const ord = orderIndex.get(node) ?? Number.MAX_SAFE_INTEGER;
        if (ord < bestOrder) {
          bestOrder = ord;
          rootCandidate = node;
        }
      }
      parentOf.delete(rootCandidate);
    }
  }

  const childrenByParentId = new Map<string, SessionSummary[]>();
  const rawRoots: SessionSummary[] = [];
  for (const session of sorted) {
    const parentId = parentOf.get(session.id);
    if (parentId) {
      const existing = childrenByParentId.get(parentId);
      if (existing) {
        existing.push(session);
      } else {
        childrenByParentId.set(parentId, [session]);
      }
    } else {
      rawRoots.push(session);
    }
  }

  const needsInputParentIds = new Set<string>();
  const needsInputDescendantCounts = new Map<string, number>();
  const countNeedsInputDescendants = (
    parentId: string,
    visited: Set<string>,
  ): number => {
    if (visited.has(parentId)) {
      return 0;
    }
    visited.add(parentId);
    const children = childrenByParentId.get(parentId);
    if (!children || children.length === 0) {
      return 0;
    }
    let count = 0;
    for (const child of children) {
      const descendantCount = countNeedsInputDescendants(child.id, visited);
      count += descendantCount + (child.status === 'needs_input' ? 1 : 0);
    }
    if (count > 0) {
      needsInputParentIds.add(parentId);
      needsInputDescendantCounts.set(parentId, count);
    }
    return count;
  };

  for (const root of rawRoots) {
    countNeedsInputDescendants(root.id, new Set<string>());
  }

  const rootPriority = (session: SessionSummary): number => {
    if (session.status === 'needs_input') {
      return 0;
    }
    if (needsInputParentIds.has(session.id)) {
      return 1;
    }
    return 2;
  };

  const rootSessions = [...rawRoots].sort((a, b) => {
    const tierDelta = rootPriority(a) - rootPriority(b);
    if (tierDelta !== 0) {
      return tierDelta;
    }
    const timeDelta = parseActivityTimestampMs(b) - parseActivityTimestampMs(a);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return a.id.localeCompare(b.id);
  });

  return {
    totalLoadedCount: deduped.length,
    filteredCount: sorted.length,
    rootSessions,
    childrenByParentId,
    parentTitleById,
    needsInputParentIds,
    needsInputDescendantCounts,
  };
}

/**
 * Formats an ISO timestamp into a compact relative activity label.
 */
export function formatRelativeActivity(
  isoTimestamp: string,
  nowMs: number,
): string {
  const ts = Date.parse(isoTimestamp);
  if (!Number.isFinite(ts)) {
    return 'Unknown';
  }
  const diffMs = Math.max(0, nowMs - ts);
  if (diffMs < 60_000) {
    return 'Just now';
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)}m ago`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)}h ago`;
  }
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

/**
 * Returns the real host display name from the API without adding or inferring
 * Local/SSH labels.
 */
export function formatHostName(session: SessionSummary): string {
  return session.host.name.trim() || session.host.id;
}

export function formatProjectName(session: SessionSummary): string {
  return session.project.name.trim() || session.project.id;
}

export function formatHarnessName(session: SessionSummary): string {
  return (
    session.harness.name.trim() ||
    session.harness.command.trim() ||
    session.harness.id
  );
}

/**
 * Explicit, tested mapping of known model IDs to readable names. Anything else is
 * shown as its (already sanitized) ID: no commercial name is ever guessed.
 */
export const KNOWN_MODEL_LABELS: Readonly<Record<string, string>> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-fable-5-2': 'Fable 5.2',
};

export function formatRequestedModelLabel(modelId: string): string {
  return KNOWN_MODEL_LABELS[modelId.trim().toLowerCase()] ?? modelId;
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Harness API names often end with the host in parentheses ("Claude (Local · Arch)").
 * The host is shown separately, so that repeated suffix is dropped; a different
 * parenthetical is kept, and so is the full name if nothing would remain.
 */
export function stripRepeatedHost(harnessName: string, hostLabels: string[]): string {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(harnessName);
  if (!match || !match[1].trim()) {
    return harnessName;
  }
  const inner = normalizeForCompare(match[2]);
  const repeated = hostLabels
    .map(normalizeForCompare)
    .filter(Boolean)
    .some(host => host === inner || host.includes(inner) || inner.includes(host));
  return repeated ? match[1].trim() : harnessName;
}

export interface HarnessIdentity {
  /** Harness name without a repeated host. */
  harness: string;
  /** Readable model label, or null when the session has no recorded model. */
  model: string | null;
  /** Visible text: "Claude · Opus 5.5" or just "Claude". */
  label: string;
  accessibilityLabel: string;
}

export function formatHarnessIdentity(session: SessionSummary): HarnessIdentity {
  const full = formatHarnessName(session);
  const harness = stripRepeatedHost(full, [
    session.host.name,
    session.host.id,
  ]);
  const modelId =
    typeof session.requestedModel === 'string'
      ? session.requestedModel.trim()
      : '';
  const model = modelId ? formatRequestedModelLabel(modelId) : null;
  return {
    harness,
    model,
    label: model ? `${harness} · ${model}` : harness,
    accessibilityLabel: model
      ? `Harness: ${harness}, requested model ${model}`
      : `Harness: ${harness}`,
  };
}

export { formatSessionStatusLabel, formatSessionTitle };
