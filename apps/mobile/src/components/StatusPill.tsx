import { StyleSheet, Text, View } from 'react-native';

const STATUS_COLORS: Record<string, string> = {
  captured: '#64748b',
  brainstormed: '#22c55e',
  'needs-detail': '#f59e0b',
  'needs-critic-review': '#ef4444',
  accepted: '#10b981',
  building: '#3b82f6',
  'pr-open': '#8b5cf6',
  shipped: '#0ea5e9',
  rejected: '#475569',
};

export function StatusPill({ status }: { status: string }) {
  const bg = STATUS_COLORS[status] ?? '#475569';
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={styles.text}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  text: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
