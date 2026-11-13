import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export function SessionChatScreen(): React.JSX.Element {
  return (
    <View style={styles.container} testID="session-chat-screen">
      <Text style={styles.title}>Session / Chat</Text>
      <View style={styles.card}>
        <Text style={styles.cardHeading}>Not available yet</Text>
        <Text style={styles.cardBody}>
          Conversation history, live terminal output, and prompt submission will
          be added in a later slice.
        </Text>
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
});
