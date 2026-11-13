import { NativeModules } from 'react-native';

export type KeyStorageErrorCode =
  | 'empty_key'
  | 'invalid_url'
  | 'not_configured'
  | 'no_biometrics_enrolled'
  | 'biometric_unavailable'
  | 'unlock_cancelled'
  | 'unlock_failed'
  | 'biometric_lockout'
  | 'auth_invalidated'
  | 'commit_uncertain'
  | 'storage_error';

export type KeyStorageResult<T> =
  | {
      ok: true;
      data: T;
      biometryEnrolled: boolean;
    }
  | {
      ok: false;
      errorCode: KeyStorageErrorCode;
      message: string;
    };

export type BiometryStatus = 'available' | 'none_enrolled' | 'unavailable';

export interface BiometryCapability {
  biometryAvailable: boolean;
  biometryType: string | null;
  status: BiometryStatus;
}

export interface CredentialState {
  serverUrl: string | null;
  hasKey: boolean;
  incomplete: boolean;
}

interface NativeSpawneaKeystoreModule {
  getCapability(): Promise<{
    biometryAvailable: boolean;
    biometryType: string | null;
    status: BiometryStatus;
  }>;
  getCredentialState(): Promise<CredentialState>;
  hasKey(): Promise<boolean>;
  saveCredentials(
    serverUrl: string,
    rawApiKey: string,
    promptTitle: string,
    promptSubtitle: string,
    negativeButtonText: string,
  ): Promise<boolean>;
  updateServerUrl(serverUrl: string): Promise<boolean>;
  readKey(
    promptTitle: string,
    promptSubtitle: string,
    negativeButtonText: string,
  ): Promise<string>;
  deleteKey(): Promise<boolean>;
}

function getKeystoreModule(): NativeSpawneaKeystoreModule | null {
  const mod = (
    NativeModules as { SpawneaKeystore?: NativeSpawneaKeystoreModule }
  ).SpawneaKeystore;
  return mod ?? null;
}

function mapKeystoreError(
  error: unknown,
  operation: 'save' | 'read' | 'delete',
): {
  errorCode: KeyStorageErrorCode;
  message: string;
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';

  switch (code) {
    case 'E_EMPTY_KEY':
      return {
        errorCode: 'empty_key',
        message: 'API key is required.',
      };
    case 'E_INVALID_URL':
      return {
        errorCode: 'invalid_url',
        message: 'Server URL is required.',
      };
    case 'E_NOT_CONFIGURED':
      return {
        errorCode: 'not_configured',
        message: 'No API key is saved on this device.',
      };
    case 'E_AUTH_CANCELED':
      return {
        errorCode: 'unlock_cancelled',
        message:
          operation === 'save'
            ? 'Fingerprint confirmation was cancelled. Configuration was not saved.'
            : 'Fingerprint unlock was cancelled. The API key remains locked.',
      };
    case 'E_BIOMETRIC_NOT_ENROLLED':
      return {
        errorCode: 'no_biometrics_enrolled',
        message:
          'No fingerprint is enrolled on this device. Enroll a fingerprint in Android Settings first.',
      };
    case 'E_BIOMETRIC_UNAVAILABLE':
      return {
        errorCode: 'biometric_unavailable',
        message: 'Strong biometric unlock is unavailable on this device.',
      };
    case 'E_BIOMETRIC_LOCKOUT':
    case 'E_BIOMETRIC_LOCKOUT_PERMANENT':
      return {
        errorCode: 'biometric_lockout',
        message:
          'Fingerprint unlock is locked out after too many failed attempts. Re-unlock your device and try again.',
      };
    case 'E_AUTH_INVALIDATED':
      return {
        errorCode: 'auth_invalidated',
        message:
          'Saved key invalidated after biometric enrollment change; re-link required.',
      };
    case 'E_AUTH_TIMEOUT':
    case 'E_AUTH_ERROR':
      return {
        errorCode: 'unlock_failed',
        message: 'Fingerprint unlock failed. Try again.',
      };
    case 'E_COMMIT_UNCERTAIN':
      return {
        errorCode: 'commit_uncertain',
        message:
          'Could not confirm which configuration is saved. Test the connection or re-enter the key.',
      };
    default:
      return {
        errorCode: 'storage_error',
        message: 'Secure key storage operation failed.',
      };
  }
}

/**
 * Queries Android BIOMETRIC_STRONG availability (fingerprint, no PIN fallback).
 */
export async function getBiometryCapability(): Promise<BiometryCapability> {
  const keystore = getKeystoreModule();
  if (!keystore) {
    return {
      biometryAvailable: false,
      biometryType: null,
      status: 'unavailable',
    };
  }
  try {
    return await keystore.getCapability();
  } catch {
    return {
      biometryAvailable: false,
      biometryType: null,
      status: 'unavailable',
    };
  }
}

/**
 * Reads the reconciled durable native configuration state without prompting for biometrics.
 */
export async function getCredentialState(): Promise<CredentialState> {
  const keystore = getKeystoreModule();
  if (!keystore || typeof keystore.getCredentialState !== 'function') {
    return {
      serverUrl: null,
      hasKey: false,
      incomplete: false,
    };
  }
  try {
    return await keystore.getCredentialState();
  } catch {
    return {
      serverUrl: null,
      hasKey: false,
      incomplete: true,
    };
  }
}

/**
 * Checks whether an encrypted API key exists without triggering BiometricPrompt.
 */
export async function hasStoredApiKey(): Promise<boolean> {
  const state = await getCredentialState();
  return state.hasKey && state.serverUrl !== null && !state.incomplete;
}

/**
 * Encrypts and stores both the server URL and API key in a single durable native
 * transaction protected by Android Keystore AES-256-GCM (per-use BIOMETRIC_STRONG).
 */
export async function saveCredentials(
  serverUrl: string,
  rawApiKey: string,
): Promise<KeyStorageResult<void>> {
  const trimmedUrl = serverUrl.trim();
  if (!trimmedUrl) {
    return {
      ok: false,
      errorCode: 'invalid_url',
      message: 'Server URL is required.',
    };
  }

  const apiKey = rawApiKey.trim();
  if (!apiKey) {
    return {
      ok: false,
      errorCode: 'empty_key',
      message: 'API key is required.',
    };
  }

  const keystore = getKeystoreModule();
  if (!keystore) {
    return {
      ok: false,
      errorCode: 'storage_error',
      message: 'Native Keystore module is unavailable.',
    };
  }

  const capability = await getBiometryCapability();
  if (!capability.biometryAvailable) {
    return {
      ok: false,
      errorCode:
        capability.status === 'none_enrolled'
          ? 'no_biometrics_enrolled'
          : 'biometric_unavailable',
      message:
        capability.status === 'none_enrolled'
          ? 'No fingerprint is enrolled on this device. Enroll a fingerprint in Android Settings first.'
          : 'Strong biometric unlock is unavailable on this device.',
    };
  }

  try {
    const saved = await keystore.saveCredentials(
      trimmedUrl,
      apiKey,
      'Save Spawnea API Key',
      'Authenticate with your fingerprint to encrypt and save your API key',
      'Cancel',
    );
    if (!saved) {
      return {
        ok: false,
        errorCode: 'storage_error',
        message: 'Could not save the configuration to secure storage.',
      };
    }

    return {
      ok: true,
      data: undefined,
      biometryEnrolled: true,
    };
  } catch (err) {
    const mapped = mapKeystoreError(err, 'save');
    return {
      ok: false,
      errorCode: mapped.errorCode,
      message: mapped.message,
    };
  }
}

/**
 * Updates the persisted server URL inside the single durable native record
 * while keeping the active encrypted Keystore key slot untouched.
 */
export async function updateSavedServerUrl(
  serverUrl: string,
): Promise<KeyStorageResult<void>> {
  const trimmedUrl = serverUrl.trim();
  if (!trimmedUrl) {
    return {
      ok: false,
      errorCode: 'invalid_url',
      message: 'Server URL is required.',
    };
  }

  const keystore = getKeystoreModule();
  if (!keystore) {
    return {
      ok: false,
      errorCode: 'storage_error',
      message: 'Native Keystore module is unavailable.',
    };
  }

  try {
    const updated = await keystore.updateServerUrl(trimmedUrl);
    if (!updated) {
      return {
        ok: false,
        errorCode: 'storage_error',
        message: 'Failed to update the saved server URL.',
      };
    }
    return {
      ok: true,
      data: undefined,
      biometryEnrolled: true,
    };
  } catch (err) {
    const mapped = mapKeystoreError(err, 'save');
    return {
      ok: false,
      errorCode: mapped.errorCode,
      message: mapped.message,
    };
  }
}

/**
 * Prompts for per-use BIOMETRIC_STRONG unlock via CryptoObject and returns the
 * decrypted API key solely for in-memory request signing. Never log or render.
 */
export async function readApiKey(
  promptSubtitle = 'Unlock access to your saved Spawnea API key',
): Promise<KeyStorageResult<string>> {
  const keystore = getKeystoreModule();
  if (!keystore) {
    return {
      ok: false,
      errorCode: 'storage_error',
      message: 'Native Keystore module is unavailable.',
    };
  }

  try {
    const decrypted = await keystore.readKey(
      'Unlock Spawnea API Key',
      promptSubtitle,
      'Cancel',
    );
    if (!decrypted) {
      return {
        ok: false,
        errorCode: 'not_configured',
        message: 'No API key is saved on this device.',
      };
    }

    return {
      ok: true,
      data: decrypted,
      biometryEnrolled: true,
    };
  } catch (err) {
    const mapped = mapKeystoreError(err, 'read');
    return {
      ok: false,
      errorCode: mapped.errorCode,
      message: mapped.message,
    };
  }
}

/**
 * Strictly deletes both Keystore aliases and the durable configuration record.
 * Does not revoke the key on the Spawnea server.
 */
export async function deleteApiKey(): Promise<KeyStorageResult<void>> {
  const keystore = getKeystoreModule();
  if (!keystore) {
    return {
      ok: false,
      errorCode: 'storage_error',
      message: 'Native Keystore module is unavailable.',
    };
  }

  try {
    const deleted = await keystore.deleteKey();
    if (!deleted) {
      return {
        ok: false,
        errorCode: 'storage_error',
        message: 'Failed to remove the saved API key from secure storage.',
      };
    }
    return {
      ok: true,
      data: undefined,
      biometryEnrolled: false,
    };
  } catch (err) {
    const mapped = mapKeystoreError(err, 'delete');
    return {
      ok: false,
      errorCode: mapped.errorCode,
      message: mapped.message,
    };
  }
}
