import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, statusColors } from '../lib/theme';

export function StatusPill({ status }: { status: string }) {
  const bg = statusColors[status] ?? colors.border;
  return (
    <View
      style={[styles.pill, { backgroundColor: bg }]}
      accessible
      accessibilityLabel={`status ${status}`}
    >
      <Text style={styles.text}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  text: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
