import { NativeModules } from 'react-native';
import {
  formatApiErrorMessage,
  HttpTransport,
  parseRetryAfterSeconds,
  SpawneaApiClient,
} from '../src/api/client';
import type { SessionSummary } from '../src/api/types';

export function makeSessionFixture(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: 'sess-123',
    name: 'Backend feature',
    parentSessionId: null,
    childAlias: null,
    task: 'Implement feature',
    host: { id: 'local', name: 'Local Workstation' },
    project: { id: 'proj-1', name: 'Spawnea' },
    harness: { id: 'local:codex', name: 'Codex', command: 'codex' },
    status: 'idle',
    active: true,
    createdAt: '2026-11-13T12:00:00.000Z',
    lastActivityAt: '2026-11-13T12:05:00.000Z',
    ...overrides,
  };
}

describe('SpawneaApiClient', () => {
  const validConfig = {
    serverUrl: 'https://workstation.tailnet.ts.net:5757',
    apiKey: 'dummy-bearer-key-must-never-leak',
  };

  afterEach(() => {
    delete (NativeModules as { SpawneaHttp?: unknown }).SpawneaHttp;
    jest.restoreAllMocks();
  });

  test('uses native SpawneaHttp transport and never calls fetch/XHR', async () => {
    const fetchSpy = jest.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const nativeRequest = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({
        apiVersion: 'v1',
        sessions: [makeSessionFixture()],
      }),
    });
    (NativeModules as { SpawneaHttp?: unknown }).SpawneaHttp = {
      request: nativeRequest,
    };

    try {
      const client = new SpawneaApiClient({ allowDebugLoopback: false });
      const res = await client.listSessions(validConfig);

      expect(res.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(nativeRequest).toHaveBeenCalledTimes(1);
      expect(nativeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://workstation.tailnet.ts.net:5757/api/v1/sessions',
          headers: expect.objectContaining({
            Authorization: `Bearer ${validConfig.apiKey}`,
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails closed without falling back to fetch if SpawneaHttp is missing', async () => {
    const fetchSpy = jest.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const client = new SpawneaApiClient({ allowDebugLoopback: false });
      const res = await client.listSessions(validConfig);

      expect(res).toEqual({
        ok: false,
        category: 'network_error',
        status: null,
        retryAfterSeconds: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('pauses polling per credential generation and does not leak stale 401 across generations', async () => {
    let resolveInFlight!: (val: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;
    const inFlightPromise = new Promise<{
      status: number;
      retryAfter: string | null;
      body: string;
    }>(resolve => {
      resolveInFlight = resolve;
    });

    const request = jest
      .fn()
      // 1. Gen 0 polling receives 401
      .mockResolvedValueOnce({
        status: 401,
        retryAfter: null,
        body: '',
      })
      // 2. Inline test with DIFFERENT key succeeds (should not unpause gen 0)
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      })
      // 3. Same credential validation (200) unpauses gen 0
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      })
      // 4. In-flight request during gen 0 that resolves late after credential change
      .mockReturnValueOnce(inFlightPromise)
      // 5. Gen 1 request succeeds
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });

    const first = await client.listSessions(validConfig, { isPolling: true });
    expect(first).toEqual({
      ok: false,
      category: 'unauthorized',
      status: 401,
      retryAfterSeconds: null,
    });
    expect(client.isPollingPausedForAuth()).toBe(true);

    const paused = await client.listSessions(validConfig, { isPolling: true });
    expect(paused.ok).toBe(false);
    if (!paused.ok) {
      expect(paused.category).toBe('polling_paused_auth');
    }
    expect(request).toHaveBeenCalledTimes(1);

    // Inline test with a different key should not clear pause on current saved generation
    const inlineOther = await client.testConnection({
      serverUrl: validConfig.serverUrl,
      apiKey: 'different-inline-key-value',
    });
    expect(inlineOther.ok).toBe(true);
    expect(client.isPollingPausedForAuth()).toBe(true);

    // Successful validation with the paused generation's own credentials clears pause
    const sameKeyRecovered = await client.testConnection(validConfig);
    expect(sameKeyRecovered.ok).toBe(true);
    expect(client.isPollingPausedForAuth()).toBe(false);

    // Start gen 0 request, then advance generation before it finishes with 401
    const staleGen0Promise = client.listSessions(validConfig, {
      isPolling: true,
    });
    client.notifyCredentialsChanged();
    expect(client.getCredentialGeneration()).toBe(1);
    resolveInFlight({ status: 401, retryAfter: null, body: '' });
    await staleGen0Promise;

    // Stale 401 from gen 0 must NOT pause gen 1 polling
    expect(client.isPollingPausedForAuth()).toBe(false);
    const gen1Res = await client.listSessions(validConfig, { isPolling: true });
    expect(gen1Res.ok).toBe(true);
  });

  test('only a 200 response from a request started AFTER the latest 401 clears polling pause', async () => {
    let resolveReq1!: (val: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;
    let resolveReq2!: (val: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;

    const request = jest
      .fn()
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveReq1 = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveReq2 = resolve;
        }),
      )
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });

    // Both requests start concurrently before any 401 has arrived.
    const req1Promise = client.listSessions(validConfig, { isPolling: true });
    const req2Promise = client.getSessionDetail(validConfig, 'sess-123');

    // Request 1 returns 401 first.
    resolveReq1({ status: 401, retryAfter: null, body: '' });
    await req1Promise;
    expect(client.isPollingPausedForAuth()).toBe(true);

    // Concurrent request 2 started BEFORE the 401, so its late 200 must NOT unpause polling.
    resolveReq2({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({ apiVersion: 'v1', session: makeSessionFixture() }),
    });
    const req2Res = await req2Promise;
    expect(req2Res.ok).toBe(true);
    expect(client.isPollingPausedForAuth()).toBe(true);

    // A fresh request started AFTER the latest 401 succeeds and clears the pause.
    const post401Res = await client.testConnection(validConfig);
    expect(post401Res.ok).toBe(true);
    expect(client.isPollingPausedForAuth()).toBe(false);
  });

  test('rejects well-formed detail, output, history, and message responses whose session id mismatches requested sessionId', async () => {
    const otherSession = makeSessionFixture({ id: 'sess-other' });
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', session: otherSession }),
      })
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-other',
          available: true,
          status: 'live',
          output: 'hello',
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-other',
          available: true,
          source: 'transcript',
          items: [],
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-other',
          delivered: true,
          deliveryMethod: 'tmux',
          status: 'working',
        }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });

    expect(
      await client.getSessionDetail(validConfig, 'sess-123'),
    ).toMatchObject({ ok: false, category: 'malformed_response' });
    expect(
      await client.getSessionOutput(validConfig, 'sess-123'),
    ).toMatchObject({ ok: false, category: 'malformed_response' });
    expect(
      await client.getSessionHistory(validConfig, 'sess-123'),
    ).toMatchObject({ ok: false, category: 'malformed_response' });
    expect(
      await client.sendMessage(validConfig, 'sess-123', {
        message: 'hello',
        clientRequestId: 'req-1',
      }),
    ).toMatchObject({ ok: false, category: 'malformed_response' });
  });

  test('respects 429 Retry-After cooldown before making new requests', async () => {
    let fakeNow = 100_000;
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '12',
        body: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now: () => fakeNow,
    });

    const limited = await client.listSessions(validConfig);
    expect(limited).toEqual({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 12,
    });

    fakeNow += 5000;
    const blocked = await client.listSessions(validConfig);
    expect(blocked).toEqual({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 7,
    });
    expect(request).toHaveBeenCalledTimes(1);

    fakeNow += 7000;
    const allowed = await client.listSessions(validConfig);
    expect(allowed.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('never automatically retries POST sendMessage and enforces limits before dispatch', async () => {
    const transport: HttpTransport = {
      request: jest
        .fn()
        .mockRejectedValueOnce(new Error('raw socket reset'))
        .mockResolvedValueOnce({
          status: 502,
          retryAfter: null,
          body: '',
        }),
    };

    const client = new SpawneaApiClient({
      transport,
      allowDebugLoopback: false,
    });

    // Contract limit failures must reject without invoking transport
    expect(
      await client.sendMessage(validConfig, 'sess-1', {
        message: '   ',
        clientRequestId: 'req-0',
      }),
    ).toMatchObject({ ok: false, category: 'invalid_request' });
    expect(
      await client.sendMessage(validConfig, 'sess-1', {
        message: 'a'.repeat(32001),
        clientRequestId: 'req-0',
      }),
    ).toMatchObject({ ok: false, category: 'invalid_request' });
    expect(
      await client.sendMessage(validConfig, 'sess-1', {
        message: 'hello',
        clientRequestId: 'r'.repeat(129),
      }),
    ).toMatchObject({ ok: false, category: 'invalid_request' });
    expect(
      await client.listSessions({
        serverUrl: validConfig.serverUrl,
        apiKey: 'bad\nkey',
      }),
    ).toMatchObject({ ok: false, category: 'invalid_request' });
    expect(transport.request).toHaveBeenCalledTimes(0);

    const networkErr = await client.sendMessage(validConfig, 'sess-1', {
      message: 'hello',
      clientRequestId: 'req-1',
    });
    expect(networkErr).toEqual({
      ok: false,
      category: 'network_error',
      status: null,
      retryAfterSeconds: null,
    });
    expect(transport.request).toHaveBeenCalledTimes(1);

    const serverErr = await client.sendMessage(validConfig, 'sess-1', {
      message: 'hello',
      clientRequestId: 'req-2',
    });
    expect(serverErr).toEqual({
      ok: false,
      category: 'server_error',
      status: 502,
      retryAfterSeconds: null,
    });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  test('maps E_TLS_ERROR and E_BODY_READ_TIMEOUT explicitly', async () => {
    const tlsErr = Object.assign(new Error('tls fail'), { code: 'E_TLS_ERROR' });
    const bodyTimeoutErr = Object.assign(new Error('body timeout'), {
      code: 'E_BODY_READ_TIMEOUT',
    });
    const request = jest
      .fn()
      .mockRejectedValueOnce(tlsErr)
      .mockRejectedValueOnce(bodyTimeoutErr);

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });

    const r1 = await client.listSessions(validConfig);
    expect(r1).toMatchObject({ ok: false, category: 'tls_error' });
    expect(formatApiErrorMessage('tls_error', null, null)).toContain('TLS');

    const r2 = await client.listSessions(validConfig);
    expect(r2).toMatchObject({ ok: false, category: 'timeout' });
  });

  test('validates all required contract fields for sessions list, detail, output, history, and sendMessage with negative cases', async () => {
    const validSession = makeSessionFixture();
    const request = jest
      .fn()
      // 1. Valid sessions list
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [validSession] }),
      })
      // 2. Invalid sessions list (missing harness.command / active / createdAt)
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [{ id: 'sess-1', name: 'Partial', status: 'idle' }],
        }),
      })
      // 3. Valid session detail
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', session: validSession }),
      })
      // 4. Invalid session detail (missing project.name)
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          session: { ...validSession, project: { id: 'proj-1' } },
        }),
      })
      // 5. Valid live output
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-123',
          available: true,
          status: 'live',
          output: 'terminal text',
        }),
      })
      // 6. Valid unavailable output
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-123',
          available: false,
          status: 'unavailable',
          output: null,
          message: 'Not running',
        }),
      })
      // 7. Invalid output (available=true but output=null)
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-123',
          available: true,
          status: 'live',
          output: null,
        }),
      })
      // 8. Valid history
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-123',
          available: true,
          source: 'transcript',
          items: [
            {
              id: 'item-1',
              role: 'user',
              text: 'Hi',
              source: 'transcript',
            },
          ],
          cursor: 'offset:10',
          hasMore: false,
        }),
      })
      // 9. Invalid history (bad source & item missing role)
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-123',
          available: true,
          source: 'unknown',
          items: [{ id: 'item-1', text: 'Hi', source: 'transcript' }],
        }),
      })
      // 10. Valid sendMessage
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-123',
          delivered: true,
          deliveryMethod: 'tmux',
          status: 'working',
        }),
      })
      // 11. Invalid sendMessage (missing deliveryMethod)
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessionId: 'sess-123',
          delivered: true,
          status: 'working',
        }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });

    expect((await client.listSessions(validConfig)).ok).toBe(true);
    expect(await client.listSessions(validConfig)).toMatchObject({
      ok: false,
      category: 'malformed_response',
    });

    expect((await client.getSessionDetail(validConfig, 'sess-123')).ok).toBe(
      true,
    );
    expect(await client.getSessionDetail(validConfig, 'sess-123')).toMatchObject(
      { ok: false, category: 'malformed_response' },
    );

    expect((await client.getSessionOutput(validConfig, 'sess-123')).ok).toBe(
      true,
    );
    expect((await client.getSessionOutput(validConfig, 'sess-123')).ok).toBe(
      true,
    );
    expect(await client.getSessionOutput(validConfig, 'sess-123')).toMatchObject(
      { ok: false, category: 'malformed_response' },
    );

    expect((await client.getSessionHistory(validConfig, 'sess-123')).ok).toBe(
      true,
    );
    expect(
      await client.getSessionHistory(validConfig, 'sess-123'),
    ).toMatchObject({ ok: false, category: 'malformed_response' });

    expect(
      (
        await client.sendMessage(validConfig, 'sess-123', {
          message: 'hello',
          clientRequestId: 'req-ok',
        })
      ).ok,
    ).toBe(true);
    expect(
      await client.sendMessage(validConfig, 'sess-123', {
        message: 'hello',
        clientRequestId: 'req-bad-resp',
      }),
    ).toMatchObject({ ok: false, category: 'malformed_response' });
  });

  test('parseRetryAfterSeconds handles numeric and HTTP-date headers', () => {
    const now = Date.UTC(2026, 10, 13, 12, 0, 0);
    expect(parseRetryAfterSeconds('30', now)).toBe(30);
    expect(
      parseRetryAfterSeconds('Fri, 13 Nov 2026 12:00:45 GMT', now),
    ).toBe(45);
    expect(parseRetryAfterSeconds('invalid', now)).toBeNull();
  });

  test('429 cooldown is scoped per canonical server origin across server switches', async () => {
    let nowMs = 10_000;
    const request = jest
      .fn()
      // Server A returns 429 Retry-After: 30
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '30',
        body: '',
      })
      // Server B returns 200 immediately despite Server A's active cooldown
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now: () => nowMs,
    });

    const configA = {
      serverUrl: 'https://server-a.tailnet.ts.net',
      apiKey: 'key-a',
    };
    const configAAlias = {
      serverUrl: 'HTTPS://SERVER-A.TAILNET.TS.NET:443/',
      apiKey: 'key-a',
    };
    const configB = {
      serverUrl: 'https://server-b.tailnet.ts.net',
      apiKey: 'key-b',
    };

    const firstA = await client.listSessions(configA);
    expect(firstA).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(client.getRateLimitRemainingSeconds(configA.serverUrl)).toBe(30);

    // Server A with equivalent canonical origin (:443, uppercase) is throttled without hitting transport
    nowMs += 5_000;
    const blockedA = await client.listSessions(configAAlias);
    expect(blockedA).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 25,
    });
    expect(request).toHaveBeenCalledTimes(1);

    // Switching to Server B succeeds immediately
    const resB = await client.listSessions(configB);
    expect(resB.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(client.getRateLimitRemainingSeconds(configB.serverUrl)).toBe(0);
    expect(client.getRateLimitRemainingSeconds(configA.serverUrl)).toBe(25);
  });

  test('late 429 response from old server A never throttles new server B', async () => {
    let nowMs = 20_000;
    let resolveServerA!: (value: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;

    const request = jest
      .fn()
      // 1st dispatch: slow Server A request
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveServerA = resolve;
          }),
      )
      // 2nd dispatch: fast Server B request -> 200
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      })
      // 3rd dispatch: another Server B request after Server A's late 429 settled -> still 200
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now: () => nowMs,
    });

    const configA = {
      serverUrl: 'https://server-a.tailnet.ts.net',
      apiKey: 'key-a',
    };
    const configB = {
      serverUrl: 'https://server-b.tailnet.ts.net',
      apiKey: 'key-b',
    };

    const pendingA = client.listSessions(configA);
    client.notifyCredentialsChanged();

    const firstB = await client.listSessions(configB);
    expect(firstB.ok).toBe(true);

    // Now resolve Server A late with 429 Retry-After: 45
    resolveServerA({
      status: 429,
      retryAfter: '45',
      body: '',
    });
    const resA = await pendingA;
    expect(resA).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 45,
    });

    // Server B remains unthrottled while Server A carries the 45s cooldown
    const secondB = await client.listSessions(configB);
    expect(secondB.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(client.getRateLimitRemainingSeconds(configB.serverUrl)).toBe(0);
    expect(client.getRateLimitRemainingSeconds(configA.serverUrl)).toBe(45);
  });

  test('concurrent 429s keep the maximum active cooldown deadline per origin', async () => {
    let nowMs = 50_000;
    let resolveReq1!: (value: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;
    let resolveReq2!: (value: {
      status: number;
      retryAfter: string | null;
      body: string;
    }) => void;

    const request = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveReq1 = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveReq2 = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now: () => nowMs,
    });

    const config = {
      serverUrl: 'https://desktop.tailnet.ts.net:5757',
      apiKey: 'key-a',
    };

    // Case 1: 60s settles first, then a later concurrent 5s arrives -> 60s wins.
    const p1 = client.listSessions(config);
    const p2 = client.listSessions(config);

    resolveReq1({ status: 429, retryAfter: '60', body: '' });
    await p1;
    expect(client.getRateLimitRemainingSeconds(config.serverUrl)).toBe(60);

    resolveReq2({ status: 429, retryAfter: '5', body: '' });
    await p2;

    nowMs += 6_000;
    const stillBlocked = await client.listSessions(config);
    expect(stillBlocked).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 54,
    });
    expect(request).toHaveBeenCalledTimes(2);

    // Case 2: once expired, a later longer 429 extends the active cooldown (15s -> 90s).
    nowMs += 60_000;
    const transport2 = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveReq1 = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveReq2 = resolve;
          }),
      );
    const client2 = new SpawneaApiClient({
      transport: { request: transport2 },
      allowDebugLoopback: false,
      now: () => nowMs,
    });

    const q1 = client2.listSessions(config);
    const q2 = client2.listSessions(config);

    resolveReq1({ status: 429, retryAfter: '15', body: '' });
    await q1;
    expect(client2.getRateLimitRemainingSeconds(config.serverUrl)).toBe(15);

    resolveReq2({ status: 429, retryAfter: '90', body: '' });
    await q2;
    expect(client2.getRateLimitRemainingSeconds(config.serverUrl)).toBe(90);

    nowMs += 20_000;
    const stillExtended = await client2.listSessions(config);
    expect(stillExtended).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 70,
    });
    expect(transport2).toHaveBeenCalledTimes(2);
  });

  test('normalizes numeric ports before computing the 429 cooldown origin key', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '45',
        body: '',
      })
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '30',
        body: '',
      })
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '25',
        body: '',
      });

    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: true,
      now: () => 200_000,
    });

    // https://host:00443 == https://host == https://host:443
    const first429 = await client.listSessions({
      serverUrl: 'https://desktop.tailnet.ts.net:00443',
      apiKey: 'key-a',
    });
    expect(first429).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 45,
    });
    expect(
      client.getRateLimitRemainingSeconds('https://desktop.tailnet.ts.net'),
    ).toBe(45);
    expect(
      client.getRateLimitRemainingSeconds('https://desktop.tailnet.ts.net:443'),
    ).toBe(45);

    const blockedCanonical = await client.listSessions({
      serverUrl: 'https://desktop.tailnet.ts.net',
      apiKey: 'key-a',
    });
    expect(blockedCanonical).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 45,
    });
    expect(request).toHaveBeenCalledTimes(1);

    // Leading zeros on custom port: :05757 == :5757
    const custom429 = await client.listSessions({
      serverUrl: 'https://desktop.tailnet.ts.net:05757',
      apiKey: 'key-a',
    });
    expect(custom429).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(
      client.getRateLimitRemainingSeconds('https://desktop.tailnet.ts.net:5757'),
    ).toBe(30);
    const blockedCustom = await client.listSessions({
      serverUrl: 'https://desktop.tailnet.ts.net:5757',
      apiKey: 'key-a',
    });
    expect(blockedCustom).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(request).toHaveBeenCalledTimes(2);

    // Default http port with leading zeros: http://127.0.0.1:0080 == http://127.0.0.1
    const http429 = await client.listSessions({
      serverUrl: 'http://127.0.0.1:0080',
      apiKey: 'key-a',
    });
    expect(http429).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 25,
    });
    expect(client.getRateLimitRemainingSeconds('http://127.0.0.1')).toBe(25);
    const blockedHttp = await client.listSessions({
      serverUrl: 'http://127.0.0.1',
      apiKey: 'key-a',
    });
    expect(blockedHttp).toMatchObject({
      ok: false,
      category: 'rate_limited',
      status: 429,
      retryAfterSeconds: 25,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
