import React, {
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { GrowthPushSignature } from '../dashboard/DashboardIcons';
import {
  defaultApiClient,
  formatApiErrorMessage,
  SpawneaApiClient,
} from '../api/client';
import { isDebugLoopbackAllowed } from '../config/runtime';
import {
  canonicalServerOrigin,
  validateServerUrl,
} from '../config/validation';
import {
  BiometryCapability,
  deleteApiKey,
  getBiometryCapability,
  getCredentialState,
  KeyStorageResult,
  readApiKey,
  saveCredentials,
  updateSavedServerUrl,
} from '../storage/keyStorage';
import { clearLegacyServerUrl } from '../storage/urlStorage';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../storage/sessionCredentialCache';

interface SettingsScreenProps {
  apiClient?: SpawneaApiClient;
  credentialCache?: SessionCredentialCache;
  allowDebugLoopback?: boolean;
}

type StatusTone = 'neutral' | 'success' | 'warning' | 'error';

interface StatusBanner {
  tone: StatusTone;
  message: string;
}

function formatCapabilityLabel(capability: BiometryCapability | null): string {
  if (!capability) {
    return 'Checking device security capabilities...';
  }
  if (capability.biometryAvailable) {
    return `Strong biometric unlock available (${capability.biometryType ?? 'Biometric'}).`;
  }
  if (capability.status === 'none_enrolled') {
    return 'No fingerprint enrolled. Enroll a fingerprint in Android Settings to use key storage.';
  }
  return 'Strong biometric unlock unavailable on this device. Secure key storage is unavailable.';
}

export function SettingsScreen({
  apiClient = defaultApiClient,
  credentialCache = defaultSessionCredentialCache,
  allowDebugLoopback,
}: SettingsScreenProps): React.JSX.Element {
  const effectiveAllowDebugLoopback =
    allowDebugLoopback ?? isDebugLoopbackAllowed();
  const navigation = useContext(NavigationContext);

  const [serverUrl, setServerUrl] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [isIncomplete, setIsIncomplete] = useState(false);
  const [capability, setCapability] = useState<BiometryCapability | null>(null);
  const [busyAction, setBusyAction] = useState<
    'save' | 'test' | 'delete' | null
  >(null);
  const [saveBanner, setSaveBanner] = useState<StatusBanner | null>(null);
  const [testBanner, setTestBanner] = useState<StatusBanner | null>(null);

  const refreshStatus = useCallback(async () => {
    const [credState, bioCap] = await Promise.all([
      getCredentialState(),
      getBiometryCapability(),
    ]);
    setHasSavedKey(credState.hasKey);
    setIsIncomplete(credState.incomplete);
    setCapability(bioCap);
  }, []);

  const refreshState = useCallback(async () => {
    const [credState, bioCap] = await Promise.all([
      getCredentialState(),
      getBiometryCapability(),
    ]);
    setServerUrl(credState.serverUrl ?? '');
    setHasSavedKey(credState.hasKey);
    setIsIncomplete(credState.incomplete);
    setCapability(bioCap);
  }, []);

  useEffect(() => {
    refreshState().catch(() => undefined);
  }, [refreshState]);

  useEffect(() => {
    const unsubscribeFocus = navigation?.addListener('focus', () => {
      refreshStatus().catch(() => undefined);
    });
    const appStateSub = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        refreshStatus().catch(() => undefined);
      }
    });
    return () => {
      unsubscribeFocus?.();
      appStateSub?.remove?.();
    };
  }, [navigation, refreshStatus]);

  const handleSaveFailure = async (
    result: Extract<KeyStorageResult<void>, { ok: false }>,
  ) => {
    setApiKeyInput('');
    const [restoredState, bioCap] = await Promise.all([
      getCredentialState(),
      getBiometryCapability(),
    ]);
    setHasSavedKey(restoredState.hasKey);
    setIsIncomplete(restoredState.incomplete);
    setCapability(bioCap);

    credentialCache.recordSaveOutcome(result);

    if (result.errorCode === 'commit_uncertain') {
      setServerUrl(restoredState.serverUrl ?? '');
      setTestBanner(null);
      apiClient.notifyCredentialsChanged();
      setSaveBanner({
        tone: 'error',
        message: result.message,
      });
      return;
    }

    if (restoredState.serverUrl !== null && restoredState.hasKey) {
      setServerUrl(restoredState.serverUrl);
      setSaveBanner({
        tone: 'error',
        message: `${result.message} Previous saved configuration was kept.`,
      });
    } else {
      setServerUrl('');
      setSaveBanner({
        tone: 'error',
        message: restoredState.incomplete
          ? `${result.message} Stored configuration is incomplete.`
          : result.message,
      });
    }
  };

  const handleServerUrlChange = (nextUrl: string) => {
    setServerUrl(nextUrl);
    setTestBanner(null);
  };

  const handleSave = async () => {
    setBusyAction('save');
    setSaveBanner(null);

    try {
      const urlCheck = validateServerUrl(
        serverUrl,
        effectiveAllowDebugLoopback,
      );
      if (!urlCheck.valid) {
        setApiKeyInput('');
        setSaveBanner({ tone: 'error', message: urlCheck.message });
        return;
      }

      const existingState = await getCredentialState();
      const trimmedKey = apiKeyInput.trim();
      if (!trimmedKey && !existingState.hasKey) {
        setApiKeyInput('');
        setHasSavedKey(false);
        setIsIncomplete(existingState.incomplete);
        setSaveBanner({
          tone: 'error',
          message: 'Enter an API key to complete setup.',
        });
        return;
      }

      if (trimmedKey) {
        // Persist URL and active encrypted key slot together in one native commit.
        const saveResult = await saveCredentials(
          urlCheck.normalizedUrl,
          trimmedKey,
        );
        if (!saveResult.ok) {
          await handleSaveFailure(saveResult);
          return;
        }

        await clearLegacyServerUrl();
        setServerUrl(urlCheck.normalizedUrl);
        setHasSavedKey(true);
        setIsIncomplete(false);
        // Clear plaintext input immediately so the key is never kept in UI state.
        setApiKeyInput('');
        setTestBanner(null);
        credentialCache.recordSaveOutcome({ ok: true });
        apiClient.notifyCredentialsChanged();

        setSaveBanner({
          tone: 'success',
          message: 'Server URL and API key saved in Android Keystore.',
        });
      } else {
        const existingOrigin = existingState.serverUrl
          ? canonicalServerOrigin(existingState.serverUrl)
          : null;
        const targetOrigin = canonicalServerOrigin(urlCheck.normalizedUrl);

        if (existingOrigin !== targetOrigin) {
          setApiKeyInput('');
          setHasSavedKey(existingState.hasKey);
          setIsIncomplete(existingState.incomplete);
          setTestBanner(null);
          setSaveBanner({
            tone: 'error',
            message:
              'Changing the server origin requires entering the API key again.',
          });
          return;
        }

        if (existingState.serverUrl !== urlCheck.normalizedUrl) {
          const updateResult = await updateSavedServerUrl(
            urlCheck.normalizedUrl,
          );
          if (!updateResult.ok) {
            await handleSaveFailure(updateResult);
            return;
          }
          apiClient.notifyCredentialsChanged();
        }

        await clearLegacyServerUrl();
        setApiKeyInput('');
        setServerUrl(urlCheck.normalizedUrl);
        setHasSavedKey(true);
        setIsIncomplete(false);
        credentialCache.recordSaveOutcome({ ok: true });
        if (existingState.serverUrl !== urlCheck.normalizedUrl) {
          // notifyCredentialsChanged already ran right after the URL update above.
          setTestBanner(null);
        }
        setSaveBanner({
          tone: 'success',
          message:
            'Server origin unchanged; existing protected API key kept.',
        });
      }

      setCapability(await getBiometryCapability());
    } catch {
      setApiKeyInput('');
      credentialCache.clear();
      await refreshState().catch(() => undefined);
      setSaveBanner({
        tone: 'error',
        message: 'Failed to save configuration.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDelete = async () => {
    setBusyAction('delete');
    setSaveBanner(null);
    setTestBanner(null);

    try {
      const deleteResult = await deleteApiKey();
      if (!deleteResult.ok) {
        credentialCache.clear();
        await refreshState().catch(() => undefined);
        setSaveBanner({ tone: 'error', message: deleteResult.message });
        return;
      }

      await clearLegacyServerUrl();
      const [afterState, bioCap] = await Promise.all([
        getCredentialState(),
        getBiometryCapability(),
      ]);
      setServerUrl(afterState.serverUrl ?? '');
      setApiKeyInput('');
      setHasSavedKey(afterState.hasKey);
      setIsIncomplete(afterState.incomplete);
      setCapability(bioCap);

      if (
        afterState.hasKey ||
        afterState.serverUrl !== null ||
        afterState.incomplete
      ) {
        credentialCache.clear();
        setSaveBanner({
          tone: 'error',
          message: 'Failed to verify removal of the saved API key.',
        });
        return;
      }

      credentialCache.invalidateForCredentialChange();
      apiClient.notifyCredentialsChanged();
      setSaveBanner({
        tone: 'neutral',
        message:
          'Local settings removed from this device. The server key was not revoked.',
      });
    } catch {
      credentialCache.clear();
      await refreshState().catch(() => undefined);
      setSaveBanner({
        tone: 'error',
        message: 'Failed to remove local settings.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleTestConnection = async () => {
    setBusyAction('test');
    setTestBanner(null);

    try {
      // Always test using the saved Keystore configuration rather than unsaved draft inputs.
      const savedState = await getCredentialState();
      setHasSavedKey(savedState.hasKey);
      setIsIncomplete(savedState.incomplete);
      if (!savedState.hasKey || !savedState.serverUrl || savedState.incomplete) {
        const missingMsg =
          'Incomplete configuration. Save your server URL and API key first.';
        credentialCache.invalidateForTerminalAuth(
          savedState.incomplete ? 'incomplete_config' : 'not_configured',
          missingMsg,
        );
        setTestBanner({
          tone: 'error',
          message: missingMsg,
        });
        return;
      }

      const urlCheck = validateServerUrl(
        savedState.serverUrl,
        effectiveAllowDebugLoopback,
      );
      if (!urlCheck.valid) {
        credentialCache.invalidateForTerminalAuth('invalid_url', urlCheck.message);
        setTestBanner({
          tone: 'error',
          message: urlCheck.message,
        });
        return;
      }

      const unlockResult = await readApiKey(
        'Unlock your saved API key to test the server connection',
      );
      if (!unlockResult.ok) {
        credentialCache.recordReadFailure(
          unlockResult.errorCode,
          unlockResult.message,
        );
        setCapability(await getBiometryCapability());
        setTestBanner({
          tone:
            unlockResult.errorCode === 'unlock_cancelled'
              ? 'warning'
              : 'error',
          message: unlockResult.message,
        });
        return;
      }

      credentialCache.recordReadSuccess();

      const response = await apiClient.testConnection({
        serverUrl: urlCheck.normalizedUrl,
        apiKey: unlockResult.data,
      });

      if (!response.ok) {
        setTestBanner({
          tone: response.category === 'rate_limited' ? 'warning' : 'error',
          message: formatApiErrorMessage(
            response.category,
            response.status,
            response.retryAfterSeconds,
          ),
        });
        return;
      }

      const count = response.data.sessions.length;
      setTestBanner({
        tone: 'success',
        message:
          count === 0
            ? 'Connection succeeded (HTTP 200). 0 sessions reported.'
            : `Connection succeeded (HTTP 200). ${count} ${
                count === 1 ? 'session' : 'sessions'
              } reported.`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const isBusy = busyAction !== null;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      testID="settings-screen">
      <Text style={styles.subtitle}>
        Configure your private Spawnea Mobile API connection.
      </Text>

      <View style={styles.securityBox}>
        <Text style={styles.securityTitle}>Device Protection Status</Text>
        <Text style={styles.securityText} testID="biometry-status-text">
          {formatCapabilityLabel(capability)}
        </Text>
        <Text style={styles.securityText} testID="stored-key-status-text">
          {hasSavedKey
            ? 'API key status: Saved in Android Keystore (never displayed or copyable).'
            : isIncomplete
            ? 'API key status: Incomplete configuration (re-link required).'
            : 'API key status: Not configured.'}
        </Text>
      </View>

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        testID="server-url-input"
        accessibilityLabel="Server URL"
        style={styles.input}
        value={serverUrl}
        onChangeText={handleServerUrlChange}
        placeholder={
          effectiveAllowDebugLoopback
            ? 'https://machine.tailnet.ts.net or http://127.0.0.1:5757'
            : 'https://machine.tailnet.ts.net'
        }
        placeholderTextColor="#6e7681"
        selectionColor="#a78bfa"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        editable={!isBusy}
      />

      <Text style={styles.label}>
        {hasSavedKey ? 'Replace API Key' : 'API Key'}
      </Text>
      <TextInput
        testID="api-key-input"
        accessibilityLabel="API Key"
        style={styles.input}
        value={apiKeyInput}
        onChangeText={setApiKeyInput}
        placeholder={
          hasSavedKey
            ? 'Saved key is protected; enter new key to replace'
            : 'Enter API key'
        }
        placeholderTextColor="#6e7681"
        selectionColor="#a78bfa"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!isBusy}
      />

      <View style={styles.buttonRow}>
        <Pressable
          testID="save-settings-button"
          accessibilityRole="button"
          style={[styles.primaryButton, isBusy && styles.buttonDisabled]}
          disabled={isBusy}
          onPress={handleSave}>
          <Text style={styles.primaryButtonText}>
            {busyAction === 'save'
              ? 'Saving...'
              : hasSavedKey
              ? 'Save / Replace'
              : 'Save'}
          </Text>
        </Pressable>

        <Pressable
          testID="test-connection-button"
          accessibilityRole="button"
          style={[styles.secondaryButton, isBusy && styles.buttonDisabled]}
          disabled={isBusy}
          onPress={handleTestConnection}>
          <Text style={styles.secondaryButtonText}>
            {busyAction === 'test' ? 'Testing...' : 'Test connection'}
          </Text>
        </Pressable>
      </View>

      {saveBanner !== null && (
        <View
          testID="save-status-banner"
          style={[styles.banner, bannerStyleForTone(saveBanner.tone)]}>
          <Text style={styles.bannerText} testID="save-status-text">
            {saveBanner.message}
          </Text>
        </View>
      )}

      {testBanner !== null && (
        <View
          testID="test-status-banner"
          style={[styles.banner, bannerStyleForTone(testBanner.tone)]}>
          <Text style={styles.bannerText} testID="test-status-text">
            {testBanner.message}
          </Text>
        </View>
      )}

      <View style={styles.dangerSection}>
        <Text style={styles.noticeText} testID="delete-revocation-notice">
          Deleting Settings removes credentials from this device only and does
          not revoke the API key on your Spawnea server.
        </Text>
        <Pressable
          testID="delete-settings-button"
          accessibilityRole="button"
          style={[styles.dangerButton, isBusy && styles.buttonDisabled]}
          disabled={isBusy}
          onPress={handleDelete}>
          <Text style={styles.dangerButtonText}>
            {busyAction === 'delete' ? 'Deleting...' : 'Delete Settings'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.footerSignature} testID="settings-growth-push-footer">
        <GrowthPushSignature />
      </View>
    </ScrollView>
  );
}

function bannerStyleForTone(tone: StatusTone) {
  switch (tone) {
    case 'success':
      return styles.bannerSuccess;
    case 'warning':
      return styles.bannerWarning;
    case 'error':
      return styles.bannerError;
    case 'neutral':
      return styles.bannerNeutral;
  }
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  container: {
    padding: 20,
    paddingBottom: 36,
  },
  subtitle: {
    fontSize: 14,
    color: '#9ca3af',
    marginBottom: 16,
  },
  securityBox: {
    backgroundColor: '#111620',
    borderWidth: 1,
    borderColor: '#21262d',
    borderRadius: 12,
    padding: 14,
    marginBottom: 18,
    gap: 4,
  },
  securityTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  securityText: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#e6edf3',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    backgroundColor: '#161b22',
    color: '#f0f6fc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 14,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#7c3aed',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#f0f6fc',
    fontSize: 15,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  banner: {
    marginTop: 14,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
  },
  bannerSuccess: {
    backgroundColor: '#0e2820',
    borderColor: '#059669',
  },
  bannerWarning: {
    backgroundColor: '#271e09',
    borderColor: '#d97706',
  },
  bannerError: {
    backgroundColor: '#261114',
    borderColor: '#dc2626',
  },
  bannerNeutral: {
    backgroundColor: '#161b22',
    borderColor: '#30363d',
  },
  bannerText: {
    fontSize: 14,
    color: '#e6edf3',
    lineHeight: 19,
  },
  dangerSection: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    gap: 10,
  },
  noticeText: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
  dangerButton: {
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  dangerButtonText: {
    color: '#fecaca',
    fontSize: 15,
    fontWeight: '600',
  },
  footerSignature: {
    marginTop: 24,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    alignItems: 'center',
  },
});
