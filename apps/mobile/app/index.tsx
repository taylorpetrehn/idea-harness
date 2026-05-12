import { Link, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatusPill } from '../src/components/StatusPill';
import { HarnessNotConfigured, useIdeas, type IdeaSummary } from '../src/lib/mcp';

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
  const [refreshSeq, setRefreshSeq] = useState(0);

  // Re-fetch on screen focus so an accept/reject from Detail reflects when
  // the user pops back.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refreshSeq, refetch])
  );

  const sections = useMemo<Section[]>(() => {
    const byStatus = new Map<string, IdeaSummary[]>();
    for (const idea of data?.ideas ?? []) {
      const arr = byStatus.get(idea.status) ?? [];
      arr.push(idea);
      byStatus.set(idea.status, arr);
    }
    const ordered: Section[] = [];
    for (const status of GROUP_ORDER) {
      const rows = byStatus.get(status);
      if (rows?.length) ordered.push({ title: status, data: rows });
    }
    for (const status of Array.from(byStatus.keys()).sort()) {
      if (!GROUP_ORDER.includes(status)) {
        ordered.push({ title: status, data: byStatus.get(status)! });
      }
    }
    return ordered;
  }, [data]);

  if (error instanceof HarnessNotConfigured) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Not configured yet</Text>
          <Text style={styles.emptyBody}>Open Settings to point the app at your Mac's Tailscale URL and paste the bearer token.</Text>
          <Link href="/settings" asChild>
            <Pressable style={styles.button}>
              <Text style={styles.buttonText}>Open Settings</Text>
            </Pressable>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" asChild>
              <Pressable accessibilityRole="button" accessibilityLabel="Settings">
                <Text style={styles.headerLink}>⚙</Text>
              </Pressable>
            </Link>
          ),
        }}
      />
      {isLoading ? (
        <View style={styles.empty}><ActivityIndicator color="#94a3b8" /></View>
      ) : error ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Couldn't load ideas</Text>
          <Text style={styles.emptyBody}>{(error as Error).message}</Text>
          <Pressable style={styles.button} onPress={() => setRefreshSeq(s => s + 1)}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={sections}
          keyExtractor={s => s.title}
          renderItem={({ item: section }) => (
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>
                {section.title} · {section.data.length}
              </Text>
              {section.data.map(idea => (
                <IdeaRow key={idea.slug} idea={idea} />
              ))}
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No ideas in flight</Text>
            </View>
          }
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor="#94a3b8" />
          }
        />
      )}
    </SafeAreaView>
  );
}

function IdeaRow({ idea }: { idea: IdeaSummary }) {
  return (
    <Link href={{ pathname: '/idea/[slug]', params: { slug: idea.slug } }} asChild>
      <Pressable style={styles.row}>
        <View style={styles.rowMeta}>
          <Text style={styles.project}>[{idea.project ?? '?'}]</Text>
          {idea.score != null && <Text style={styles.score}>· score {idea.score}</Text>}
        </View>
        <Text style={styles.title} numberOfLines={2}>{idea.title}</Text>
        <StatusPill status={idea.status} />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  section: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  sectionHeader: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  row: {
    padding: 12,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    marginBottom: 8,
    gap: 6,
  },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  project: { color: '#a5b4fc', fontSize: 12, fontWeight: '600' },
  score: { color: '#64748b', fontSize: 12 },
  title: { color: '#f8fafc', fontSize: 15, fontWeight: '500' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  emptyTitle: { color: '#f8fafc', fontSize: 18, fontWeight: '600' },
  emptyBody: { color: '#94a3b8', textAlign: 'center', fontSize: 14 },
  button: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    marginTop: 12,
  },
  buttonText: { color: '#f8fafc', fontWeight: '600' },
  headerLink: { color: '#f8fafc', fontSize: 18, paddingHorizontal: 8 },
});
