/**
 * App-wide error boundary. A render throw (e.g. a malformed idea body, or
 * the old Android `Alert.prompt` crash) previously took the whole app to a
 * redbox / blank screen with no way back. This catches it and offers a
 * reset so the operator isn't stranded mid-triage.
 */

import { Component, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, pressedOpacity, radius, space } from '../lib/theme';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.title}>The app hit an error</Text>
          <Text style={styles.body}>{error.message || String(error)}</Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressedOpacity({ pressed })]}
            onPress={this.reset}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: space.xxl, gap: space.md },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  body: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  button: {
    marginTop: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
  },
  buttonText: { color: colors.textPrimary, fontWeight: '600' },
});
