import { Link, Stack, useLocalSearchParams, router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatusPill } from '../../../src/components/StatusPill';
import { useAccept, useIdea, useReject } from '../../../src/lib/mcp';

export default function IdeaDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error } = useIdea(slug);
  const accept = useAccept();
  const reject = useReject();
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);

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
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Couldn't load idea</Text>
          <Text style={styles.errorBody}>{error?.message ?? 'unknown'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const onAccept = () => {
    Alert.alert('Accept this idea?', 'Flips status to brainstormed. The build cron picks it up next tick.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Accept',
        onPress: () => {
          setBusy('accept');
          accept.mutate(
            { slug: data.slug },
            {
              onSettled: () => setBusy(null),
              onSuccess: () => router.back(),
              onError: (err: unknown) => Alert.alert('Accept failed', (err as Error).message),
            }
          );
        },
      },
    ]);
  };

  const onReject = () => {
    Alert.alert('Reject this idea?', 'Archived but not deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: () => {
          setBusy('reject');
          reject.mutate(
            { slug: data.slug },
            {
              onSettled: () => setBusy(null),
              onSuccess: () => router.back(),
              onError: (err: unknown) => Alert.alert('Reject failed', (err as Error).message),
            }
          );
        },
      },
    ]);
  };

  const isNeedsDetail = data.status === 'needs-detail';
  const isPrOpen = data.status === 'pr-open' || data.status === 'shipped';
  const canAct = ['captured', 'brainstormed', 'needs-detail', 'needs-critic-review'].includes(data.status);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: data.project ? `${data.project}` : 'Idea' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>{data.title}</Text>
        <View style={styles.metaRow}>
          <StatusPill status={data.status} />
          {data.score != null && <Text style={styles.meta}>score {data.score}</Text>}
          <Text style={styles.meta}>{data.slug}</Text>
        </View>

        {isNeedsDetail && (
          <Link href={{ pathname: '/idea/[slug]/decision', params: { slug: data.slug } }} asChild>
            <Pressable style={[styles.cta, { backgroundColor: '#f59e0b' }]}>
              <Text style={styles.ctaText}>Open Decision →</Text>
            </Pressable>
          </Link>
        )}
        {isPrOpen && (
          <Link href={{ pathname: '/idea/[slug]/pr', params: { slug: data.slug } }} asChild>
            <Pressable style={[styles.cta, { backgroundColor: '#8b5cf6' }]}>
              <Text style={styles.ctaText}>PR Status →</Text>
            </Pressable>
          </Link>
        )}

        <Text style={styles.body}>{data.body || '(empty body)'}</Text>
      </ScrollView>

      {canAct && (
        <View style={styles.actionBar}>
          <Pressable
            onPress={onReject}
            style={[styles.actionButton, styles.rejectButton]}
            disabled={busy !== null}
          >
            <Text style={styles.actionText}>
              {busy === 'reject' ? '…' : 'Reject'}
            </Text>
          </Pressable>
          <Pressable
            onPress={onAccept}
            style={[styles.actionButton, styles.acceptButton]}
            disabled={busy !== null}
          >
            <Text style={styles.actionText}>
              {busy === 'accept' ? '…' : 'Accept'}
            </Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scroll: { padding: 16, gap: 12 },
  title: { color: '#f8fafc', fontSize: 22, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  meta: { color: '#94a3b8', fontSize: 12 },
  body: {
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 22,
    fontFamily: 'Menlo',
    marginTop: 12,
  },
  cta: { padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  ctaText: { color: '#0f172a', fontWeight: '700' },
  actionBar: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#334155',
    backgroundColor: '#1e293b',
  },
  actionButton: { flex: 1, padding: 14, borderRadius: 8, alignItems: 'center' },
  acceptButton: { backgroundColor: '#22c55e' },
  rejectButton: { backgroundColor: '#475569' },
  actionText: { color: '#f8fafc', fontWeight: '700' },
  errorBox: { padding: 32, alignItems: 'center', gap: 8 },
  errorTitle: { color: '#f8fafc', fontSize: 18, fontWeight: '600' },
  errorBody: { color: '#94a3b8', textAlign: 'center' },
});
