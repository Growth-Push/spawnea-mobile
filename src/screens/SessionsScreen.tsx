import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface SessionsScreenProps {
  onOpenSessionChatPlaceholder: () => void;
  onOpenSettings: () => void;
}

export function SessionsScreen({
  onOpenSessionChatPlaceholder,
  onOpenSettings,
}: SessionsScreenProps): React.JSX.Element {
  return (
    <View style={styles.container} testID="sessions-screen">
      <Text style={styles.title}>Sessions</Text>
      <View style={styles.card}>
        <Text style={styles.cardHeading}>Not available yet</Text>
        <Text style={styles.cardBody}>
          Session listing and parent-child grouping are not implemented in this
          bootstrap slice.
        </Text>
        <Pressable
          testID="open-session-chat-placeholder-button"
          accessibilityRole="button"
          style={styles.secondaryButton}
          onPress={onOpenSessionChatPlaceholder}>
          <Text style={styles.secondaryButtonText}>
            Open Session / Chat Placeholder
          </Text>
        </Pressable>
        <Pressable
          testID="sessions-open-settings-button"
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
    gap: 10,
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
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '600',
  },
});
