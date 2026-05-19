import { Link, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ErrorState, Loading } from '../src/components/States';
import { StatusPill } from '../src/components/StatusPill';
import {
  HarnessNotConfigured,
  useAgents,
  useIdeas,
  type AgentSession,
  type IdeaSummary,
} from '../src/lib/mcp';
import { colors, pressedOpacity, radius, space } from '../src/lib/theme';
import { timeAgo } from '../src/lib/time';

const GROUP_ORDER = [
  'needs-critic-review',
  'needs-detail',
  'brainstormed',
  'accepted',
  'building',
  'pr-open',
  'captured',
  'shipped',
  'rejected',
];

type Section = { title: string; data: IdeaSummary[] };

export default function InboxScreen() {
  const { data, isLoading, error, refetch, isRefetching } = useIdeas();
  const { data: agentsData, refetch: refetchAgents } = useAgents();
  const [refreshSeq, setRefreshSeq] = useState(0);

  // Re-fetch on screen focus so an accept/reject from Detail reflects when
  // the user pops back.
  useFocusEffect(
    useCallback(() => {
      void refetch();
      void refetchAgents();
    }, [refreshSeq, refetch, refetchAgents])
  );

  const liveAgents = (agentsData?.agents ?? []).filter(
    a => a.status === 'running' || a.status === 'blocked'
  );

  const sections = useMemo<Section[]>(() => {
    const byStatus = new Map<string, IdeaSummary[]>();
    for (const idea of data?.ideas ?? []) {
      const arr = byStatus.get(idea.status) ?? [];
      arr.push(idea);
      byStatus.set(idea.status, arr);
    }
    // Within a group, most-recently-touched first — triage by recency.
    const byRecency = (a: IdeaSummary, b: IdeaSummary) =>
      Date.parse(b.last_touched ?? '') - Date.parse(a.last_touched ?? '') || 0;
    const ordered: Section[] = [];
    for (const status of GROUP_ORDER) {
      const rows = byStatus.get(status);
      if (rows?.length) ordered.push({ title: status, data: [...rows].sort(byRecency) });
    }
    for (const status of Array.from(byStatus.keys()).sort()) {
      if (!GROUP_ORDER.includes(status)) {
        ordered.push({ title: status, data: [...byStatus.get(status)!].sort(byRecency) });
      }
    }
    return ordered;
  }, [data]);

  const headerRight = useMemo(
    () => () => (
      <Link href="/settings" asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          accessibilityHint="Configure the harness URL and token"
          hitSlop={12}
          style={pressedOpacity}
        >
          <Text style={styles.headerLink}>⚙</Text>
        </Pressable>
      </Link>
    ),
    []
  );

  if (error instanceof HarnessNotConfigured) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Not configured yet</Text>
          <Text style={styles.emptyBody}>
            Point the app at your Mac&apos;s Tailscale URL and paste the bearer token to start
            triaging ideas.
          </Text>
          <Link href="/settings" asChild>
            <Pressable
              style={({ pressed }) => [styles.button, pressedOpacity({ pressed })]}
              accessibilityRole="button"
              accessibilityLabel="Open Settings"
            >
              <Text style={styles.buttonText}>Open Settings</Text>
            </Pressable>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ headerRight }} />
      {isLoading ? (
        <Loading label="Loading ideas…" />
      ) : error ? (
        <ErrorState
          title="Couldn't load ideas"
          message={(error as Error).message}
          onRetry={() => setRefreshSeq(s => s + 1)}
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={item => item.slug}
          stickySectionHeadersEnabled
          contentContainerStyle={sections.length === 0 ? styles.flexGrow : undefined}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>
              {section.title} · {section.data.length}
            </Text>
          )}
          renderItem={({ item }) => <IdeaRow idea={item} />}
          SectionSeparatorComponent={() => <View style={styles.sectionGap} />}
          ListHeaderComponent={
            liveAgents.length > 0 ? (
              <View style={styles.agentSection}>
                <Text style={styles.sectionHeaderPlain}>active sessions · {liveAgents.length}</Text>
                {liveAgents.map((a, idx) => (
                  <AgentRow key={a.id ?? `agent-${idx}`} agent={a} />
                ))}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No ideas in flight</Text>
              <Text style={styles.emptyBody}>
                Pull to refresh, or capture one from the phone — it lands here once the harvest cron
                picks it up.
              </Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => {
                void refetch();
                void refetchAgents();
              }}
              tintColor={colors.textSecondary}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

function AgentRow({ agent }: { agent: AgentSession }) {
  const running = agent.status === 'running';
  return (
    <View
      style={styles.agentRow}
      accessible
      accessibilityLabel={`${agent.status} session: ${agent.summary || 'no summary'}`}
    >
      <View style={[styles.agentDot, running ? styles.agentDotRun : styles.agentDotBlocked]} />
      <View style={styles.agentBody}>
        <Text style={styles.agentSummary} numberOfLines={2}>
          {agent.summary || '(no summary)'}
        </Text>
        <Text style={styles.agentMeta} numberOfLines={1}>
          {agent.status}
          {agent.cwd ? ` · ${agent.cwd}` : ''}
        </Text>
      </View>
    </View>
  );
}

function IdeaRow({ idea }: { idea: IdeaSummary }) {
  const touched = timeAgo(idea.last_touched);
  return (
    <Link href={{ pathname: '/idea/[slug]', params: { slug: idea.slug } }} asChild>
      <Pressable
        style={({ pressed }) => [styles.row, pressedOpacity({ pressed })]}
        accessibilityRole="button"
        accessibilityLabel={`${idea.title}. ${idea.status}${idea.project ? `, project ${idea.project}` : ''}`}
        accessibilityHint="Opens idea detail"
      >
        <View style={styles.rowMeta}>
          <Text style={styles.project}>[{idea.project ?? '?'}]</Text>
          {idea.score != null && <Text style={styles.score}>· score {idea.score}</Text>}
          {touched ? <Text style={styles.touched}>· {touched}</Text> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {idea.title}
        </Text>
        <StatusPill status={idea.status} />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  flexGrow: { flexGrow: 1 },
  sectionHeader: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
  },
  sectionHeaderPlain: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: space.sm,
  },
  sectionGap: { height: space.xs },
  agentSection: { paddingHorizontal: space.lg, paddingTop: space.md },
  row: {
    marginHorizontal: space.lg,
    padding: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginBottom: space.sm,
    gap: space.xs + 2,
  },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, flexWrap: 'wrap' },
  project: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  score: { color: colors.textSecondary, fontSize: 12 },
  touched: { color: colors.textSecondary, fontSize: 12 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.xxl,
    gap: space.md,
  },
  emptyTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '600' },
  emptyBody: { color: colors.textSecondary, textAlign: 'center', fontSize: 14, lineHeight: 20 },
  button: {
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    marginTop: space.md,
  },
  buttonText: { color: colors.textPrimary, fontWeight: '600' },
  headerLink: { color: colors.textPrimary, fontSize: 20, paddingHorizontal: space.sm },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginBottom: space.sm,
    gap: space.md,
  },
  agentDot: { width: 10, height: 10, borderRadius: 5 },
  agentDotRun: { backgroundColor: colors.success },
  agentDotBlocked: { backgroundColor: colors.warn },
  agentBody: { flex: 1, gap: 2 },
  agentSummary: { color: colors.textPrimary, fontSize: 14, fontWeight: '500' },
  agentMeta: { color: colors.textSecondary, fontSize: 12 },
});
