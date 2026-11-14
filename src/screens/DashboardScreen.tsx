import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getCredentialState } from '../storage/keyStorage';

interface DashboardScreenProps {
  onOpenSettings: () => void;
}

export function DashboardScreen({
  onOpenSettings,
}: DashboardScreenProps): React.JSX.Element {
  const [hasUrl, setHasUrl] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      getCredentialState()
        .then(state => {
          if (active) {
            setHasUrl(state.serverUrl !== null);
            setHasKey(state.hasKey && !state.incomplete);
          }
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

  const isConfigured = hasUrl && hasKey;

  return (
    <View style={styles.container} testID="dashboard-screen">
      <Text style={styles.title}>Dashboard</Text>
      <View style={styles.card}>
        <Text style={styles.cardHeading}>Not available yet</Text>
        <Text style={styles.cardBody}>
          Live session status and active summary views will be added in the
          next slice. No sample or synthetic session data is shown.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardHeading}>Connection configuration</Text>
        <Text style={styles.cardBody} testID="dashboard-config-status">
          {isConfigured
            ? 'Server URL and protected API key are saved on this device.'
            : 'Configuration is incomplete. Configure server URL and API key in Settings.'}
        </Text>
        <Pressable
          testID="dashboard-open-settings-button"
          accessibilityRole="button"
          style={styles.button}
          onPress={onOpenSettings}>
          <Text style={styles.buttonText}>Open Settings</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    gap: 8,
  },
  cardHeading: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#475569',
  },
  button: {
    marginTop: 6,
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});
