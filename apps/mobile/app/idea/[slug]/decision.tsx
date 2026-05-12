import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
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

import { useAccept, useIdea, useReject } from '../../../src/lib/mcp';

// Decision screen for ideas at status `needs-detail`.
// Pulls the brainstorm's Variants + Open Question, lets the operator
// accept (with a note) or reject. The harness uses `decided_at` as the
// unblock signal; the note is appended to the idea's Notes section.

export default function DecisionScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, error } = useIdea(slug);
  const accept = useAccept();
  const reject = useReject();
  const [busy, setBusy] = useState(false);

  const sections = useMemo(() => splitBody(data?.body ?? ''), [data?.body]);

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

  const openQuestion = sections['Open Question'] ?? sections['Open Questions'];
  const variants = sections['Variants'];
  const problem = sections['Problem'];

  const decide = (action: 'accept' | 'reject', note?: string) => {
    setBusy(true);
    const mut = action === 'accept' ? accept : reject;
    mut.mutate(
      { slug: data.slug, ...(note ? { note } : {}) },
      {
        onSettled: () => setBusy(false),
        onSuccess: () => router.back(),
        onError: (err: unknown) => Alert.alert(action + ' failed', (err as Error).message),
      }
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>{data.title}</Text>

        {problem && <Section title="Problem">{problem}</Section>}
        {variants && <Section title="Variants">{variants}</Section>}
        {openQuestion ? (
          <Section title="Open question" highlight>
            {openQuestion}
          </Section>
        ) : (
          <Text style={styles.hint}>
            This idea is at needs-detail but has no Open Question section. Accept will set decided_at and unblock the build cron.
          </Text>
        )}

        <View style={styles.actions}>
          <Pressable
            disabled={busy}
            style={[styles.button, styles.rejectButton]}
            onPress={() =>
              Alert.alert('Reject', 'Confirm reject?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Reject', style: 'destructive', onPress: () => decide('reject') },
              ])
            }
          >
            <Text style={styles.buttonText}>Reject</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            style={[styles.button, styles.acceptButton]}
            onPress={() =>
              Alert.prompt(
                'Accept with note',
                'Optional: note describing the decision (variant chosen, constraint, etc).',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Accept',
                    onPress: (note?: string) => decide('accept', note || undefined),
                  },
                ],
                'plain-text'
              )
            }
          >
            <Text style={styles.buttonText}>{busy ? '…' : 'Accept'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children, highlight }: { title: string; children: string; highlight?: boolean }) {
  return (
    <View style={[styles.section, highlight && styles.sectionHighlight]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionBody}>{children.trim()}</Text>
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
    const m = /^##\s+(.+?)\s*$/.exec(line);
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
  container: { flex: 1, backgroundColor: '#0f172a' },
  scroll: { padding: 16, gap: 16 },
  title: { color: '#f8fafc', fontSize: 20, fontWeight: '700' },
  section: { padding: 12, backgroundColor: '#1e293b', borderRadius: 10, gap: 8 },
  sectionHighlight: { borderColor: '#f59e0b', borderWidth: 2 },
  sectionTitle: { color: '#a5b4fc', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionBody: { color: '#e2e8f0', fontSize: 14, lineHeight: 20 },
  hint: { color: '#64748b', fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  button: { flex: 1, padding: 14, borderRadius: 8, alignItems: 'center' },
  acceptButton: { backgroundColor: '#22c55e' },
  rejectButton: { backgroundColor: '#475569' },
  buttonText: { color: '#f8fafc', fontWeight: '700' },
  error: { color: '#ef4444', padding: 32, textAlign: 'center' },
});
