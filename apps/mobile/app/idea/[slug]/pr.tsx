import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ErrorState, Loading } from '../../../src/components/States';
import { StatusPill } from '../../../src/components/StatusPill';
import { useIdea } from '../../../src/lib/mcp';
import { colors, pressedOpacity, radius, space } from '../../../src/lib/theme';

// PR Status — for ideas at status pr-open or shipped.
// Shows the GitHub PR link + (if present) the review gauntlet verdict
// stored next to the idea as review.json.

export default function PRStatusScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error, refetch, isRefetching } = useIdea(slug);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loading label="Loading PR status…" />
      </SafeAreaView>
    );
  }
  if (error || !data) {
    return (
      <SafeAreaView style={styles.container}>
        <ErrorState
          title="Couldn't load idea"
          message={error?.message ?? 'Idea not found.'}
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  const fm = data.frontmatter as Record<string, unknown>;
  const prUrl = (fm.github_pr as string | null | undefined) ?? null;
  const ghIssue = (fm.github_issue as string | null | undefined) ?? null;
  const status = data.status;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.textSecondary}
          />
        }
      >
        <Text style={styles.title}>{data.title}</Text>
        <View style={styles.metaRow}>
          <StatusPill status={status} />
          <Text style={styles.meta}>{data.project ?? '?'}</Text>
        </View>

        {prUrl ? (
          <Pressable
            style={({ pressed }) => [styles.card, pressedOpacity({ pressed })]}
            onPress={() => void Linking.openURL(prUrl)}
            accessibilityRole="link"
            accessibilityLabel="Open pull request in GitHub"
          >
            <Text style={styles.cardLabel}>Pull request</Text>
            <Text style={styles.cardValue} numberOfLines={2}>
              {prUrl}
            </Text>
            <Text style={styles.cardHint}>Tap to open in GitHub.</Text>
          </Pressable>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Pull request</Text>
            <Text style={styles.cardValue}>(not opened yet)</Text>
            <Text style={styles.cardHint}>
              The builder hasn&apos;t produced a PR yet. It lands here automatically on the next
              build-cron tick — pull to refresh to check.
            </Text>
          </View>
        )}

        {ghIssue && (
          <Pressable
            style={({ pressed }) => [styles.card, pressedOpacity({ pressed })]}
            onPress={() => void Linking.openURL(ghIssue)}
            accessibilityRole="link"
            accessibilityLabel="Open source issue in GitHub"
          >
            <Text style={styles.cardLabel}>Source issue</Text>
            <Text style={styles.cardValue} numberOfLines={2}>
              {ghIssue}
            </Text>
          </Pressable>
        )}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Build artifact</Text>
          <Text style={styles.cardValue}>{data.path}</Text>
          <Text style={styles.cardHint}>
            review.json (if the review gauntlet ran) lives alongside this idea.md on the Mac.
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
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.lg, gap: space.md },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  meta: { color: colors.textSecondary, fontSize: 13 },
  card: { backgroundColor: colors.surface, padding: space.md + 2, borderRadius: radius.md, gap: space.xs + 2 },
  cardLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardValue: { color: colors.textPrimary, fontSize: 14 },
  cardHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  fmRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  fmKey: { color: colors.textSecondary, fontSize: 12, width: 120 },
  fmValue: { color: '#e2e8f0', fontSize: 12, flex: 1 },
});
