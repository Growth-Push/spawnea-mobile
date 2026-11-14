export interface SessionHostRef {
  id: string;
  name: string;
}

export interface SessionProjectRef {
  id: string;
  name: string;
}

export interface SessionHarnessRef {
  id: string;
  name: string;
  command: string;
}

export interface SessionWorktreeRef {
  branch?: string | null;
}

export interface SessionSummary {
  id: string;
  name: string;
  parentSessionId?: string | null;
  childAlias?: string | null;
  task: string;
  host: SessionHostRef;
  project: SessionProjectRef;
  harness: SessionHarnessRef;
  worktree?: SessionWorktreeRef | null;
  status: string;
  active: boolean;
  createdAt: string;
  lastActivityAt: string;
}

export interface SessionsListResponse {
  apiVersion: 'v1';
  sessions: SessionSummary[];
}

export interface SessionDetailResponse {
  apiVersion: 'v1';
  session: SessionSummary;
}

export interface SessionOutputResponse {
  apiVersion: 'v1';
  sessionId: string;
  available: boolean;
  status: 'live' | 'unavailable';
  output: string | null;
  message?: string;
}

export interface SessionHistoryItem {
  id: string;
  role: 'user' | 'agent' | string;
  text: string;
  source: string;
  timestamp?: string;
  turnId?: string;
  turnBoundary?: 'start' | 'end' | 'single' | string;
  textTruncated?: boolean;
}

export interface SessionHistoryResponse {
  apiVersion: 'v1';
  sessionId: string;
  available: boolean;
  source: 'transcript' | 'screen';
  items: SessionHistoryItem[];
  cursor?: string;
  hasMore?: boolean;
  message?: string;
}

export interface SendMessageRequest {
  message: string;
  clientRequestId: string;
}

export interface SendMessageResponse {
  apiVersion: 'v1';
  sessionId: string;
  delivered: boolean;
  deliveryMethod: string;
  status: string;
  turnId?: string;
  replayed?: boolean;
  message?: string;
}

export type ApiErrorCategory =
  | 'incomplete_config'
  | 'invalid_url'
  | 'invalid_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'server_error'
  | 'malformed_response'
  | 'tls_error'
  | 'network_error'
  | 'timeout'
  | 'polling_paused_auth';

export type ApiResult<T> =
  | {
      ok: true;
      status: number;
      data: T;
    }
  | {
      ok: false;
      category: ApiErrorCategory;
      status: number | null;
      retryAfterSeconds: number | null;
      errorCode?: string;
    };
