import { NativeModules } from 'react-native';
import {
  deleteApiKey,
  getBiometryCapability,
  getCredentialState,
  hasStoredApiKey,
  readApiKey,
  saveCredentials,
  updateSavedServerUrl,
} from '../src/storage/keyStorage';

const keystore = NativeModules.SpawneaKeystore as {
  getCapability: jest.Mock;
  getCredentialState: jest.Mock;
  hasKey: jest.Mock;
  saveCredentials: jest.Mock;
  updateServerUrl: jest.Mock;
  readKey: jest.Mock;
  deleteKey: jest.Mock;
};

describe('keyStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    keystore.getCapability.mockResolvedValue({
      biometryAvailable: true,
      biometryType: 'Fingerprint',
      status: 'available',
    });
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: null,
      hasKey: false,
      incomplete: false,
    });
    keystore.saveCredentials.mockResolvedValue(true);
    keystore.updateServerUrl.mockResolvedValue(true);
    keystore.deleteKey.mockResolvedValue(true);
  });

  test('saves URL and API key in one native commit with explicit save prompt copy', async () => {
    const serverUrl = 'https://desktop.tailnet.ts.net:5757';
    const dummyKey = 'dummy-secret-key-12345678901234567890';
    const res = await saveCredentials(serverUrl, dummyKey);

    expect(res).toEqual({
      ok: true,
      data: undefined,
      biometryEnrolled: true,
    });
    expect(keystore.saveCredentials).toHaveBeenCalledWith(
      serverUrl,
      dummyKey,
      'Save Spawnea API Key',
      expect.stringContaining('save your API key'),
      'Cancel',
    );
  });

  test('refuses to save when no strong biometrics are enrolled', async () => {
    keystore.getCapability.mockResolvedValue({
      biometryAvailable: false,
      biometryType: null,
      status: 'none_enrolled',
    });

    const res = await saveCredentials(
      'https://desktop.tailnet.ts.net:5757',
      'dummy-secret-key-12345678901234567890',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('no_biometrics_enrolled');
    }
    expect(keystore.saveCredentials).not.toHaveBeenCalled();
  });

  test('maps cancel, lockout, invalidation, and no-enrollment explicitly without leaking raw errors', async () => {
    const rawDetail = 'RAW_NATIVE_INTERNAL_DETAIL_DO_NOT_SHOW';

    keystore.readKey.mockRejectedValueOnce({
      code: 'E_AUTH_CANCELED',
      message: rawDetail,
    });
    const cancelled = await readApiKey();
    expect(cancelled).toMatchObject({ ok: false, errorCode: 'unlock_cancelled' });
    expect(JSON.stringify(cancelled)).not.toContain(rawDetail);

    keystore.readKey.mockRejectedValueOnce({
      code: 'E_BIOMETRIC_LOCKOUT',
      message: rawDetail,
    });
    const lockedOut = await readApiKey();
    expect(lockedOut).toMatchObject({
      ok: false,
      errorCode: 'biometric_lockout',
    });
    expect(lockedOut.ok ? '' : lockedOut.message).not.toContain('device credential');
    expect(JSON.stringify(lockedOut)).not.toContain(rawDetail);

    keystore.readKey.mockRejectedValueOnce({
      code: 'E_AUTH_INVALIDATED',
      message: rawDetail,
    });
    const invalidated = await readApiKey();
    expect(invalidated).toMatchObject({
      ok: false,
      errorCode: 'auth_invalidated',
    });
    expect(invalidated.ok ? '' : invalidated.message.toLowerCase()).toContain(
      're-link required',
    );
    expect(JSON.stringify(invalidated)).not.toContain(rawDetail);

    keystore.readKey.mockRejectedValueOnce({
      code: 'E_BIOMETRIC_NOT_ENROLLED',
      message: rawDetail,
    });
    const notEnrolled = await readApiKey();
    expect(notEnrolled).toMatchObject({
      ok: false,
      errorCode: 'no_biometrics_enrolled',
    });
    expect(JSON.stringify(notEnrolled)).not.toContain(rawDetail);
  });

  test('queries unified credential state, updates server URL, and handles strict delete success/failure', async () => {
    keystore.getCredentialState.mockResolvedValueOnce({
      serverUrl: 'https://desktop.tailnet.ts.net:5757',
      hasKey: true,
      incomplete: false,
    });
    expect(await hasStoredApiKey()).toBe(true);

    keystore.getCredentialState.mockResolvedValueOnce({
      serverUrl: null,
      hasKey: false,
      incomplete: true,
    });
    expect(await getCredentialState()).toEqual({
      serverUrl: null,
      hasKey: false,
      incomplete: true,
    });

    expect(await getBiometryCapability()).toEqual({
      biometryAvailable: true,
      biometryType: 'Fingerprint',
      status: 'available',
    });

    expect(
      await updateSavedServerUrl('https://updated.tailnet.ts.net:5757'),
    ).toMatchObject({ ok: true });
    keystore.updateServerUrl.mockRejectedValueOnce({ code: 'E_STORAGE_ERROR' });
    expect(
      await updateSavedServerUrl('https://failed.tailnet.ts.net:5757'),
    ).toMatchObject({ ok: false, errorCode: 'storage_error' });

    expect(await deleteApiKey()).toMatchObject({ ok: true });
    expect(keystore.deleteKey).toHaveBeenCalledTimes(1);

    keystore.deleteKey.mockResolvedValueOnce(false);
    expect(await deleteApiKey()).toMatchObject({
      ok: false,
      errorCode: 'storage_error',
    });

    keystore.saveCredentials.mockRejectedValueOnce({
      code: 'E_COMMIT_UNCERTAIN',
      message: 'RAW_NATIVE_ROLLBACK_DETAIL',
    });
    const uncertainSave = await saveCredentials(
      'https://desktop.tailnet.ts.net:5757',
      'dummy-secret-key-12345678901234567890',
    );
    expect(uncertainSave).toMatchObject({
      ok: false,
      errorCode: 'commit_uncertain',
    });
    expect(JSON.stringify(uncertainSave)).not.toContain(
      'RAW_NATIVE_ROLLBACK_DETAIL',
    );
  });
});
