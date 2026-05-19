/**
 * Shared loading / empty / error states so every screen looks and
 * behaves the same. Detail, Decision and PR previously had no retry
 * affordance at all — ErrorState gives them one.
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, pressedOpacity, radius, space } from '../lib/theme';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.body}>{message}</Text> : null}
      {onRetry ? (
        <Pressable
          style={({ pressed }) => [styles.button, pressedOpacity({ pressed })]}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
        >
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xxl, gap: space.md },
  muted: { color: colors.textSecondary, fontSize: 13 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  body: { color: colors.textSecondary, textAlign: 'center', fontSize: 14, lineHeight: 20 },
  button: {
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    marginTop: space.sm,
  },
  buttonText: { color: colors.textPrimary, fontWeight: '600' },
});
