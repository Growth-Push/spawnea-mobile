/**
 * @format
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { SpawneaApiClient } from '../src/api/client';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { makeSessionFixture } from './apiClient.test';

const DUMMY_KEY = 'dummy-test-key-must-never-appear-in-ui-or-logs';
const SECRET_BODY_TEXT = 'SENSITIVE_RESPONSE_BODY_TEXT_DO_NOT_RENDER';
const RAW_EXCEPTION_TEXT = 'RAW_EXCEPTION_DETAIL_DO_NOT_RENDER';

const keystore = NativeModules.SpawneaKeystore as {
  getCapability: jest.Mock;
  getCredentialState: jest.Mock;
  hasKey: jest.Mock;
  saveCredentials: jest.Mock;
  updateServerUrl: jest.Mock;
  readKey: jest.Mock;
  deleteKey: jest.Mock;
};

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function getAllTextContent(
  renderer: ReactTestRenderer.ReactTestRenderer,
): string {
  return JSON.stringify(
    renderer.root
      .findAllByType(Text)
      .map(node => node.props.children),
  );
}

describe('App navigation shell', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  test('renders navigation shell with honest placeholders and no fake sessions', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<App />);
      await flushAsync();
    });

    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain('Dashboard');
    expect(serialized).toContain('Sessions');
    expect(serialized).toContain('Settings');
    expect(serialized).toContain('Not available yet');
    expect(serialized).not.toContain('sess-');

    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });
});

describe('SettingsScreen', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: null,
      hasKey: false,
      incomplete: false,
    });
    keystore.getCapability.mockResolvedValue({
      biometryAvailable: true,
      biometryType: 'Fingerprint',
      status: 'available',
    });
    keystore.saveCredentials.mockResolvedValue(true);
    keystore.updateServerUrl.mockResolvedValue(true);
    keystore.deleteKey.mockResolvedValue(true);
  });

  test('renders without a duplicate Settings heading', async () => {
    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const settingsTitleNodes = renderer.root
      .findAllByType(Text)
      .filter(node => node.props.children === 'Settings');
    expect(settingsTitleNodes).toHaveLength(0);
  });

  test('commits URL and key together in one native call, clears input, and never leaks key', async () => {
    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const urlInput = renderer.root.findByProps({ testID: 'server-url-input' });
    const keyInput = renderer.root.findByProps({ testID: 'api-key-input' });
    const saveButton = renderer.root.findByProps({
      testID: 'save-settings-button',
    });

    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('https://desktop.tailnet.ts.net:5757/');
      keyInput.props.onChangeText(DUMMY_KEY);
    });

    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });

    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(DUMMY_KEY),
    );
    expect(keystore.saveCredentials).toHaveBeenCalledWith(
      'https://desktop.tailnet.ts.net:5757',
      DUMMY_KEY,
      'Save Spawnea API Key',
      expect.stringContaining('save your API key'),
      'Cancel',
    );

    const updatedKeyInput = renderer.root.findByProps({
      testID: 'api-key-input',
    });
    expect(updatedKeyInput.props.value).toBe('');

    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).not.toContain(DUMMY_KEY);
    expect(serialized).toContain('Saved in Android Keystore');
  });

  test('preserves previous valid URL+key pair on cancel, native commit failure, and URL-update failure, or surfaces incomplete state', async () => {
    const existingUrl = 'https://old.tailnet.ts.net:5757';
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: existingUrl,
      hasKey: true,
      incomplete: false,
    });

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });
    const notifySpy = jest.spyOn(client, 'notifyCredentialsChanged');

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const urlInput = renderer.root.findByProps({ testID: 'server-url-input' });
    const keyInput = renderer.root.findByProps({ testID: 'api-key-input' });
    const saveButton = renderer.root.findByProps({
      testID: 'save-settings-button',
    });

    // 1. Cancel during key replacement preserves old URL and key
    keystore.saveCredentials.mockRejectedValueOnce({ code: 'E_AUTH_CANCELED' });
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('https://new.tailnet.ts.net:5757');
      keyInput.props.onChangeText('replacement-key-value');
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'server-url-input' }).props.value,
    ).toBe(existingUrl);
    expect(
      renderer.root.findByProps({ testID: 'api-key-input' }).props.value,
    ).toBe('');
    expect(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    ).toContain('Previous saved configuration was kept');
    expect(notifySpy).not.toHaveBeenCalled();

    // 2. Native commit failure preserves old URL and key and clears draft key
    keystore.saveCredentials.mockRejectedValueOnce({ code: 'E_STORAGE_ERROR' });
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('https://broken-commit.tailnet.ts.net:5757');
      keyInput.props.onChangeText('replacement-key-value');
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'server-url-input' }).props.value,
    ).toBe(existingUrl);
    expect(
      renderer.root.findByProps({ testID: 'api-key-input' }).props.value,
    ).toBe('');
    expect(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    ).toContain('Previous saved configuration was kept');
    expect(notifySpy).not.toHaveBeenCalled();

    // 3. Different-origin URL-only save is rejected without calling updateServerUrl or saveCredentials
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('https://bad-url-write.tailnet.ts.net:5757');
      keyInput.props.onChangeText('');
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(keystore.updateServerUrl).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    ).toBe('Changing the server origin requires entering the API key again.');
    expect(notifySpy).not.toHaveBeenCalled();

    // 4. Simulated broken/incomplete native state surfaces explicit incomplete indicator (never old URL + broken key)
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: null,
      hasKey: false,
      incomplete: true,
    });
    keystore.saveCredentials.mockRejectedValueOnce({ code: 'E_STORAGE_ERROR' });
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('https://broken.tailnet.ts.net:5757');
      keyInput.props.onChangeText('replacement-key-value');
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'server-url-input' }).props.value,
    ).toBe('');
    expect(
      renderer.root.findByProps({ testID: 'api-key-input' }).props.value,
    ).toBe('');
    expect(
      renderer.root.findByProps({ testID: 'stored-key-status-text' }).props
        .children,
    ).toContain('Incomplete configuration');
  });

  test('deletes local settings only after confirmed strict deletion and re-reads storage on failure', async () => {
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: 'https://desktop.tailnet.ts.net:5757',
      hasKey: true,
      incomplete: false,
    });
    keystore.deleteKey.mockRejectedValueOnce({ code: 'E_STORAGE_ERROR' });

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const deleteButton = renderer.root.findByProps({
      testID: 'delete-settings-button',
    });

    // Failed delete must keep saved URL and saved-key indicator.
    await ReactTestRenderer.act(async () => {
      await deleteButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'stored-key-status-text' }).props
        .children,
    ).toContain('Saved in Android Keystore');
    expect(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    ).toContain('failed');

    // Confirmed delete clears both Keystore slots and unified metadata.
    keystore.deleteKey.mockResolvedValueOnce(true);
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: null,
      hasKey: false,
      incomplete: false,
    });
    await ReactTestRenderer.act(async () => {
      await deleteButton.props.onPress();
    });

    expect(keystore.deleteKey).toHaveBeenCalledTimes(2);
    expect(
      renderer.root.findByProps({ testID: 'stored-key-status-text' }).props
        .children,
    ).toContain('Not configured');

    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain('does not revoke the API key');
    expect(serialized).toContain('server key was not revoked');
  });

  test('refreshes device protection status on app foreground transition', async () => {
    let appStateListener: ((state: string) => void) | null = null;
    const addListenerSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        appStateListener = listener as (state: string) => void;
        return { remove: jest.fn() };
      });

    keystore.getCapability.mockResolvedValueOnce({
      biometryAvailable: false,
      biometryType: null,
      status: 'none_enrolled',
    });

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    expect(
      renderer.root.findByProps({ testID: 'biometry-status-text' }).props
        .children,
    ).toContain('No fingerprint enrolled');

    keystore.getCapability.mockResolvedValueOnce({
      biometryAvailable: true,
      biometryType: 'Fingerprint',
      status: 'available',
    });

    await ReactTestRenderer.act(async () => {
      appStateListener?.('active');
      await flushAsync();
    });

    expect(
      renderer.root.findByProps({ testID: 'biometry-status-text' }).props
        .children,
    ).toContain('Strong biometric unlock available (Fingerprint)');
    addListenerSpy.mockRestore();
  });

  test('handles incomplete config, 401, 429, TLS failure, network failure, malformed response, 0 sessions, and N sessions without leaking key or body', async () => {
    const tlsError = Object.assign(new Error(RAW_EXCEPTION_TEXT), {
      code: 'E_TLS_ERROR',
    });
    const request = jest
      .fn()
      // 1. 401
      .mockResolvedValueOnce({
        status: 401,
        retryAfter: null,
        body: '',
      })
      // 2. 429
      .mockResolvedValueOnce({
        status: 429,
        retryAfter: '15',
        body: '',
      })
      // 3. TLS failure
      .mockRejectedValueOnce(tlsError)
      // 4. network failure
      .mockRejectedValueOnce(new Error(RAW_EXCEPTION_TEXT))
      // 5. malformed response
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: `not-json-${SECRET_BODY_TEXT}`,
      })
      // 6. 0 sessions
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
      })
      // 7. 2 sessions (complete fixtures)
      .mockResolvedValueOnce({
        status: 200,
        retryAfter: null,
        body: JSON.stringify({
          apiVersion: 'v1',
          sessions: [
            makeSessionFixture({ id: 'sess-1', name: SECRET_BODY_TEXT }),
            makeSessionFixture({
              id: 'sess-2',
              name: 'Other',
              status: 'working',
            }),
          ],
        }),
      });

    let fakeNow = 10_000;
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
      now: () => fakeNow,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const urlInput = renderer.root.findByProps({ testID: 'server-url-input' });
    const keyInput = renderer.root.findByProps({ testID: 'api-key-input' });
    const saveButton = renderer.root.findByProps({
      testID: 'save-settings-button',
    });
    const testButton = renderer.root.findByProps({
      testID: 'test-connection-button',
    });

    // Incomplete config before saving
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('Incomplete configuration');

    // Fill valid HTTPS URL and dummy key, then save into Keystore
    keystore.saveCredentials.mockImplementationOnce(async () => {
      keystore.getCredentialState.mockResolvedValue({
        serverUrl: 'https://desktop.tailnet.ts.net:5757',
        hasKey: true,
        incomplete: false,
      });
      return true;
    });
    keystore.readKey.mockResolvedValue(DUMMY_KEY);

    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('https://desktop.tailnet.ts.net:5757');
      keyInput.props.onChangeText(DUMMY_KEY);
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'api-key-input' }).props.value,
    ).toBe('');

    // 1. 401
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    let textContent = getAllTextContent(renderer);
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('401');
    expect(textContent).not.toContain(DUMMY_KEY);
    expect(textContent).not.toContain(SECRET_BODY_TEXT);

    // 2. 429
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    textContent = getAllTextContent(renderer);
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('429');
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('15s');
    expect(textContent).not.toContain(DUMMY_KEY);

    // Advance past Retry-After
    fakeNow += 16_000;

    // 3. TLS failure
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    textContent = getAllTextContent(renderer);
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('Secure TLS connection failed');
    expect(textContent).not.toContain(DUMMY_KEY);
    expect(textContent).not.toContain(RAW_EXCEPTION_TEXT);

    // 4. Network failure
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    textContent = getAllTextContent(renderer);
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('offline or unreachable');
    expect(textContent).not.toContain(DUMMY_KEY);
    expect(textContent).not.toContain(RAW_EXCEPTION_TEXT);

    // 5. Malformed response
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    textContent = getAllTextContent(renderer);
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('unexpected response format');
    expect(textContent).not.toContain(DUMMY_KEY);
    expect(textContent).not.toContain(SECRET_BODY_TEXT);

    // 6. Empty list (0 sessions)
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('0 sessions');

    // 7. N sessions (2 sessions)
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    textContent = getAllTextContent(renderer);
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('2 sessions');
    expect(textContent).not.toContain(DUMMY_KEY);
    expect(textContent).not.toContain(SECRET_BODY_TEXT);
    expect(textContent).not.toContain('sess-1');
  });

  test('unlocks saved Keystore key for Test connection and full tree never contains key or response body', async () => {
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: 'https://desktop.tailnet.ts.net:5757',
      hasKey: true,
      incomplete: false,
    });
    keystore.readKey.mockResolvedValueOnce(DUMMY_KEY);

    const request = jest.fn().mockResolvedValueOnce({
      status: 401,
      retryAfter: null,
      body: JSON.stringify({ error: SECRET_BODY_TEXT }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const testButton = renderer.root.findByProps({
      testID: 'test-connection-button',
    });
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });

    const fullTree = JSON.stringify(renderer.toJSON());
    expect(fullTree).toContain('401');
    expect(fullTree).not.toContain(DUMMY_KEY);
    expect(fullTree).not.toContain(SECRET_BODY_TEXT);
  });

  test('handles biometric cancel, failed unlock, invalidated key, and no biometrics enrolled states explicitly', async () => {
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: 'https://desktop.tailnet.ts.net:5757',
      hasKey: true,
      incomplete: false,
    });
    keystore.getCapability.mockResolvedValue({
      biometryAvailable: false,
      biometryType: null,
      status: 'none_enrolled',
    });

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    expect(
      renderer.root.findByProps({ testID: 'biometry-status-text' }).props
        .children,
    ).toContain('No fingerprint enrolled');

    const testButton = renderer.root.findByProps({
      testID: 'test-connection-button',
    });

    keystore.readKey.mockRejectedValueOnce({ code: 'E_AUTH_CANCELED' });
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('cancelled');

    keystore.readKey.mockRejectedValueOnce({ code: 'E_AUTH_ERROR' });
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'test-status-text' }).props.children,
    ).toContain('unlock failed');

    keystore.readKey.mockRejectedValueOnce({ code: 'E_AUTH_INVALIDATED' });
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    expect(
      renderer.root
        .findByProps({ testID: 'test-status-text' })
        .props.children.toLowerCase(),
    ).toContain('re-link required');
  });

  test('Test connection always uses saved Keystore config instead of unsaved drafts and clears draft key on cancel/failure', async () => {
    const savedUrl = 'https://saved.tailnet.ts.net:5757';
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: savedUrl,
      hasKey: true,
      incomplete: false,
    });
    keystore.readKey.mockResolvedValue('saved-keystore-key');

    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const urlInput = renderer.root.findByProps({ testID: 'server-url-input' });
    const keyInput = renderer.root.findByProps({ testID: 'api-key-input' });
    const saveButton = renderer.root.findByProps({
      testID: 'save-settings-button',
    });
    const testButton = renderer.root.findByProps({
      testID: 'test-connection-button',
    });

    // Type unsaved URL and unsaved key drafts, then press Test connection without saving.
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('https://unsaved-draft.tailnet.ts.net:5757');
      keyInput.props.onChangeText('unsaved-draft-key');
    });
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });

    expect(keystore.readKey).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: `${savedUrl}/api/v1/sessions`,
        headers: expect.objectContaining({
          Authorization: 'Bearer saved-keystore-key',
        }),
      }),
    );

    // Cancel save -> draft key must be cleared and URL reverted to saved URL.
    keystore.saveCredentials.mockRejectedValueOnce({ code: 'E_AUTH_CANCELED' });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'api-key-input' }).props.value,
    ).toBe('');
    expect(
      renderer.root.findByProps({ testID: 'server-url-input' }).props.value,
    ).toBe(savedUrl);

    // Test connection still unlocks and uses saved Keystore pair.
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    expect(keystore.readKey).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: `${savedUrl}/api/v1/sessions`,
        headers: expect.objectContaining({
          Authorization: 'Bearer saved-keystore-key',
        }),
      }),
    );
  });

  test('API key input allows paste while staying masked and never displaying the saved key', async () => {
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: 'https://desktop.tailnet.ts.net:5757',
      hasKey: true,
      incomplete: false,
    });

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    const keyInput = renderer.root.findByProps({ testID: 'api-key-input' });
    expect(keyInput.props.contextMenuHidden).toBeUndefined();
    expect(keyInput.props.secureTextEntry).toBe(true);
    expect(keyInput.props.value).toBe('');
    expect(keystore.readKey).not.toHaveBeenCalled();

    const statusText = renderer.root.findByProps({
      testID: 'stored-key-status-text',
    }).props.children;
    expect(statusText).toContain('never displayed or copyable');
  });

  test('displays uncertain commit message instead of "kept" when E_COMMIT_UNCERTAIN is returned', async () => {
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: 'https://existing.tailnet.ts.net:5757',
      hasKey: true,
      incomplete: false,
    });
    keystore.saveCredentials.mockRejectedValueOnce({
      code: 'E_COMMIT_UNCERTAIN',
      message: 'Could not verify which configuration is saved on disk',
    });

    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });

    await ReactTestRenderer.act(async () => {
      renderer.root
        .findByProps({ testID: 'server-url-input' })
        .props.onChangeText('https://new.tailnet.ts.net:5757');
      renderer.root
        .findByProps({ testID: 'api-key-input' })
        .props.onChangeText('new-secret-key');
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root
        .findByProps({ testID: 'save-settings-button' })
        .props.onPress();
      await flushAsync();
    });

    const bannerText = String(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    );
    expect(bannerText).toContain('Could not confirm which configuration is saved');
    expect(bannerText.toLowerCase()).not.toContain('kept');
    expect(
      renderer.root.findByProps({ testID: 'api-key-input' }).props.value,
    ).toBe('');
  });

  test('SR-2: rejects different-origin URL-only save without persisting, allows biometric save with key, and allows same-origin URL-only save', async () => {
    const savedUrl = 'http://127.0.0.1:5757';
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: savedUrl,
      hasKey: true,
      incomplete: false,
    });
    keystore.readKey.mockResolvedValue('saved-keystore-key');

    const request = jest.fn().mockResolvedValue({
      status: 200,
      retryAfter: null,
      body: JSON.stringify({ apiVersion: 'v1', sessions: [] }),
    });
    const client = new SpawneaApiClient({
      transport: { request },
      allowDebugLoopback: true,
    });
    const notifySpy = jest.spyOn(client, 'notifyCredentialsChanged');

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={true} />,
      );
      await flushAsync();
    });

    const urlInput = renderer.root.findByProps({ testID: 'server-url-input' });
    const keyInput = renderer.root.findByProps({ testID: 'api-key-input' });
    const saveButton = renderer.root.findByProps({
      testID: 'save-settings-button',
    });
    const testButton = renderer.root.findByProps({
      testID: 'test-connection-button',
    });

    // 1. Different-origin URL-only save is rejected and nothing is persisted
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('http://127.0.0.1:8443');
      keyInput.props.onChangeText('');
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(keystore.updateServerUrl).not.toHaveBeenCalled();
    expect(keystore.saveCredentials).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    ).toBe('Changing the server origin requires entering the API key again.');

    // Test connection still targets original saved origin (5757)
    await ReactTestRenderer.act(async () => {
      await testButton.props.onPress();
    });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:5757/api/v1/sessions',
      }),
    );

    // 2. Different-origin save WITH a key invokes normal biometric save
    keystore.saveCredentials.mockImplementationOnce(async () => {
      keystore.getCredentialState.mockResolvedValue({
        serverUrl: 'http://127.0.0.1:8443',
        hasKey: true,
        incomplete: false,
      });
      return true;
    });
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('http://127.0.0.1:8443');
      keyInput.props.onChangeText('new-origin-dummy-key');
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(keystore.saveCredentials).toHaveBeenCalledTimes(1);
    expect(keystore.saveCredentials).toHaveBeenCalledWith(
      'http://127.0.0.1:8443',
      'new-origin-dummy-key',
      'Save Spawnea API Key',
      expect.stringContaining('save your API key'),
      'Cancel',
    );
    expect(keystore.updateServerUrl).not.toHaveBeenCalled();
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findByProps({ testID: 'api-key-input' }).props.value,
    ).toBe('');
    expect(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    ).toBe('Server URL and API key saved in Android Keystore.');

    // 3. Same-origin URL-only save (identical origin with case/trailing-slash variation) succeeds without key
    await ReactTestRenderer.act(async () => {
      urlInput.props.onChangeText('HTTP://127.0.0.1:8443/');
      keyInput.props.onChangeText('');
    });
    await ReactTestRenderer.act(async () => {
      await saveButton.props.onPress();
    });
    expect(keystore.saveCredentials).toHaveBeenCalledTimes(1);
    expect(keystore.updateServerUrl).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ testID: 'save-status-text' }).props.children,
    ).toBe('Server origin unchanged; existing protected API key kept.');

    // 4. Same-origin default-port normalization updates stored URL without key, and handles native write failure safely
    keystore.getCredentialState.mockResolvedValue({
      serverUrl: 'https://saved.tailnet.ts.net:443',
      hasKey: true,
      incomplete: false,
    });
    let httpsRenderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      httpsRenderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await flushAsync();
    });
    const httpsUrlInput = httpsRenderer.root.findByProps({
      testID: 'server-url-input',
    });
    const httpsSaveButton = httpsRenderer.root.findByProps({
      testID: 'save-settings-button',
    });
    await ReactTestRenderer.act(async () => {
      httpsUrlInput.props.onChangeText('https://saved.tailnet.ts.net/');
    });
    await ReactTestRenderer.act(async () => {
      await httpsSaveButton.props.onPress();
    });
    expect(keystore.updateServerUrl).toHaveBeenCalledWith(
      'https://saved.tailnet.ts.net',
    );
    expect(
      httpsRenderer.root.findByProps({ testID: 'save-status-text' }).props
        .children,
    ).toBe('Server origin unchanged; existing protected API key kept.');

    keystore.updateServerUrl.mockRejectedValueOnce({ code: 'E_STORAGE_ERROR' });
    await ReactTestRenderer.act(async () => {
      httpsUrlInput.props.onChangeText('https://saved.tailnet.ts.net');
    });
    await ReactTestRenderer.act(async () => {
      await httpsSaveButton.props.onPress();
    });
    expect(
      httpsRenderer.root.findByProps({ testID: 'server-url-input' }).props
        .value,
    ).toBe('https://saved.tailnet.ts.net:443');
    expect(
      httpsRenderer.root.findByProps({ testID: 'save-status-text' }).props
        .children,
    ).toContain('Previous saved configuration was kept.');
  });
});
