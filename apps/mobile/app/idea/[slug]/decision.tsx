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
import { useDecide, useIdea, useReject } from '../../../src/lib/mcp';
import { colors, pressedOpacity, radius, space } from '../../../src/lib/theme';

// Decision screen for ideas at status `needs-detail`. Pulls the brainstorm's
// Variants + Open Question and lets the operator *steer* the idea: pick a
// variant and/or write a decision. Submitting writes a structured
// `## Decision` block + sets `decided_at` and flips status to brainstormed
// (the build cron then picks it up). Reject archives it.

export default function DecisionScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error, refetch, isRefetching } = useIdea(slug);
  const decide = useDecide();
  const reject = useReject();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [variant, setVariant] = useState<string | null>(null);

  const sections = useMemo(() => splitBody(data?.body ?? ''), [data?.body]);
  const variantOptions = useMemo(
    () => parseVariants(sections['Variants'] ?? ''),
    [sections]
  );

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
  const trimmed = text.trim();
  const canSubmit = (!!trimmed || !!variant) && !busy;

  const submitDecision = () => {
    if (!trimmed && !variant) {
      Alert.alert('Nothing to submit', 'Pick a variant or write a decision first.');
      return;
    }
    setBusy(true);
    decide.mutate(
      {
        slug: data.slug,
        ...(trimmed ? { decision: trimmed } : {}),
        ...(variant ? { variant } : {}),
      },
      {
        onSettled: () => setBusy(false),
        onSuccess: () => router.back(),
        onError: (err: unknown) => Alert.alert('Decision failed', (err as Error).message),
      }
    );
  };

  const confirmReject = () =>
    Alert.alert('Reject this idea?', 'Archived but not deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          reject.mutate(
            { slug: data.slug, ...(trimmed ? { note: trimmed } : {}) },
            {
              onSettled: () => setBusy(false),
              onSuccess: () => router.back(),
              onError: (err: unknown) => Alert.alert('Reject failed', (err as Error).message),
            }
          );
        },
      },
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
              No Open Question section — submitting still records a Decision, sets decided_at,
              and unblocks the build cron.
            </Text>
          )}

          {variantOptions.length > 0 && (
            <View style={styles.pickWrap}>
              <Text style={styles.label}>Choose a variant</Text>
              <View style={styles.chips}>
                {variantOptions.map((v) => {
                  const selected = variant === v.n;
                  return (
                    <Pressable
                      key={v.n}
                      onPress={() => setVariant(selected ? null : v.n)}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.chip,
                        selected && styles.chipOn,
                        pressedOpacity({ pressed }),
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Variant ${v.n}: ${v.label}`}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextOn]} numberOfLines={2}>
                        {v.n}. {v.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          <Text style={styles.label}>
            Decision{variantOptions.length > 0 ? ' / rationale' : ''}
            {variant ? '' : ' (or pick a variant above)'}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="The call, a constraint, what to optimize for…"
            placeholderTextColor={colors.border}
            multiline
            style={styles.noteInput}
            accessibilityLabel="Decision text"
            editable={!busy}
          />
          <Text style={styles.noteHint}>
            Written to a structured ## Decision block; sets decided_at and moves the idea to
            brainstormed so the build cron picks it up.
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
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.button,
                styles.acceptButton,
                !canSubmit && styles.disabled,
                pressedOpacity({ pressed }),
              ]}
              onPress={submitDecision}
              accessibilityRole="button"
              accessibilityLabel="Submit decision"
              accessibilityState={{ disabled: !canSubmit }}
            >
              <Text style={styles.acceptText}>{busy ? '…' : 'Submit decision'}</Text>
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

// parseVariants — turn the Variants section's bullets into pick options.
// `n` is the 1-based index (the server mirrors `variant N` into ## Notes,
// which is exactly what the builder scrapes to override BUILD_VARIANT).
function parseVariants(md: string): { n: string; label: string }[] {
  const out: { n: string; label: string }[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (!m) continue;
    const label = m[1]
      .replace(/\*\*/g, '')
      .replace(/^\s*variant\s*\d+\s*[:\-—]\s*/i, '')
      .trim();
    if (label) out.push({ n: String(out.length + 1), label });
  }
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
  pickWrap: { gap: space.sm },
  label: { color: colors.textPrimary, fontWeight: '600', fontSize: 14 },
  chips: { gap: space.sm },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
  },
  chipOn: { borderColor: colors.success, backgroundColor: 'rgba(34,197,94,0.12)' },
  chipText: { color: colors.textSecondary, fontSize: 14 },
  chipTextOn: { color: colors.textPrimary, fontWeight: '600' },
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
