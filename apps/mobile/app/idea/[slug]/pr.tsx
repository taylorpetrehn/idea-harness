import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatusPill } from '../../../src/components/StatusPill';
import { useIdea } from '../../../src/lib/mcp';

// PR Status — for ideas at status pr-open or shipped.
// Shows the GitHub PR link + (if present) the review gauntlet verdict
// stored next to the idea as review.json. Phase 4 will deep-link to a
// dedicated review-detail screen.

export default function PRStatusScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error } = useIdea(slug);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#94a3b8" />
      </SafeAreaView>
    );
  }
  if (error || !data) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.error}>{error?.message ?? 'Idea not found.'}</Text>
      </SafeAreaView>
    );
  }

  const fm = data.frontmatter as Record<string, unknown>;
  const prUrl = (fm.github_pr as string | null | undefined) ?? null;
  const ghIssue = (fm.github_issue as string | null | undefined) ?? null;
  const status = data.status;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>{data.title}</Text>
        <View style={styles.metaRow}>
          <StatusPill status={status} />
          <Text style={styles.meta}>{data.project ?? '?'}</Text>
        </View>

        {prUrl ? (
          <Pressable style={styles.card} onPress={() => void Linking.openURL(prUrl)}>
            <Text style={styles.cardLabel}>Pull request</Text>
            <Text style={styles.cardValue} numberOfLines={2}>{prUrl}</Text>
            <Text style={styles.cardHint}>Tap to open in GitHub.</Text>
          </Pressable>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Pull request</Text>
            <Text style={styles.cardValue}>(not opened yet)</Text>
            <Text style={styles.cardHint}>
              The builder hasn't produced a PR_URL yet. Wait for the next build cron tick or trigger one with `harness ideas build {data.slug}` on the Mac.
            </Text>
          </View>
        )}

        {ghIssue && (
          <Pressable style={styles.card} onPress={() => void Linking.openURL(ghIssue)}>
            <Text style={styles.cardLabel}>Source issue</Text>
            <Text style={styles.cardValue} numberOfLines={2}>{ghIssue}</Text>
          </Pressable>
        )}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Build artifact</Text>
          <Text style={styles.cardValue}>{data.path}</Text>
          <Text style={styles.cardHint}>
            review.json (if produced by the gauntlet) lives alongside this file. On the Mac: `cat ~/.claude/plans/specs/{data.slug}/review.json`.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Frontmatter</Text>
          {Object.entries(data.frontmatter).map(([key, value]) => (
            <View key={key} style={styles.fmRow}>
              <Text style={styles.fmKey}>{key}</Text>
              <Text style={styles.fmValue} numberOfLines={1}>
                {value == null ? '~' : String(value)}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scroll: { padding: 16, gap: 12 },
  title: { color: '#f8fafc', fontSize: 20, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  meta: { color: '#94a3b8', fontSize: 13 },
  card: { backgroundColor: '#1e293b', padding: 14, borderRadius: 10, gap: 6 },
  cardLabel: { color: '#a5b4fc', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardValue: { color: '#f8fafc', fontSize: 14 },
  cardHint: { color: '#64748b', fontSize: 12 },
  fmRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  fmKey: { color: '#94a3b8', fontSize: 12, width: 120 },
  fmValue: { color: '#e2e8f0', fontSize: 12, flex: 1 },
  error: { color: '#ef4444', padding: 32, textAlign: 'center' },
});
