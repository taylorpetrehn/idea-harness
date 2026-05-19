import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Markdown } from '../../../src/components/Markdown';
import { ErrorState, Loading } from '../../../src/components/States';
import { StatusPill } from '../../../src/components/StatusPill';
import { useAccept, useIdea, useReject } from '../../../src/lib/mcp';
import { colors, pressedOpacity, radius, space } from '../../../src/lib/theme';

// Decision screen for ideas at status `needs-detail`.
// Pulls the brainstorm's Variants + Open Question, lets the operator
// accept (with a note) or reject. The harness uses `decided_at` as the
// unblock signal; the note is appended to the idea's Notes section.

export default function DecisionScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error, refetch, isRefetching } = useIdea(slug);
  const accept = useAccept();
  const reject = useReject();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const sections = useMemo(() => splitBody(data?.body ?? ''), [data?.body]);

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
          message={error?.message ?? 'Idea not found.'}
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  const openQuestion = sections['Open Question'] ?? sections['Open Questions'];
  const variants = sections['Variants'];
  const problem = sections['Problem'];

  const decide = (action: 'accept' | 'reject') => {
    setBusy(true);
    const mut = action === 'accept' ? accept : reject;
    const trimmed = note.trim();
    mut.mutate(
      { slug: data.slug, ...(trimmed ? { note: trimmed } : {}) },
      {
        onSettled: () => setBusy(false),
        onSuccess: () => router.back(),
        onError: (err: unknown) => Alert.alert(`${action} failed`, (err as Error).message),
      }
    );
  };

  const confirmReject = () =>
    Alert.alert('Reject this idea?', 'Archived but not deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => decide('reject') },
    ]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => void refetch()}
              tintColor={colors.textSecondary}
            />
          }
        >
          <Text style={styles.title}>{data.title}</Text>
          <StatusPill status={data.status} />

          {problem && <Section title="Problem">{problem}</Section>}
          {variants && <Section title="Variants">{variants}</Section>}
          {openQuestion ? (
            <Section title="Open question" highlight>
              {openQuestion}
            </Section>
          ) : (
            <Text style={styles.hint}>
              This idea is at needs-detail but has no Open Question section. Accept will set
              decided_at and unblock the build cron.
            </Text>
          )}

          <Text style={styles.noteLabel}>Decision note (optional)</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Variant chosen, constraint, rationale…"
            placeholderTextColor={colors.border}
            multiline
            style={styles.noteInput}
            accessibilityLabel="Decision note"
            editable={!busy}
          />
          <Text style={styles.noteHint}>
            Appended to the idea&apos;s Notes section on accept or reject.
          </Text>

          <View style={styles.actions}>
            <Pressable
              disabled={busy}
              style={({ pressed }) => [
                styles.button,
                styles.rejectButton,
                busy && styles.disabled,
                pressedOpacity({ pressed }),
              ]}
              onPress={confirmReject}
              accessibilityRole="button"
              accessibilityLabel="Reject idea"
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.rejectText}>{busy ? '…' : 'Reject'}</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              style={({ pressed }) => [
                styles.button,
                styles.acceptButton,
                busy && styles.disabled,
                pressedOpacity({ pressed }),
              ]}
              onPress={() => decide('accept')}
              accessibilityRole="button"
              accessibilityLabel="Accept idea with note"
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.acceptText}>{busy ? '…' : 'Accept'}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function Section({
  title,
  children,
  highlight,
}: {
  title: string;
  children: string;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.section, highlight && styles.sectionHighlight]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Markdown>{children.trim()}</Markdown>
    </View>
  );
}

// splitBody — partition the markdown body into `## <heading>` sections.
function splitBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split('\n');
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) out[current] = buf.join('\n');
      current = m[1];
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) out[current] = buf.join('\n');
  return out;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.lg, gap: space.lg },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '700' },
  section: { padding: space.md, backgroundColor: colors.surface, borderRadius: radius.md, gap: space.sm },
  sectionHighlight: { borderColor: colors.warn, borderWidth: 2 },
  sectionTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  hint: { color: colors.textMuted, fontStyle: 'italic' },
  noteLabel: { color: colors.textPrimary, fontWeight: '600', fontSize: 14 },
  noteInput: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    padding: space.md,
    borderRadius: radius.sm,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  noteHint: { color: colors.textMuted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  button: {
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
