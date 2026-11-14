import { formatApiErrorMessage } from '../api/client';
import type {
  ApiErrorCategory,
  ApiResult,
  SendMessageResponse,
  SessionHistoryItem,
  SessionHistoryResponse,
  SessionSummary,
} from '../api/types';
import {
  DashboardErrorKind,
  DashboardRefreshError,
  formatSessionStatusLabel,
  mapApiFailureToDashboardError,
} from '../dashboard/dashboardModel';

export const MAX_CHAT_DRAFT_CHARS = 32000;
export const DEFAULT_CHAT_HISTORY_LIMIT = 20;
export const DEFAULT_CHAT_OUTPUT_LINES = 200;
export const DEFAULT_OUTPUT_PREVIEW_LINES = 12;

export const UNKNOWN_RETRY_GUIDANCE =
  'No automatic resend was performed. Retrying reuses the same request ID, which is deduplicated only while the desktop app stays running; a desktop restart loses that protection, so check the conversation before retrying or discarding.';

export interface SessionChatSnapshot {
  session: SessionSummary;
  historyAvailable: boolean;
  historySource: 'transcript' | 'screen';
  historyItems: SessionHistoryItem[];
  historyHasMore: boolean;
  historyMessage?: string;
  historyCursor?: string;
  outputAvailable: boolean;
  outputStatus: 'live' | 'unavailable';
  outputText: string | null;
  outputMessage?: string;
  lastFetchedAtMs: number;
  serverUrl: string;
  credentialGeneration: number;
}

export type SessionChatViewState =
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
      notFound?: boolean;
    }
  | {
      status: 'live';
      snapshot: SessionChatSnapshot;
    }
  | {
      status: 'stale';
      snapshot: SessionChatSnapshot;
      staleReason: string;
      errorKind: DashboardErrorKind | 'locked';
      retryAfterSeconds: number | null;
    };

export type ChatTurnSegment =
  | {
      kind: 'user';
      key: string;
      item: SessionHistoryItem;
      formattedTime: string | null;
    }
  | {
      kind: 'agent';
      key: string;
      item: SessionHistoryItem;
      formattedTime: string | null;
    }
  | {
      kind: 'tool_group';
      key: string;
      items: SessionHistoryItem[];
      hasTruncated: boolean;
      formattedTime: string | null;
    };

export interface ChatTurnGroup {
  key: string;
  turnId?: string;
  segments: ChatTurnSegment[];
}

export interface OutputTailSlice {
  visibleText: string;
  totalLines: number;
  hiddenAboveCount: number;
}

export type ComposerSubmissionStatus =
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'unknown';

export interface ComposerSubmission {
  status: ComposerSubmissionStatus;
  clientRequestId: string;
  submittedText: string;
  message: string;
  replayed?: boolean;
  serverStatus?: string;
  turnId?: string;
  httpStatus?: number | null;
  errorCode?: string;
  authRejected?: boolean;
  conflictDifferentPrompt?: boolean;
}

export interface SendGateResult {
  allowed: boolean;
  emptyDraft?: boolean;
  reason: string | null;
}

/**
 * Generates a unique client request ID for a single draft (<= 128 chars).
 */
export function createClientRequestId(nowMs = Date.now()): string {
  const timePart = Math.max(0, Math.floor(nowMs)).toString(36);
  const randA = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  const randB = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `mob-${timePart}-${randA}${randB}`;
}

/**
 * Formats an ISO timestamp string into local HH:MM if valid, or returns null.
 * Never fabricates a timestamp when the contract omits or invalidates it.
 */
export function formatItemTimestamp(timestamp?: string): string | null {
  if (!timestamp) {
    return null;
  }
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Formats a fetch epoch timestamp into local HH:MM:SS for freshness display.
 */
export function formatFetchTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return 'Unknown';
  }
  const date = new Date(timestampMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Merges incoming transcript items into an existing chronological list by item ID.
 * Existing items with matching IDs are updated in place (for example when a
 * subsequent forward poll replays an item with `turnBoundary: 'end'`).
 */
export function mergeTranscriptItems(
  existing: readonly SessionHistoryItem[],
  incoming: readonly SessionHistoryItem[],
): SessionHistoryItem[] {
  if (incoming.length === 0) {
    return [...existing];
  }
  const result = [...existing];
  const indexById = new Map<string, number>();
  result.forEach((item, index) => {
    indexById.set(item.id, index);
  });

  for (const item of incoming) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex !== undefined) {
      result[existingIndex] = item;
    } else {
      indexById.set(item.id, result.length);
      result.push(item);
    }
  }
  return result;
}

interface TranscriptCursorMeta {
  offset: number | null;
  file: string | null;
  head: string | null;
}

function parseTranscriptCursorMeta(cursor?: string): TranscriptCursorMeta {
  if (!cursor) {
    return { offset: null, file: null, head: null };
  }
  const trimmed = cursor.trim();
  const offsetMatch = /^offset:(\d+)(?::|$)/.exec(trimmed);
  const fileMatch = /(?:^|:)file:([^:]+)/.exec(trimmed);
  const headMatch = /(?:^|:)head:([^:]+)/.exec(trimmed);
  const offset = offsetMatch ? Number.parseInt(offsetMatch[1], 10) : null;
  return {
    offset: offset !== null && Number.isFinite(offset) && offset >= 0 ? offset : null,
    file: fileMatch?.[1]?.trim() || null,
    head: headMatch?.[1]?.trim() || null,
  };
}

/**
 * Detects when a transcript cursor indicates a stream reset/replacement rather
 * than a strictly forward continuation (file rotation, head fingerprint change,
 * backwards byte offset, or reset to offset 0).
 */
export function didTranscriptCursorReset(params: {
  prevCursor?: string;
  nextCursor?: string;
}): boolean {
  const { prevCursor, nextCursor } = params;
  if (!prevCursor || !nextCursor) {
    return false;
  }
  const prevMeta = parseTranscriptCursorMeta(prevCursor);
  const nextMeta = parseTranscriptCursorMeta(nextCursor);

  if (prevMeta.file && nextMeta.file && prevMeta.file !== nextMeta.file) {
    return true;
  }
  if (prevMeta.head && nextMeta.head && prevMeta.head !== nextMeta.head) {
    return true;
  }
  if (prevMeta.head !== null && nextMeta.head === null && nextMeta.offset === 0) {
    return true;
  }
  if (prevMeta.offset !== null && nextMeta.offset !== null) {
    if (nextMeta.offset < prevMeta.offset) {
      return true;
    }
    if (nextMeta.offset === 0 && prevCursor.trim() !== nextCursor.trim()) {
      return true;
    }
  }
  if (
    prevMeta.offset === null &&
    nextMeta.offset === 0 &&
    prevCursor.trim() !== nextCursor.trim()
  ) {
    return true;
  }
  return false;
}

/**
 * Applies a `/history` response on top of the previous chat snapshot according to
 * verified backend cursor semantics:
 * - `transcript` forward polls append/update deltas by stable item ID, unless
 *   the cursor resets (file/head change, backwards offset, or reset to 0),
 *   in which case the cached transcript history is replaced cleanly.
 * - `screen` forward polls return `items: []` with `hasMore: false` when the
 *   fingerprint is unchanged (keep existing screen items), or restart from line 0
 *   with the full updated snapshot when screen lines changed (replace items).
 * - Initial / non-cursor `recent_exchanges` polls replace the recent window.
 */
export function applyHistoryFetchResult(
  previous: SessionChatSnapshot | null,
  response: SessionHistoryResponse,
  usedCursor: boolean,
): {
  historyAvailable: boolean;
  historySource: 'transcript' | 'screen';
  historyItems: SessionHistoryItem[];
  historyHasMore: boolean;
  historyMessage?: string;
  historyCursor?: string;
} {
  if (!response.available) {
    return {
      historyAvailable: false,
      historySource: response.source,
      historyItems: [],
      historyHasMore: false,
      historyMessage: response.message,
      historyCursor: undefined,
    };
  }

  const sameLiveSource =
    previous !== null &&
    previous.historyAvailable &&
    previous.historySource === response.source;

  if (response.source === 'screen') {
    const cursorMatchesPrevious =
      Boolean(previous?.historyCursor) &&
      response.cursor !== undefined &&
      response.cursor === previous?.historyCursor &&
      response.cursor !== 'line:0';
    const screenUnchanged =
      usedCursor &&
      sameLiveSource &&
      cursorMatchesPrevious &&
      response.items.length === 0 &&
      !response.hasMore;
    return {
      historyAvailable: true,
      historySource: 'screen',
      historyItems: screenUnchanged ? [...previous.historyItems] : [...response.items],
      historyHasMore: Boolean(response.hasMore),
      historyMessage: response.message,
      historyCursor: response.cursor,
    };
  }

  const resetDetected =
    usedCursor &&
    sameLiveSource &&
    didTranscriptCursorReset({
      prevCursor: previous.historyCursor,
      nextCursor: response.cursor,
    });

  const nextItems =
    usedCursor && sameLiveSource && !resetDetected
      ? mergeTranscriptItems(previous.historyItems, response.items)
      : [...response.items];

  return {
    historyAvailable: true,
    historySource: 'transcript',
    historyItems: nextItems,
    historyHasMore:
      usedCursor && sameLiveSource && !resetDetected
        ? previous.historyHasMore || Boolean(response.hasMore)
        : Boolean(response.hasMore),
    historyMessage: response.message,
    historyCursor: response.cursor,
  };
}

/**
 * Groups history items by `turnId` (falling back to user-message boundaries when
 * `turnId` is absent, e.g. `source: 'screen'`) and collapses consecutive `tool`
 * activity items into toggleable `tool_group` segments.
 */
export function groupHistoryItemsByTurn(
  items: readonly SessionHistoryItem[],
): ChatTurnGroup[] {
  interface RawGroup {
    key: string;
    turnId?: string;
    items: SessionHistoryItem[];
  }

  const rawGroups: RawGroup[] = [];
  const groupByTurnId = new Map<string, RawGroup>();
  let currentUntaggedGroup: RawGroup | null = null;

  for (const item of items) {
    const turnId = item.turnId?.trim() || undefined;
    if (turnId) {
      currentUntaggedGroup = null;
      let group = groupByTurnId.get(turnId);
      if (!group) {
        group = {
          key: `turn-${turnId}`,
          turnId,
          items: [],
        };
        groupByTurnId.set(turnId, group);
        rawGroups.push(group);
      }
      group.items.push(item);
      continue;
    }

    if (item.role === 'user' || currentUntaggedGroup === null) {
      currentUntaggedGroup = {
        key: `seq-${item.id}`,
        items: [item],
      };
      rawGroups.push(currentUntaggedGroup);
    } else {
      currentUntaggedGroup.items.push(item);
    }
  }

  return rawGroups.map(group => {
    const segments: ChatTurnSegment[] = [];
    let pendingTools: SessionHistoryItem[] = [];

    const flushTools = () => {
      if (pendingTools.length === 0) {
        return;
      }
      const firstTool = pendingTools[0];
      segments.push({
        kind: 'tool_group',
        key: `${group.key}-tools-${firstTool.id}`,
        items: pendingTools,
        hasTruncated: pendingTools.some(t => Boolean(t.textTruncated)),
        formattedTime: formatItemTimestamp(firstTool.timestamp),
      });
      pendingTools = [];
    };

    for (const item of group.items) {
      if (item.role === 'tool') {
        pendingTools.push(item);
        continue;
      }
      flushTools();
      if (item.role === 'user') {
        segments.push({
          kind: 'user',
          key: `${group.key}-user-${item.id}`,
          item,
          formattedTime: formatItemTimestamp(item.timestamp),
        });
      } else {
        segments.push({
          kind: 'agent',
          key: `${group.key}-agent-${item.id}`,
          item,
          formattedTime: formatItemTimestamp(item.timestamp),
        });
      }
    }
    flushTools();

    return {
      key: group.key,
      ...(group.turnId ? { turnId: group.turnId } : {}),
      segments,
    };
  });
}

/**
 * Splits bounded terminal output text and slices the visible tail lines.
 */
export function sliceOutputTail(
  outputText: string | null,
  expanded: boolean,
  previewLines = DEFAULT_OUTPUT_PREVIEW_LINES,
): OutputTailSlice {
  if (!outputText) {
    return {
      visibleText: '',
      totalLines: 0,
      hiddenAboveCount: 0,
    };
  }
  const normalized = outputText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const totalLines = lines.length;
  if (expanded || totalLines <= previewLines) {
    return {
      visibleText: lines.join('\n'),
      totalLines,
      hiddenAboveCount: 0,
    };
  }
  const hiddenAboveCount = totalLines - previewLines;
  return {
    visibleText: lines.slice(-previewLines).join('\n'),
    totalLines,
    hiddenAboveCount,
  };
}

/**
 * Evaluates whether sending a follow-up prompt is currently allowed and provides
 * an explicit, user-facing block reason whenever disallowed.
 */
function checkBaseSendPreconditions(params: {
  isForeground: boolean;
  hasUnlockedCredential: boolean;
  isAuthPaused: boolean;
  session: SessionSummary | null;
}): SendGateResult | null {
  if (!params.isForeground) {
    return {
      allowed: false,
      reason: 'Sending is blocked while the app is not in the foreground.',
    };
  }

  if (!params.hasUnlockedCredential) {
    return {
      allowed: false,
      reason: 'Biometric unlock is required before sending messages.',
    };
  }

  if (params.isAuthPaused) {
    return {
      allowed: false,
      reason:
        'Authentication was rejected (HTTP 401). Replace the saved API key in Settings.',
    };
  }

  if (!params.session) {
    return {
      allowed: false,
      reason: 'Session details are not loaded yet.',
    };
  }

  return null;
}

/**
 * Evaluates whether a follow-up can be dispatched right now.
 * Normal sends require foreground focus, unlocked key, non-paused auth,
 * idle/needs_input session status, and no unresolved pending or unknown submission.
 */
export function evaluateSendGate(params: {
  isForeground: boolean;
  hasUnlockedCredential: boolean;
  isAuthPaused: boolean;
  session: SessionSummary | null;
  submissionStatus: ComposerSubmissionStatus | null;
  conflictDifferentPrompt?: boolean;
  draftText: string;
}): SendGateResult {
  const {
    isForeground,
    hasUnlockedCredential,
    isAuthPaused,
    session,
    submissionStatus,
    conflictDifferentPrompt = false,
    draftText,
  } = params;

  const baseFailure = checkBaseSendPreconditions({
    isForeground,
    hasUnlockedCredential,
    isAuthPaused,
    session,
  });
  if (baseFailure) {
    return baseFailure;
  }

  if (session && session.status !== 'idle' && session.status !== 'needs_input') {
    return {
      allowed: false,
      reason: `Sending is blocked while session is ${formatSessionStatusLabel(session.status)}. Wait for Idle or Needs input.`,
    };
  }

  if (submissionStatus === 'pending') {
    return {
      allowed: false,
      reason: 'Prompt submission is already in progress.',
    };
  }

  if (submissionStatus === 'unknown') {
    return {
      allowed: false,
      reason:
        'Resolve the uncertain delivery (Retry with same ID or Discard) before sending a new prompt.',
    };
  }

  if (submissionStatus === 'failed' && conflictDifferentPrompt) {
    return {
      allowed: false,
      reason: 'Edit the message or tap Discard to start with a new request ID.',
    };
  }

  const trimmed = draftText.trim();
  if (!trimmed) {
    return {
      allowed: false,
      emptyDraft: true,
      reason: null,
    };
  }

  if (trimmed.length > MAX_CHAT_DRAFT_CHARS) {
    return {
      allowed: false,
      reason: `Message exceeds the ${MAX_CHAT_DRAFT_CHARS.toLocaleString()} character limit.`,
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

/**
 * Evaluates whether a same-ID Retry action is allowed.
 * Unknown deliveries remain retryable while the session is working because
 * the server replays matching clientRequestId receipts before checking turn
 * readiness; normal failed sends still require Idle or Needs input.
 */
export function evaluateRetryGate(params: {
  submission: ComposerSubmission | null;
  isForeground: boolean;
  hasUnlockedCredential: boolean;
  isAuthPaused: boolean;
  session: SessionSummary | null;
}): SendGateResult {
  const {
    submission,
    isForeground,
    hasUnlockedCredential,
    isAuthPaused,
    session,
  } = params;

  if (
    !submission ||
    (submission.status !== 'unknown' && submission.status !== 'failed')
  ) {
    return {
      allowed: false,
      reason: null,
    };
  }

  if (submission.conflictDifferentPrompt) {
    return {
      allowed: false,
      reason: 'Edit the message or tap Discard to generate a new request ID.',
    };
  }

  const baseFailure = checkBaseSendPreconditions({
    isForeground,
    hasUnlockedCredential,
    isAuthPaused,
    session,
  });
  if (baseFailure) {
    return baseFailure;
  }

  const trimmed = submission.submittedText.trim();
  if (!trimmed) {
    return {
      allowed: false,
      emptyDraft: true,
      reason: null,
    };
  }

  if (trimmed.length > MAX_CHAT_DRAFT_CHARS) {
    return {
      allowed: false,
      reason: `Message exceeds the ${MAX_CHAT_DRAFT_CHARS.toLocaleString()} character limit.`,
    };
  }

  if (submission.status === 'unknown') {
    return {
      allowed: true,
      reason: null,
    };
  }

  if (session && session.status !== 'idle' && session.status !== 'needs_input') {
    return {
      allowed: false,
      reason: `Sending is blocked while session is ${formatSessionStatusLabel(session.status)}. Wait for Idle or Needs input.`,
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

export function mapSendResponseToSubmission(
  response: SendMessageResponse,
  clientRequestId: string,
  submittedText: string,
): ComposerSubmission {
  if (!response.delivered || response.status === 'unknown') {
    return {
      status: 'unknown',
      clientRequestId,
      submittedText,
      replayed: Boolean(response.replayed),
      serverStatus: response.status,
      turnId: response.turnId,
      message: `Delivery outcome is unknown (Enter confirmation could not be verified). ${UNKNOWN_RETRY_GUIDANCE}`,
    };
  }

  return {
    status: 'delivered',
    clientRequestId,
    submittedText,
    replayed: Boolean(response.replayed),
    serverStatus: response.status,
    turnId: response.turnId,
    message: response.replayed
      ? 'Delivered (replayed receipt — duplicate prevented). Delivery confirms acceptance, not turn completion.'
      : 'Delivered to session. Delivery confirms acceptance, not turn completion.',
  };
}

export function mapSendFailureToSubmission(
  failure: Extract<ApiResult<unknown>, { ok: false }>,
  clientRequestId: string,
  submittedText: string,
  options?: { preserveUnknown?: boolean },
): ComposerSubmission {
  const preserveUnknown = Boolean(options?.preserveUnknown);

  if (
    failure.category === 'timeout' ||
    failure.category === 'network_error' ||
    failure.category === 'tls_error' ||
    failure.category === 'malformed_response'
  ) {
    const baseMsg =
      failure.category === 'timeout'
        ? 'Request timed out before confirmation.'
        : failure.category === 'tls_error'
          ? 'Secure TLS connection failed before confirmation.'
          : failure.category === 'malformed_response'
            ? 'Server returned an unreadable confirmation receipt.'
            : 'Network connection was lost before confirmation.';
    return {
      status: 'unknown',
      clientRequestId,
      submittedText,
      httpStatus: failure.status,
      errorCode: failure.errorCode,
      message: `${baseMsg} Delivery outcome is unknown. ${UNKNOWN_RETRY_GUIDANCE}`,
    };
  }

  if (
    failure.category === 'unauthorized' ||
    failure.category === 'polling_paused_auth' ||
    failure.status === 401
  ) {
    if (preserveUnknown) {
      return {
        status: 'unknown',
        clientRequestId,
        submittedText,
        httpStatus: 401,
        errorCode: 'unauthorized',
        authRejected: true,
        message: `Authentication rejected (HTTP 401) while checking this unresolved submission. Delivery outcome remains unknown; update the API key in Settings before retrying or discarding. ${UNKNOWN_RETRY_GUIDANCE}`,
      };
    }
    return {
      status: 'failed',
      clientRequestId,
      submittedText,
      httpStatus: 401,
      errorCode: 'unauthorized',
      authRejected: true,
      message:
        'Authentication rejected (HTTP 401). Replace the saved API key in Settings.',
    };
  }

  if (failure.category === 'rate_limited' || failure.status === 429) {
    if (preserveUnknown) {
      return {
        status: 'unknown',
        clientRequestId,
        submittedText,
        httpStatus: 429,
        errorCode: 'rate_limited',
        message:
          failure.retryAfterSeconds !== null
            ? `Rate limited by server (HTTP 429) while checking this unresolved submission. Delivery outcome remains unknown; wait ${failure.retryAfterSeconds}s before manually retrying. ${UNKNOWN_RETRY_GUIDANCE}`
            : `Rate limited by server (HTTP 429) while checking this unresolved submission. Delivery outcome remains unknown; wait before manually retrying. ${UNKNOWN_RETRY_GUIDANCE}`,
      };
    }
    return {
      status: 'failed',
      clientRequestId,
      submittedText,
      httpStatus: 429,
      errorCode: 'rate_limited',
      message:
        failure.retryAfterSeconds !== null
          ? `Rate limited by server (HTTP 429). Wait ${failure.retryAfterSeconds}s before retrying.`
          : 'Rate limited by server (HTTP 429). Wait before retrying.',
    };
  }

  if (failure.status === 409) {
    const normalizedCode = (failure.errorCode ?? '').toLowerCase();
    const isDifferentPromptConflict =
      normalizedCode === 'request_id_conflict' ||
      normalizedCode === 'client_request_id_conflict' ||
      normalizedCode === 'idempotency_conflict';
    const isOpenTurnConflict =
      normalizedCode === 'open_turn_conflict' ||
      normalizedCode === 'open_turn';
    return {
      status: 'failed',
      clientRequestId,
      submittedText,
      httpStatus: 409,
      errorCode: failure.errorCode ?? 'conflict',
      conflictDifferentPrompt: isDifferentPromptConflict,
      message: isDifferentPromptConflict
        ? 'Conflict (HTTP 409): this request ID was already used with a different message. Edit the message or tap Discard to start with a new request ID.'
        : isOpenTurnConflict
          ? 'Conflict (HTTP 409): this session already has an open turn. Wait until it finishes or needs input, then retry.'
          : 'Conflict (HTTP 409): prompt could not be accepted in the current session state.',
    };
  }

  if (failure.status === 422 || failure.errorCode === 'needs_human') {
    return {
      status: 'failed',
      clientRequestId,
      submittedText,
      httpStatus: 422,
      errorCode: failure.errorCode ?? 'needs_human',
      message:
        'Rejected (HTTP 422): session is not ready or unavailable for prompt delivery.',
    };
  }

  if (failure.status === 404) {
    return {
      status: 'failed',
      clientRequestId,
      submittedText,
      httpStatus: 404,
      errorCode: failure.errorCode ?? 'not_found',
      message: 'Session not found (HTTP 404). It may have been removed.',
    };
  }

  if (
    failure.status === 400 ||
    (!preserveUnknown && failure.category === 'invalid_request')
  ) {
    return {
      status: 'failed',
      clientRequestId,
      submittedText,
      httpStatus: failure.status ?? 400,
      errorCode: failure.errorCode ?? 'invalid_request',
      message:
        'Invalid request (HTTP 400). Check that your message is non-empty and within 32,000 characters.',
    };
  }

  // HTTP 5xx, 408, or any other non-definitive response may have arrived after
  // dispatch reached the desktop server; require same-ID handling on retry.
  const detail = formatApiErrorMessage(
    failure.category,
    failure.status,
    failure.retryAfterSeconds,
  );
  return {
    status: 'unknown',
    clientRequestId,
    submittedText,
    httpStatus: failure.status,
    errorCode: failure.errorCode,
    message: `${detail} ${
      preserveUnknown
        ? 'Previous delivery outcome remains unknown.'
        : 'Delivery outcome is unknown because the request may have reached the server.'
    } ${UNKNOWN_RETRY_GUIDANCE}`,
  };
}

export function mapChatFailure(
  failure: Extract<ApiResult<unknown>, { ok: false }>,
): { error: DashboardRefreshError; notFound: boolean } {
  if (failure.status === 404) {
    return {
      notFound: true,
      error: {
        kind: 'server_error',
        category: failure.category,
        status: 404,
        retryAfterSeconds: null,
        message: 'Session not found (HTTP 404).',
      },
    };
  }
  return {
    notFound: false,
    error: mapApiFailureToDashboardError(failure),
  };
}

export function combineSyncFailures(
  failures: ReadonlyArray<Extract<ApiResult<unknown>, { ok: false }>>,
): Extract<ApiResult<unknown>, { ok: false }> {
  const priority: Record<ApiErrorCategory, number> = {
    unauthorized: 1,
    polling_paused_auth: 2,
    rate_limited: 3,
    incomplete_config: 4,
    invalid_url: 5,
    network_error: 6,
    timeout: 7,
    tls_error: 8,
    server_error: 9,
    malformed_response: 10,
    invalid_request: 11,
  };
  let best = failures[0];
  for (const candidate of failures.slice(1)) {
    if (candidate.status === 404 && best.status !== 404) {
      best = candidate;
      continue;
    }
    if (priority[candidate.category] < priority[best.category]) {
      best = candidate;
    } else if (
      candidate.category === 'rate_limited' &&
      best.category === 'rate_limited' &&
      (candidate.retryAfterSeconds ?? 0) > (best.retryAfterSeconds ?? 0)
    ) {
      best = candidate;
    }
  }
  return best;
}

export const CHAT_BOTTOM_PIN_THRESHOLD_PX = 48;

/**
 * Returns true when the scroll viewport is at or within `thresholdPx` of the
 * bottom of the scrollable content (or when the content fits without scrolling).
 */
export function isScrollNearBottom(metrics: {
  offsetY: number;
  viewportHeight: number;
  contentHeight: number;
  thresholdPx?: number;
}): boolean {
  const threshold = metrics.thresholdPx ?? CHAT_BOTTOM_PIN_THRESHOLD_PX;
  if (metrics.contentHeight <= metrics.viewportHeight + 1) {
    return true;
  }
  return (
    metrics.offsetY + metrics.viewportHeight >=
    metrics.contentHeight - threshold
  );
}

export interface UnresolvedSubmissionScopeKey {
  sessionId: string;
  serverUrl: string;
  credentialGeneration: number;
}

export interface UnresolvedSubmissionRecord {
  sessionId: string;
  serverUrl: string;
  credentialGeneration: number;
  submission: ComposerSubmission;
}

type UnresolvedSubmissionListener = (
  record: UnresolvedSubmissionRecord | null,
) => void;

interface ScopedUnresolvedState {
  records: Map<string, UnresolvedSubmissionRecord>;
  inFlightRequestIds: Map<string, string>;
  listeners: Map<string, Set<UnresolvedSubmissionListener>>;
}

const unresolvedSubmissionScopes = new WeakMap<object, ScopedUnresolvedState>();

function getOrCreateUnresolvedState(scope: object): ScopedUnresolvedState {
  let state = unresolvedSubmissionScopes.get(scope);
  if (!state) {
    state = {
      records: new Map(),
      inFlightRequestIds: new Map(),
      listeners: new Map(),
    };
    unresolvedSubmissionScopes.set(scope, state);
  }
  return state;
}

function buildUnresolvedScopeKey(key: UnresolvedSubmissionScopeKey): string {
  return `${key.credentialGeneration}\u0000${key.serverUrl}\u0000${key.sessionId}`;
}

function notifyUnresolvedListeners(
  state: ScopedUnresolvedState,
  storageKey: string,
  record: UnresolvedSubmissionRecord | null,
): void {
  const listeners = state.listeners.get(storageKey);
  if (!listeners || listeners.size === 0) {
    return;
  }
  for (const listener of Array.from(listeners)) {
    listener(record);
  }
}

/**
 * Stores a `pending` or `unknown` submission strictly in memory scoped to the
 * given credential cache, credential generation, server URL, and session ID.
 * Hiding or backgrounding the app clears visible UI state without discarding
 * this record so the same session can restore it on unlock.
 */
export function saveUnresolvedSubmission(
  scope: object,
  record: UnresolvedSubmissionRecord,
  options?: { silent?: boolean },
): void {
  if (
    record.submission.status !== 'pending' &&
    record.submission.status !== 'unknown'
  ) {
    return;
  }
  const state = getOrCreateUnresolvedState(scope);
  const storageKey = buildUnresolvedScopeKey(record);
  const nextRecord: UnresolvedSubmissionRecord = {
    ...record,
    submission: { ...record.submission },
  };
  state.records.set(storageKey, nextRecord);
  if (!options?.silent) {
    notifyUnresolvedListeners(state, storageKey, nextRecord);
  }
}

export function getUnresolvedSubmission(
  scope: object,
  key: UnresolvedSubmissionScopeKey,
): UnresolvedSubmissionRecord | null {
  const state = unresolvedSubmissionScopes.get(scope);
  if (!state) {
    return null;
  }
  const found = state.records.get(buildUnresolvedScopeKey(key));
  return found
    ? {
        ...found,
        submission: { ...found.submission },
      }
    : null;
}

export function clearUnresolvedSubmission(
  scope: object,
  key: UnresolvedSubmissionScopeKey,
  options?: { silent?: boolean },
): void {
  const state = unresolvedSubmissionScopes.get(scope);
  if (!state) {
    return;
  }
  const storageKey = buildUnresolvedScopeKey(key);
  const existed = state.records.delete(storageKey);
  if (existed && !options?.silent) {
    notifyUnresolvedListeners(state, storageKey, null);
  }
}

export function clearAllUnresolvedSubmissions(scope: object): void {
  const state = unresolvedSubmissionScopes.get(scope);
  if (!state) {
    return;
  }
  const keys = Array.from(state.records.keys());
  state.records.clear();
  state.inFlightRequestIds.clear();
  for (const storageKey of keys) {
    notifyUnresolvedListeners(state, storageKey, null);
  }
}

export function setUnresolvedSubmissionInFlight(
  scope: object,
  key: UnresolvedSubmissionScopeKey,
  clientRequestId: string | null,
): void {
  const state = getOrCreateUnresolvedState(scope);
  const storageKey = buildUnresolvedScopeKey(key);
  if (clientRequestId) {
    state.inFlightRequestIds.set(storageKey, clientRequestId);
  } else {
    state.inFlightRequestIds.delete(storageKey);
  }
}

export function getInFlightSubmissionRequestId(
  scope: object,
  key: UnresolvedSubmissionScopeKey,
): string | null {
  const state = unresolvedSubmissionScopes.get(scope);
  if (!state) {
    return null;
  }
  return state.inFlightRequestIds.get(buildUnresolvedScopeKey(key)) ?? null;
}

export function subscribeUnresolvedSubmission(
  scope: object,
  key: UnresolvedSubmissionScopeKey,
  listener: UnresolvedSubmissionListener,
): () => void {
  const state = getOrCreateUnresolvedState(scope);
  const storageKey = buildUnresolvedScopeKey(key);
  let set = state.listeners.get(storageKey);
  if (!set) {
    set = new Set();
    state.listeners.set(storageKey, set);
  }
  set.add(listener);
  return () => {
    const existing = state.listeners.get(storageKey);
    if (!existing) {
      return;
    }
    existing.delete(listener);
    if (existing.size === 0) {
      state.listeners.delete(storageKey);
    }
  };
}
