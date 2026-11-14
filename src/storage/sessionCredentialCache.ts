import { AppState } from 'react-native';
import type { SpawneaApiClient } from '../api/client';
import { isDebugLoopbackAllowed } from '../config/runtime';
import { validateServerUrl } from '../config/validation';
import {
  getCredentialState,
  KeyStorageErrorCode,
  readApiKey,
} from './keyStorage';

export interface UnlockedApiCredentials {
  serverUrl: string;
  apiKey: string;
}

export type SessionUnlockFailureReason =
  | KeyStorageErrorCode
  | 'incomplete_config'
  | 'backgrounded'
  | 'credential_changed';

export interface TerminalAuthLock {
  reason: SessionUnlockFailureReason;
  message: string;
}

export type SessionUnlockResult =
  | {
      ok: true;
      credentials: UnlockedApiCredentials;
      fromCache: boolean;
    }
  | {
      ok: false;
      reason: SessionUnlockFailureReason;
      message: string;
    };

interface CachedEntry {
  serverUrl: string;
  apiKey: string;
  credentialGeneration: number;
}

const TERMINAL_AUTH_REASONS: ReadonlySet<SessionUnlockFailureReason> = new Set([
  'biometric_lockout',
  'auth_invalidated',
  'not_configured',
  'incomplete_config',
  'no_biometrics_enrolled',
  'biometric_unavailable',
  'invalid_url',
]);

function isForegroundAppState(state: string | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

/**
 * Memory-only credential cache for a single active foreground session.
 *
 * Security-relevant design choice:
 * Android Keystore keys require per-use BIOMETRIC_STRONG confirmation (0s
 * validity), so calling `readApiKey()` on every background-paused dashboard poll
 * would prompt repeatedly. This cache unlocks the API key once per foreground
 * session and keeps only an in-memory JavaScript reference bound to the
 * `SpawneaApiClient` credential generation.
 *
 * Centralizes cache invalidation and terminal-auth lock propagation across
 * Settings and Dashboard:
 * - Clears the cached reference and invalidates any pending unlock whenever
 *   the app leaves the foreground (`background` / `inactive`), on deletion, on
 *   any save/commit outcome, or when credentials change mid-unlock.
 * - Records a terminal-auth lock and clears cache + pending unlocks on
 *   biometric lockout, Keystore invalidation (`auth_invalidated`), or missing/
 *   unavailable biometric or credential configuration so Dashboard stops
 *   making HTTP requests or auto-prompting until a successful fresh unlock or
 *   credential reconfiguration.
 *
 * Note: JavaScript strings in Hermes/V8 are immutable and cannot be byte-zeroed
 * in place; clearing drops the reference for garbage collection, whereas native
 * Keystore buffers are zeroed immediately upon decryption.
 */
export class SessionCredentialCache {
  private entry: CachedEntry | null = null;
  private inFlightUnlock: Promise<SessionUnlockResult> | null = null;
  private unlockEpoch = 0;
  private terminalAuthLock: TerminalAuthLock | null = null;
  private readonly clearListeners = new Set<() => void>();
  private readonly terminalInvalidationListeners = new Set<
    (lock: TerminalAuthLock) => void
  >();
  private readonly terminalLockClearedListeners = new Set<() => void>();
  private appStateSubscription: { remove: () => void } | null = null;

  constructor(autoSubscribeAppState = true) {
    if (autoSubscribeAppState) {
      this.subscribeToAppState();
    }
  }

  subscribeToAppState(): void {
    if (this.appStateSubscription) {
      return;
    }
    this.appStateSubscription = AppState.addEventListener(
      'change',
      nextState => {
        if (!isForegroundAppState(nextState)) {
          this.clear();
        }
      },
    );
  }

  dispose(): void {
    this.appStateSubscription?.remove?.();
    this.appStateSubscription = null;
    this.terminalAuthLock = null;
    this.clear();
    this.clearListeners.clear();
    this.terminalInvalidationListeners.clear();
    this.terminalLockClearedListeners.clear();
  }

  onCleared(listener: () => void): () => void {
    this.clearListeners.add(listener);
    return () => {
      this.clearListeners.delete(listener);
    };
  }

  onTerminalInvalidated(listener: (lock: TerminalAuthLock) => void): () => void {
    this.terminalInvalidationListeners.add(listener);
    return () => {
      this.terminalInvalidationListeners.delete(listener);
    };
  }

  onTerminalLockCleared(listener: () => void): () => void {
    this.terminalLockClearedListeners.add(listener);
    return () => {
      this.terminalLockClearedListeners.delete(listener);
    };
  }

  getTerminalAuthLock(): TerminalAuthLock | null {
    return this.terminalAuthLock;
  }

  hasUnlockedKey(apiClient: SpawneaApiClient, serverUrl?: string): boolean {
    if (this.terminalAuthLock !== null || !this.entry) {
      return false;
    }
    if (this.entry.credentialGeneration !== apiClient.getCredentialGeneration()) {
      this.entry = null;
      return false;
    }
    if (serverUrl !== undefined && this.entry.serverUrl !== serverUrl) {
      return false;
    }
    return true;
  }

  getCachedCredentials(
    apiClient: SpawneaApiClient,
    expectedServerUrl?: string,
  ): UnlockedApiCredentials | null {
    if (!this.hasUnlockedKey(apiClient, expectedServerUrl) || !this.entry) {
      return null;
    }
    return {
      serverUrl: this.entry.serverUrl,
      apiKey: this.entry.apiKey,
    };
  }

  /**
   * Clears the cached credential reference and invalidates any pending unlock.
   */
  clear(): void {
    const hadEntry = this.entry !== null;
    this.entry = null;
    this.inFlightUnlock = null;
    this.unlockEpoch += 1;
    if (hadEntry) {
      for (const listener of this.clearListeners) {
        listener();
      }
    }
  }

  /**
   * Clears cached credentials, invalidates pending unlocks, and clears any
   * prior terminal-auth lock after an explicit credential save or deletion.
   */
  invalidateForCredentialChange(): void {
    const hadTerminalLock = this.terminalAuthLock !== null;
    this.terminalAuthLock = null;
    this.clear();
    if (hadTerminalLock) {
      for (const listener of this.terminalLockClearedListeners) {
        listener();
      }
    }
  }

  /**
   * Clears cached credentials, invalidates pending unlocks, and records a
   * terminal-auth lock so callers stop issuing HTTP requests or automatic
   * unlock prompts until a fresh unlock or credential update succeeds.
   */
  invalidateForTerminalAuth(
    reason: SessionUnlockFailureReason,
    message: string,
  ): void {
    const lock: TerminalAuthLock = { reason, message };
    this.terminalAuthLock = lock;
    this.clear();
    for (const listener of this.terminalInvalidationListeners) {
      listener(lock);
    }
  }

  /**
   * Centralized handler for Keystore read failures across Settings and Dashboard.
   */
  recordReadFailure(errorCode: KeyStorageErrorCode, message: string): void {
    if (TERMINAL_AUTH_REASONS.has(errorCode)) {
      this.invalidateForTerminalAuth(errorCode, message);
      return;
    }
    if (errorCode === 'storage_error') {
      this.clear();
    }
  }

  /**
   * Clears any prior terminal-auth lock after an explicit Keystore unlock
   * succeeds (for example, Settings -> Test connection), without caching the
   * unlocked key in memory.
   */
  recordReadSuccess(): void {
    if (this.terminalAuthLock === null) {
      return;
    }
    this.terminalAuthLock = null;
    for (const listener of this.terminalLockClearedListeners) {
      listener();
    }
  }

  /**
   * Centralized handler for any Settings save/commit outcome (success or failure).
   */
  recordSaveOutcome(
    outcome:
      | { ok: true }
      | { ok: false; errorCode: KeyStorageErrorCode; message: string },
  ): void {
    if (outcome.ok) {
      this.invalidateForCredentialChange();
      return;
    }
    if (TERMINAL_AUTH_REASONS.has(outcome.errorCode)) {
      this.invalidateForTerminalAuth(outcome.errorCode, outcome.message);
      return;
    }
    if (outcome.errorCode === 'commit_uncertain') {
      this.invalidateForCredentialChange();
      return;
    }
    this.clear();
  }

  async unlockAndGetCredentials(options: {
    apiClient: SpawneaApiClient;
    allowDebugLoopback?: boolean;
    promptSubtitle?: string;
  }): Promise<SessionUnlockResult> {
    const {
      apiClient,
      allowDebugLoopback = isDebugLoopbackAllowed(),
      promptSubtitle = 'Unlock your saved API key to refresh live sessions',
    } = options;

    if (!isForegroundAppState(AppState.currentState)) {
      this.clear();
      return {
        ok: false,
        reason: 'backgrounded',
        message: 'Cannot unlock API key while app is in background.',
      };
    }

    if (this.inFlightUnlock) {
      return this.inFlightUnlock;
    }

    const startEpoch = this.unlockEpoch;
    const startGeneration = apiClient.getCredentialGeneration();

    const unlockPromise = (async (): Promise<SessionUnlockResult> => {
      const credState = await getCredentialState();
      if (
        !isForegroundAppState(AppState.currentState) ||
        this.unlockEpoch !== startEpoch
      ) {
        return {
          ok: false,
          reason: 'backgrounded',
          message: 'Unlock did not complete in the active foreground session.',
        };
      }
      if (apiClient.getCredentialGeneration() !== startGeneration) {
        this.clear();
        return {
          ok: false,
          reason: 'credential_changed',
          message: 'Credentials changed before biometric unlock completed.',
        };
      }

      if (credState.incomplete) {
        const message =
          'Stored configuration is incomplete. Re-link your server URL and API key in Settings.';
        this.invalidateForTerminalAuth('incomplete_config', message);
        return {
          ok: false,
          reason: 'incomplete_config',
          message,
        };
      }

      if (!credState.hasKey || credState.serverUrl === null) {
        const message = 'Configure your server URL and API key in Settings.';
        this.invalidateForTerminalAuth('not_configured', message);
        return {
          ok: false,
          reason: 'not_configured',
          message,
        };
      }

      const urlCheck = validateServerUrl(
        credState.serverUrl,
        allowDebugLoopback,
      );
      if (!urlCheck.valid) {
        this.invalidateForTerminalAuth('invalid_url', urlCheck.message);
        return {
          ok: false,
          reason: 'invalid_url',
          message: urlCheck.message,
        };
      }

      const cached = this.getCachedCredentials(apiClient, urlCheck.normalizedUrl);
      if (cached) {
        return {
          ok: true,
          credentials: cached,
          fromCache: true,
        };
      }

      const readResult = await readApiKey(promptSubtitle);
      if (!readResult.ok) {
        this.recordReadFailure(readResult.errorCode, readResult.message);
        return {
          ok: false,
          reason: readResult.errorCode,
          message: readResult.message,
        };
      }

      if (apiClient.getCredentialGeneration() !== startGeneration) {
        this.clear();
        return {
          ok: false,
          reason: 'credential_changed',
          message: 'Credentials changed before biometric unlock completed.',
        };
      }

      if (
        !isForegroundAppState(AppState.currentState) ||
        this.unlockEpoch !== startEpoch
      ) {
        return {
          ok: false,
          reason: 'backgrounded',
          message: 'Unlock did not complete in the active foreground session.',
        };
      }

      this.terminalAuthLock = null;
      this.entry = {
        serverUrl: urlCheck.normalizedUrl,
        apiKey: readResult.data,
        credentialGeneration: startGeneration,
      };

      return {
        ok: true,
        credentials: {
          serverUrl: urlCheck.normalizedUrl,
          apiKey: readResult.data,
        },
        fromCache: false,
      };
    })();

    this.inFlightUnlock = unlockPromise;
    try {
      return await unlockPromise;
    } finally {
      if (this.inFlightUnlock === unlockPromise) {
        this.inFlightUnlock = null;
      }
    }
  }
}

export const defaultSessionCredentialCache = new SessionCredentialCache();
