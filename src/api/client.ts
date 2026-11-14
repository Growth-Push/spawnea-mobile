import { NativeModules } from 'react-native';
import { isDebugLoopbackAllowed } from '../config/runtime';
import {
  canonicalServerOrigin,
  validateServerUrl,
} from '../config/validation';
import type {
  ApiErrorCategory,
  ApiResult,
  SendMessageRequest,
  SendMessageResponse,
  SessionDetailResponse,
  SessionHistoryItem,
  SessionHistoryResponse,
  SessionOutputResponse,
  SessionsListResponse,
  SessionSummary,
} from './types';

export interface HttpTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpTransportResponse {
  status: number;
  retryAfter: string | null;
  body: string;
}

export interface HttpTransport {
  request(req: HttpTransportRequest): Promise<HttpTransportResponse>;
}

export interface ApiClientConfig {
  serverUrl: string;
  apiKey: string;
}

export interface RequestBehaviorOptions {
  isPolling?: boolean;
  timeoutMs?: number;
}

export interface SpawneaApiClientOptions {
  transport?: HttpTransport;
  allowDebugLoopback?: boolean;
  defaultTimeoutMs?: number;
  now?: () => number;
}

interface NativeSpawneaHttpModule {
  request(options: HttpTransportRequest): Promise<HttpTransportResponse>;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const MAX_MESSAGE_CHARS = 32000;
const MAX_CLIENT_REQUEST_ID_CHARS = 128;

/**
 * Default Android transport backed by native `SpawneaHttpModule` (OkHttp).
 *
 * Security mechanism (CDP/Inspector Bearer key protection):
 * React Native's built-in `fetch()` / `XMLHttpRequest` routes through
 * `NetworkingModule.kt`, which forwards all request headers—including
 * `Authorization: Bearer <key>`—unredacted to `NetworkEventUtil.onCreateRequest`
 * and `InspectorNetworkReporter` for DevTools/CDP in debug builds.
 * By dispatching directly through `NativeModules.SpawneaHttp` (OkHttp without
 * `NetworkEventUtil` or `InspectorNetworkReporter`) and refusing to fall back
 * to `fetch`/`XMLHttpRequest`, the Bearer key is never exposed to RN network
 * inspection in debug builds. `SpawneaHttpTransport` also enforces single-shot
 * non-GET bodies (`isOneShot = true`) and disables redirects and retries.
 */
export function createNativeHttpTransport(): HttpTransport {
  return {
    async request(req: HttpTransportRequest): Promise<HttpTransportResponse> {
      const nativeModule = (
        NativeModules as { SpawneaHttp?: NativeSpawneaHttpModule }
      ).SpawneaHttp;
      if (!nativeModule || typeof nativeModule.request !== 'function') {
        const error = new Error('Native HTTP transport unavailable');
        (error as { code?: string }).code = 'E_TRANSPORT_UNAVAILABLE';
        throw error;
      }
      return nativeModule.request(req);
    },
  };
}

/**
 * Parses an HTTP `Retry-After` header (integer seconds or HTTP-date) into
 * non-negative whole seconds relative to `nowMs`.
 */
export function parseRetryAfterSeconds(
  retryAfterHeader: string | null | undefined,
  nowMs: number,
): number | null {
  if (!retryAfterHeader) {
    return null;
  }
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs)) {
    return null;
  }
  const deltaSeconds = Math.ceil((targetMs - nowMs) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : 0;
}

function mapTransportError(error: unknown): ApiErrorCategory {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  switch (code) {
    case 'E_TIMEOUT':
    case 'E_BODY_READ_TIMEOUT':
      return 'timeout';
    case 'E_TLS_ERROR':
      return 'tls_error';
    case 'E_INVALID_URL':
    case 'E_CLEARTEXT_NOT_ALLOWED':
      return 'invalid_url';
    case 'E_INVALID_REQUEST':
    case 'E_PAYLOAD_TOO_LARGE':
    case 'E_INVALID_METHOD':
      return 'invalid_request';
    case 'E_RESPONSE_TOO_LARGE':
      return 'malformed_response';
    default:
      return 'network_error';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isNullableOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isValidIdNameRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.name === 'string'
  );
}

function isValidHarnessRef(value: unknown): boolean {
  return (
    isValidIdNameRef(value) &&
    isRecord(value) &&
    typeof value.command === 'string'
  );
}

function isValidWorktreeRef(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return isRecord(value) && isNullableOptionalString(value.branch);
}

export function isValidSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.name === 'string' &&
    isNullableOptionalString(value.parentSessionId) &&
    isNullableOptionalString(value.childAlias) &&
    typeof value.task === 'string' &&
    isValidIdNameRef(value.host) &&
    isValidIdNameRef(value.project) &&
    isValidHarnessRef(value.harness) &&
    isValidWorktreeRef(value.worktree) &&
    isNonEmptyString(value.status) &&
    typeof value.active === 'boolean' &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.lastActivityAt)
  );
}

/**
 * Normalizes a validated SessionSummary and discards host filesystem fields
 * such as `worktree.path` so local/remote paths are never retained in memory.
 */
export function sanitizeSessionSummary(session: SessionSummary): SessionSummary {
  let sanitizedWorktree: SessionSummary['worktree'];
  if (session.worktree === null) {
    sanitizedWorktree = null;
  } else if (session.worktree !== undefined) {
    sanitizedWorktree =
      session.worktree.branch !== undefined
        ? { branch: session.worktree.branch }
        : {};
  }

  return {
    id: session.id,
    name: session.name,
    ...(session.parentSessionId !== undefined
      ? { parentSessionId: session.parentSessionId }
      : {}),
    ...(session.childAlias !== undefined
      ? { childAlias: session.childAlias }
      : {}),
    task: session.task,
    host: { id: session.host.id, name: session.host.name },
    project: { id: session.project.id, name: session.project.name },
    harness: {
      id: session.harness.id,
      name: session.harness.name,
      command: session.harness.command,
    },
    ...(sanitizedWorktree !== undefined ? { worktree: sanitizedWorktree } : {}),
    status: session.status,
    active: session.active,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
  };
}

function isValidHistoryItem(value: unknown): value is SessionHistoryItem {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.role) &&
    typeof value.text === 'string' &&
    isNonEmptyString(value.source) &&
    isOptionalString(value.timestamp) &&
    isOptionalString(value.turnId) &&
    (value.textTruncated === undefined ||
      typeof value.textTruncated === 'boolean')
  );
}

export function isValidSessionsListResponse(
  payload: unknown,
): payload is SessionsListResponse {
  return (
    isRecord(payload) &&
    payload.apiVersion === 'v1' &&
    Array.isArray(payload.sessions) &&
    payload.sessions.every(isValidSessionSummary)
  );
}

export function isValidSessionDetailResponse(
  payload: unknown,
): payload is SessionDetailResponse {
  return (
    isRecord(payload) &&
    payload.apiVersion === 'v1' &&
    isValidSessionSummary(payload.session)
  );
}

export function isValidSessionOutputResponse(
  payload: unknown,
): payload is SessionOutputResponse {
  if (
    !isRecord(payload) ||
    payload.apiVersion !== 'v1' ||
    !isNonEmptyString(payload.sessionId) ||
    typeof payload.available !== 'boolean' ||
    !isOptionalString(payload.message)
  ) {
    return false;
  }
  if (payload.available) {
    return payload.status === 'live' && typeof payload.output === 'string';
  }
  return payload.status === 'unavailable' && payload.output === null;
}

export function isValidSessionHistoryResponse(
  payload: unknown,
): payload is SessionHistoryResponse {
  return (
    isRecord(payload) &&
    payload.apiVersion === 'v1' &&
    isNonEmptyString(payload.sessionId) &&
    typeof payload.available === 'boolean' &&
    (payload.source === 'transcript' || payload.source === 'screen') &&
    Array.isArray(payload.items) &&
    payload.items.every(isValidHistoryItem) &&
    isOptionalString(payload.cursor) &&
    (payload.hasMore === undefined || typeof payload.hasMore === 'boolean') &&
    isOptionalString(payload.message)
  );
}

export function isValidSendMessageResponse(
  payload: unknown,
): payload is SendMessageResponse {
  return (
    isRecord(payload) &&
    payload.apiVersion === 'v1' &&
    isNonEmptyString(payload.sessionId) &&
    typeof payload.delivered === 'boolean' &&
    isNonEmptyString(payload.deliveryMethod) &&
    isNonEmptyString(payload.status) &&
    isOptionalString(payload.turnId) &&
    (payload.replayed === undefined || typeof payload.replayed === 'boolean') &&
    isOptionalString(payload.message)
  );
}

function parseJsonSafe(rawBody: string): unknown | null {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Non-reversible in-memory credential fingerprint (FNV-1a 64-bit split) so
 * generation comparisons never retain a duplicate copy of the secret key.
 */
function credentialFingerprint(serverUrl: string, apiKey: string): string {
  const input = `${serverUrl}\u0000${apiKey}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    // Non-cryptographic FNV-1a 64-bit split hash requires 32-bit unsigned bitwise operations.
    // eslint-disable-next-line no-bitwise
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    // eslint-disable-next-line no-bitwise
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}:${h2.toString(16)}`;
}

export class SpawneaApiClient {
  private readonly transport: HttpTransport;
  private readonly allowDebugLoopback: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  private credentialGeneration = 0;
  private requestSequence = 0;
  private latestUnauthorizedRequestSeq = 0;
  private pausedForAuthGeneration: number | null = null;
  private pausedCredentialFingerprint: string | null = null;
  private readonly rateLimitedUntilByOrigin = new Map<string, number>();
  private lastRequestOrigin: string | null = null;

  constructor(options: SpawneaApiClientOptions = {}) {
    this.transport = options.transport ?? createNativeHttpTransport();
    this.allowDebugLoopback =
      options.allowDebugLoopback ?? isDebugLoopbackAllowed();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  isPollingPausedForAuth(): boolean {
    return this.pausedForAuthGeneration === this.credentialGeneration;
  }

  getCredentialGeneration(): number {
    return this.credentialGeneration;
  }

  getRateLimitRemainingSeconds(serverUrl?: string): number {
    const origin = serverUrl
      ? canonicalServerOrigin(serverUrl)
      : this.lastRequestOrigin;
    if (!origin) {
      return 0;
    }
    const untilMs = this.rateLimitedUntilByOrigin.get(origin) ?? 0;
    const remainingMs = untilMs - this.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  /**
   * Advances credential generation after committed settings changes or deletion,
   * clearing any prior generation's 401 polling pause.
   */
  notifyCredentialsChanged(): void {
    this.credentialGeneration += 1;
    this.pausedForAuthGeneration = null;
    this.pausedCredentialFingerprint = null;
    this.latestUnauthorizedRequestSeq = this.requestSequence;
  }

  async testConnection(
    config: ApiClientConfig,
  ): Promise<ApiResult<SessionsListResponse>> {
    return this.listSessions(config, { isPolling: false });
  }

  async listSessions(
    config: ApiClientConfig,
    behavior: RequestBehaviorOptions = {},
  ): Promise<ApiResult<SessionsListResponse>> {
    return this.executeJsonRequest(
      config,
      'GET',
      '/api/v1/sessions',
      undefined,
      behavior,
      isValidSessionsListResponse,
      payload => ({
        apiVersion: payload.apiVersion,
        sessions: payload.sessions.map(sanitizeSessionSummary),
      }),
    );
  }

  async getSessionDetail(
    config: ApiClientConfig,
    sessionId: string,
    behavior: RequestBehaviorOptions = {},
  ): Promise<ApiResult<SessionDetailResponse>> {
    const encodedId = encodeURIComponent(sessionId);
    return this.executeJsonRequest(
      config,
      'GET',
      `/api/v1/sessions/${encodedId}`,
      undefined,
      behavior,
      (payload): payload is SessionDetailResponse =>
        isValidSessionDetailResponse(payload) && payload.session.id === sessionId,
      payload => ({
        apiVersion: payload.apiVersion,
        session: sanitizeSessionSummary(payload.session),
      }),
    );
  }

  async getSessionOutput(
    config: ApiClientConfig,
    sessionId: string,
    lines = 200,
    behavior: RequestBehaviorOptions = {},
  ): Promise<ApiResult<SessionOutputResponse>> {
    const encodedId = encodeURIComponent(sessionId);
    const clampedLines = Math.max(1, Math.min(2000, Math.floor(lines)));
    return this.executeJsonRequest(
      config,
      'GET',
      `/api/v1/sessions/${encodedId}/output?lines=${clampedLines}`,
      undefined,
      behavior,
      (payload): payload is SessionOutputResponse =>
        isValidSessionOutputResponse(payload) && payload.sessionId === sessionId,
    );
  }

  async getSessionHistory(
    config: ApiClientConfig,
    sessionId: string,
    params: { limit?: number; cursor?: string } = {},
    behavior: RequestBehaviorOptions = {},
  ): Promise<ApiResult<SessionHistoryResponse>> {
    const encodedId = encodeURIComponent(sessionId);
    const queryParts: string[] = [];
    if (params.limit !== undefined) {
      const clampedLimit = Math.max(1, Math.min(50, Math.floor(params.limit)));
      queryParts.push(`limit=${clampedLimit}`);
    }
    if (params.cursor) {
      queryParts.push(`cursor=${encodeURIComponent(params.cursor)}`);
    }
    const querySuffix =
      queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

    return this.executeJsonRequest(
      config,
      'GET',
      `/api/v1/sessions/${encodedId}/history${querySuffix}`,
      undefined,
      behavior,
      (payload): payload is SessionHistoryResponse =>
        isValidSessionHistoryResponse(payload) &&
        payload.sessionId === sessionId,
    );
  }

  /**
   * Submits a prompt to a session. Enforces contract limits before dispatch and
   * never performs any automatic retry.
   */
  async sendMessage(
    config: ApiClientConfig,
    sessionId: string,
    body: SendMessageRequest,
    behavior: Omit<RequestBehaviorOptions, 'isPolling'> = {},
  ): Promise<ApiResult<SendMessageResponse>> {
    const trimmedMessage = body.message.trim();
    const trimmedRequestId = body.clientRequestId.trim();
    if (
      !trimmedMessage ||
      trimmedMessage.length > MAX_MESSAGE_CHARS ||
      !trimmedRequestId ||
      trimmedRequestId.length > MAX_CLIENT_REQUEST_ID_CHARS
    ) {
      return {
        ok: false,
        category: 'invalid_request',
        status: null,
        retryAfterSeconds: null,
      };
    }

    const serializedBody = JSON.stringify(body);
    if (utf8ByteLength(serializedBody) > MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        category: 'invalid_request',
        status: null,
        retryAfterSeconds: null,
      };
    }

    const encodedId = encodeURIComponent(sessionId);
    return this.executeJsonRequest(
      config,
      'POST',
      `/api/v1/sessions/${encodedId}/message`,
      serializedBody,
      { ...behavior, isPolling: false },
      (payload): payload is SendMessageResponse =>
        isValidSendMessageResponse(payload) && payload.sessionId === sessionId,
    );
  }

  private async executeJsonRequest<T>(
    config: ApiClientConfig,
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    behavior: RequestBehaviorOptions,
    validatePayload: (payload: unknown) => payload is T,
    sanitizePayload?: (payload: T) => T,
  ): Promise<ApiResult<T>> {
    const urlCheck = validateServerUrl(
      config.serverUrl,
      this.allowDebugLoopback,
    );
    if (!urlCheck.valid) {
      return {
        ok: false,
        category:
          urlCheck.reason === 'empty' ? 'incomplete_config' : 'invalid_url',
        status: null,
        retryAfterSeconds: null,
      };
    }

    const trimmedKey = config.apiKey.trim();
    if (!trimmedKey) {
      return {
        ok: false,
        category: 'incomplete_config',
        status: null,
        retryAfterSeconds: null,
      };
    }

    if (/[\r\n]/.test(trimmedKey)) {
      return {
        ok: false,
        category: 'invalid_request',
        status: null,
        retryAfterSeconds: null,
      };
    }

    const serverOrigin = canonicalServerOrigin(urlCheck.normalizedUrl);
    this.lastRequestOrigin = serverOrigin;
    const requestGeneration = this.credentialGeneration;
    const reqFingerprint = credentialFingerprint(
      urlCheck.normalizedUrl,
      trimmedKey,
    );

    if (
      behavior.isPolling &&
      this.pausedForAuthGeneration === this.credentialGeneration
    ) {
      return {
        ok: false,
        category: 'polling_paused_auth',
        status: 401,
        retryAfterSeconds: null,
      };
    }

    const currentNow = this.now();
    const rateLimitedUntilMs = this.rateLimitedUntilByOrigin.get(serverOrigin) ?? 0;
    if (currentNow < rateLimitedUntilMs) {
      return {
        ok: false,
        category: 'rate_limited',
        status: 429,
        retryAfterSeconds: Math.ceil(
          (rateLimitedUntilMs - currentNow) / 1000,
        ),
      };
    }
    if (rateLimitedUntilMs > 0) {
      this.rateLimitedUntilByOrigin.delete(serverOrigin);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${trimmedKey}`,
      Accept: 'application/json',
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    this.requestSequence += 1;
    const requestSeq = this.requestSequence;

    let response: HttpTransportResponse;
    try {
      // Single-shot transport invocation; POST requests must never be retried automatically.
      response = await this.transport.request({
        method,
        url: `${urlCheck.normalizedUrl}${path}`,
        headers,
        body,
        timeoutMs: behavior.timeoutMs ?? this.defaultTimeoutMs,
      });
    } catch (err) {
      return {
        ok: false,
        category: mapTransportError(err),
        status: null,
        retryAfterSeconds: null,
      };
    }

    if (response.status === 401) {
      if (requestGeneration === this.credentialGeneration) {
        this.pausedForAuthGeneration = requestGeneration;
        this.pausedCredentialFingerprint = reqFingerprint;
        if (this.requestSequence > this.latestUnauthorizedRequestSeq) {
          this.latestUnauthorizedRequestSeq = this.requestSequence;
        }
      }
      return {
        ok: false,
        category: 'unauthorized',
        status: 401,
        retryAfterSeconds: null,
      };
    }

    if (response.status === 429) {
      const responseNow = this.now();
      const retryAfterSeconds = parseRetryAfterSeconds(
        response.retryAfter,
        responseNow,
      );
      if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
        const existingUntil =
          this.rateLimitedUntilByOrigin.get(serverOrigin) ?? 0;
        const candidateUntil = responseNow + retryAfterSeconds * 1000;
        this.rateLimitedUntilByOrigin.set(
          serverOrigin,
          Math.max(existingUntil, candidateUntil),
        );
      }
      return {
        ok: false,
        category: 'rate_limited',
        status: 429,
        retryAfterSeconds,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        category: 'server_error',
        status: response.status,
        retryAfterSeconds: null,
      };
    }

    const parsed = parseJsonSafe(response.body);
    if (parsed === null || !validatePayload(parsed)) {
      return {
        ok: false,
        category: 'malformed_response',
        status: response.status,
        retryAfterSeconds: null,
      };
    }

    if (
      this.pausedForAuthGeneration === this.credentialGeneration &&
      requestGeneration === this.credentialGeneration &&
      requestSeq > this.latestUnauthorizedRequestSeq &&
      (this.pausedCredentialFingerprint === null ||
        this.pausedCredentialFingerprint === reqFingerprint)
    ) {
      this.pausedForAuthGeneration = null;
      this.pausedCredentialFingerprint = null;
    }

    return {
      ok: true,
      status: response.status,
      data: sanitizePayload ? sanitizePayload(parsed) : parsed,
    };
  }
}

export function formatApiErrorMessage(
  category: ApiErrorCategory,
  status: number | null,
  retryAfterSeconds: number | null,
): string {
  switch (category) {
    case 'incomplete_config':
      return 'Incomplete configuration. Enter both server URL and API key.';
    case 'invalid_url':
      return 'Invalid server URL. Check scheme, host, and port.';
    case 'invalid_request':
      return 'Request failed client validation limits or header rules.';
    case 'unauthorized':
      return 'Authentication rejected (HTTP 401). Replace the saved API key.';
    case 'polling_paused_auth':
      return 'Polling paused after HTTP 401 until credentials are updated.';
    case 'rate_limited':
      return retryAfterSeconds !== null
        ? `Rate limited by server (HTTP 429). Retry after ${retryAfterSeconds}s.`
        : 'Rate limited by server (HTTP 429). Wait before retrying.';
    case 'server_error':
      return status !== null
        ? `Server returned an error (HTTP ${status}).`
        : 'Server returned an unexpected error.';
    case 'malformed_response':
      return 'Server returned an unexpected response format.';
    case 'tls_error':
      return 'Secure TLS connection failed. Check that the server uses HTTPS with a valid certificate.';
    case 'timeout':
      return 'Connection timed out. Server is unreachable.';
    case 'network_error':
      return 'Server offline or unreachable.';
  }
}

export const defaultApiClient = new SpawneaApiClient();
