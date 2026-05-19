import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ErrorState, Loading } from '../src/components/States';
import {
  HarnessNotConfigured,
  useAgents,
  useIdeas,
  type AgentSession,
  type IdeaSummary,
} from '../src/lib/mcp';
import { colors, pressedOpacity, radius, space, statusColors } from '../src/lib/theme';
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

// Statuses that are waiting on Taylor — surfaced in the summary + header accent.
const ACTIONABLE = new Set(['needs-detail', 'needs-critic-review']);

type Section = { title: string; data: IdeaSummary[] };

const prettyStatus = (s: string) =>
  s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

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
    (a) => a.status === 'running' || a.status === 'blocked'
  );

  const ideas = data?.ideas ?? [];
  const actionableCount = ideas.filter((i) => ACTIONABLE.has(i.status)).length;

  const sections = useMemo<Section[]>(() => {
    const byStatus = new Map<string, IdeaSummary[]>();
    for (const idea of ideas) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const headerRight = useMemo(
    () => () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        accessibilityHint="Configure the harness URL and token"
        hitSlop={12}
        onPress={() => router.push('/settings')}
        style={pressedOpacity}
      >
        <Text style={styles.headerLink}>⚙</Text>
      </Pressable>
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
          <Pressable
            style={({ pressed }) => [styles.button, pressedOpacity({ pressed })]}
            accessibilityRole="button"
            accessibilityLabel="Open Settings"
            onPress={() => router.push('/settings')}
          >
            <Text style={styles.buttonText}>Open Settings</Text>
          </Pressable>
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
          onRetry={() => setRefreshSeq((s) => s + 1)}
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.slug}
          stickySectionHeadersEnabled
          contentContainerStyle={sections.length === 0 ? styles.flexGrow : styles.listPad}
          renderSectionHeader={({ section }) => (
            <SectionHeader title={section.title} count={section.data.length} />
          )}
          renderItem={({ item }) => <IdeaRow idea={item} />}
          ItemSeparatorComponent={() => <View style={styles.rowGap} />}
          ListHeaderComponent={
            <ListHeader
              total={ideas.length}
              actionable={actionableCount}
              agents={liveAgents}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Inbox zero 🎉</Text>
              <Text style={styles.emptyBody}>
                No ideas in flight. Pull to refresh, or capture one from the phone — it lands here
                once the harvest cron picks it up.
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

function ListHeader({
  total,
  actionable,
  agents,
}: {
  total: number;
  actionable: number;
  agents: AgentSession[];
}) {
  if (total === 0 && agents.length === 0) return null;
  return (
    <View>
      {total > 0 && (
        <View style={styles.summary} accessibilityRole="summary">
          <Text style={styles.summaryCount}>
            {total} idea{total === 1 ? '' : 's'}
          </Text>
          {actionable > 0 ? (
            <View style={styles.summaryBadge}>
              <View style={styles.summaryDot} />
              <Text style={styles.summaryBadgeText}>{actionable} need you</Text>
            </View>
          ) : (
            <Text style={styles.summaryClear}>nothing waiting on you</Text>
          )}
        </View>
      )}
      {agents.length > 0 && (
        <View style={styles.agentBlock}>
          <Text style={styles.agentBlockTitle}>LIVE SESSIONS · {agents.length}</Text>
          {agents.map((a, idx) => (
            <AgentRow key={a.id ?? `agent-${idx}`} agent={a} />
          ))}
        </View>
      )}
    </View>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  const color = statusColors[title] ?? colors.border;
  const isAction = ACTIONABLE.has(title);
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionDot, { backgroundColor: color }]} />
      <Text style={styles.sectionTitle}>{prettyStatus(title)}</Text>
      {isAction && <Text style={styles.sectionFlag}>NEEDS YOU</Text>}
      <View style={styles.sectionCount}>
        <Text style={styles.sectionCountText}>{count}</Text>
      </View>
    </View>
  );
}

function AgentRow({ agent }: { agent: AgentSession }) {
  const running = agent.status === 'running';
  const accent = running ? colors.success : colors.warn;
  return (
    <View
      style={[styles.agentRow, { borderLeftColor: accent }]}
      accessible
      accessibilityLabel={`${agent.status} session: ${agent.summary || 'no summary'}`}
    >
      <Text style={styles.agentSummary} numberOfLines={2}>
        {agent.summary || '(no summary)'}
      </Text>
      <View style={styles.agentMetaRow}>
        <Text style={[styles.agentStatus, { color: accent }]}>{agent.status.toUpperCase()}</Text>
        {agent.cwd ? (
          <Text style={styles.agentCwd} numberOfLines={1}>
            {agent.cwd}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function IdeaRow({ idea }: { idea: IdeaSummary }) {
  const touched = timeAgo(idea.last_touched);
  const color = statusColors[idea.status] ?? colors.border;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/idea/[slug]', params: { slug: idea.slug } })}
      style={({ pressed }) => [styles.row, { borderLeftColor: color }, pressedOpacity({ pressed })]}
      accessibilityRole="button"
      accessibilityLabel={`${idea.title}. ${idea.status}${idea.project ? `, project ${idea.project}` : ''}`}
      accessibilityHint="Opens idea detail"
    >
      <View style={styles.rowBody}>
        <Text style={styles.title} numberOfLines={2}>
          {idea.title}
        </Text>
        <View style={styles.rowMeta}>
          <View style={styles.projectChip}>
            <Text style={styles.projectChipText}>{idea.project ?? 'unrouted'}</Text>
          </View>
          {idea.score != null && (
            <View style={styles.scoreChip}>
              <Text style={styles.scoreChipText}>★ {idea.score}</Text>
            </View>
          )}
          {touched ? <Text style={styles.touched}>{touched}</Text> : null}
        </View>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  flexGrow: { flexGrow: 1 },
  listPad: { paddingBottom: space.xxl },

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  summaryCount: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  summaryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    backgroundColor: 'rgba(245,158,11,0.14)',
    borderColor: colors.warn,
    borderWidth: 1,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
  },
  summaryDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.warn },
  summaryBadgeText: { color: colors.warn, fontSize: 12, fontWeight: '700' },
  summaryClear: { color: colors.textSecondary, fontSize: 12 },

  agentBlock: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: space.sm,
  },
  agentBlockTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  agentRow: {
    borderLeftWidth: 3,
    paddingLeft: space.md,
    paddingVertical: space.xs + 2,
    gap: 3,
  },
  agentSummary: { color: colors.textPrimary, fontSize: 14, fontWeight: '500' },
  agentMetaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  agentStatus: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  agentCwd: { color: colors.textMuted, fontSize: 11, flex: 1 },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sectionDot: { width: 9, height: 9, borderRadius: 5 },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  sectionFlag: {
    color: colors.warn,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  sectionCount: {
    marginLeft: 'auto',
    minWidth: 22,
    paddingHorizontal: space.xs + 2,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  sectionCountText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.lg,
    paddingVertical: space.md,
    paddingRight: space.sm,
    paddingLeft: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  rowBody: { flex: 1, gap: space.sm },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  projectChip: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  projectChipText: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  scoreChip: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  scoreChipText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  touched: { color: colors.textMuted, fontSize: 12 },
  chevron: { color: colors.textMuted, fontSize: 22, fontWeight: '300', paddingLeft: space.sm },
  rowGap: { height: space.sm },

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
});
