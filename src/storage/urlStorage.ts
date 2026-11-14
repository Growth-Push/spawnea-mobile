import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCredentialState, updateSavedServerUrl } from './keyStorage';

const LEGACY_SERVER_URL_STORAGE_KEY = 'spawnea.server_url';

/**
 * Reads the non-secret Spawnea server URL from the unified durable native record.
 * Secret API keys and server URLs are committed atomically by SpawneaKeystore.
 */
export async function getSavedServerUrl(): Promise<string | null> {
  const state = await getCredentialState();
  return state.hasKey && !state.incomplete ? state.serverUrl : null;
}

/**
 * Updates the persisted server URL inside the single durable native record
 * alongside the active encrypted Keystore slot.
 */
export async function saveServerUrl(url: string): Promise<void> {
  const result = await updateSavedServerUrl(url);
  if (!result.ok) {
    throw new Error(result.message);
  }
}

/**
 * Clears any legacy AsyncStorage server URL entry from earlier app versions.
 */
export async function clearLegacyServerUrl(): Promise<void> {
  await AsyncStorage.removeItem(LEGACY_SERVER_URL_STORAGE_KEY).catch(
    () => undefined,
  );
}
