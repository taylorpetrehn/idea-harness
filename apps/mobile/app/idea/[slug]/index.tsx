import { Link, Stack, useLocalSearchParams, router } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Markdown } from '../../../src/components/Markdown';
import { ErrorState, Loading } from '../../../src/components/States';
import { StatusPill } from '../../../src/components/StatusPill';
import { useAccept, useIdea, useReject } from '../../../src/lib/mcp';
import { colors, pressedOpacity, radius, space } from '../../../src/lib/theme';
import { timeAgo } from '../../../src/lib/time';

export default function IdeaDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error, refetch, isRefetching } = useIdea(slug);
  const accept = useAccept();
  const reject = useReject();
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loading label="Loading idea…" />
      </SafeAreaView>
    );
  }
  if (error || !data) {
    return (
      <SafeAreaView style={styles.container}>
        <ErrorState
          title="Couldn't load idea"
          message={error?.message ?? 'unknown'}
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  const onAccept = () => {
    Alert.alert(
      'Accept this idea?',
      'Flips status to brainstormed. The build cron picks it up next tick.',
      [
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
      ]
    );
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
  const canAct = ['captured', 'brainstormed', 'needs-detail', 'needs-critic-review'].includes(
    data.status
  );
  const touched = timeAgo(data.last_touched);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: data.project ? `${data.project}` : 'Idea' }} />
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
          <StatusPill status={data.status} />
          {data.score != null && <Text style={styles.meta}>score {data.score}</Text>}
          {touched ? <Text style={styles.meta}>· {touched}</Text> : null}
          <Text style={styles.meta}>· {data.slug}</Text>
        </View>

        {isNeedsDetail && (
          <Link href={{ pathname: '/idea/[slug]/decision', params: { slug: data.slug } }} asChild>
            <Pressable
              style={({ pressed }) => [styles.cta, styles.ctaWarn, pressedOpacity({ pressed })]}
              accessibilityRole="button"
              accessibilityLabel="Open Decision"
              accessibilityHint="Resolve the open question for this idea"
            >
              <Text style={styles.ctaText}>Open Decision →</Text>
            </Pressable>
          </Link>
        )}
        {isPrOpen && (
          <Link href={{ pathname: '/idea/[slug]/pr', params: { slug: data.slug } }} asChild>
            <Pressable
              style={({ pressed }) => [styles.cta, styles.ctaPurple, pressedOpacity({ pressed })]}
              accessibilityRole="button"
              accessibilityLabel="PR Status"
              accessibilityHint="View the pull request for this idea"
            >
              <Text style={styles.ctaTextLight}>PR Status →</Text>
            </Pressable>
          </Link>
        )}

        <View style={styles.bodyWrap}>
          <Markdown>{data.body}</Markdown>
        </View>
      </ScrollView>

      {canAct && (
        <View style={styles.actionBar}>
          <Pressable
            onPress={onReject}
            style={({ pressed }) => [
              styles.actionButton,
              styles.rejectButton,
              busy !== null && styles.disabled,
              pressedOpacity({ pressed }),
            ]}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Reject idea"
            accessibilityState={{ disabled: busy !== null }}
          >
            <Text style={styles.rejectText}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</Text>
          </Pressable>
          <Pressable
            onPress={onAccept}
            style={({ pressed }) => [
              styles.actionButton,
              styles.acceptButton,
              busy !== null && styles.disabled,
              pressedOpacity({ pressed }),
            ]}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Accept idea"
            accessibilityState={{ disabled: busy !== null }}
          >
            <Text style={styles.acceptText}>{busy === 'accept' ? 'Accepting…' : 'Accept'}</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.lg, gap: space.md },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  meta: { color: colors.textSecondary, fontSize: 12 },
  bodyWrap: { marginTop: space.sm },
  cta: { padding: space.md + 2, borderRadius: radius.md, alignItems: 'center', marginTop: space.sm },
  ctaWarn: { backgroundColor: colors.warn },
  ctaPurple: { backgroundColor: colors.purple },
  ctaText: { color: colors.bg, fontWeight: '700' },
  ctaTextLight: { color: colors.textPrimary, fontWeight: '700' },
  actionBar: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionButton: {
    flex: 1,
    padding: space.md + 2,
    borderRadius: radius.sm,
    alignItems: 'center',
    borderWidth: 1,
  },
  acceptButton: { backgroundColor: colors.success, borderColor: colors.success },
  rejectButton: { backgroundColor: 'transparent', borderColor: colors.danger },
  acceptText: { color: colors.bg, fontWeight: '700' },
  rejectText: { color: colors.danger, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
