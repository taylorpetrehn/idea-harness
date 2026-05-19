import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Loading } from '../src/components/States';
import { clearConfig, getConfig, setConfig } from '../src/lib/config';
import { pingWith } from '../src/lib/mcp';
import { colors, pressedOpacity, radius, space } from '../src/lib/theme';

export default function SettingsScreen() {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [wasConfigured, setWasConfigured] = useState(false);

  useEffect(() => {
    void (async () => {
      const cfg = await getConfig();
      if (cfg) {
        setBaseUrl(cfg.baseUrl);
        setToken(cfg.token);
        setWasConfigured(true);
      }
      setLoaded(true);
    })();
  }, []);

  const normalized = () => ({ baseUrl: baseUrl.trim().replace(/\/+$/, ''), token: token.trim() });

  const test = async () => {
    const cfg = normalized();
    if (!cfg.baseUrl || !cfg.token) {
      Alert.alert('Missing fields', 'Enter both URL and token first.');
      return;
    }
    setTesting(true);
    try {
      await pingWith(cfg);
      Alert.alert('Connected', 'Harness MCP responded successfully.');
    } catch (err) {
      Alert.alert('Connection failed', (err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const persist = async (cfg: { baseUrl: string; token: string }) => {
    await setConfig(cfg);
    router.back();
  };

  // Save verifies the connection first so a broken config can't be saved
  // silently — but the operator can override (e.g. configuring offline).
  const save = async () => {
    const cfg = normalized();
    if (!cfg.baseUrl || !cfg.token) {
      Alert.alert('Missing fields', 'Enter both URL and token first.');
      return;
    }
    setSaving(true);
    try {
      await pingWith(cfg);
      await persist(cfg);
    } catch (err) {
      Alert.alert(
        "Couldn't reach the harness",
        `${(err as Error).message}\n\nSave anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', onPress: () => void persist(cfg) },
        ]
      );
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    Alert.alert('Clear saved config?', 'Removes the stored URL and token from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          void clearConfig();
          setBaseUrl('');
          setToken('');
          setWasConfigured(false);
        },
      },
    ]);
  };

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container}>
        <Loading label="Loading settings…" />
      </SafeAreaView>
    );
  }

  const busy = testing || saving;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={[styles.statusBanner, wasConfigured ? styles.statusOk : styles.statusWarn]}>
            <Text style={styles.statusText}>
              {wasConfigured ? '✓ Configured on this device' : 'Not configured yet'}
            </Text>
          </View>

          <Text style={styles.label}>Harness URL</Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder="https://taylor-mac.tail-scale.ts.net"
            placeholderTextColor={colors.border}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
            accessibilityLabel="Harness URL"
          />
          <Text style={styles.hint}>
            Your Mac&apos;s Tailscale hostname (or tailnet IP). Don&apos;t include the /rpc path.
          </Text>

          <Text style={[styles.label, { marginTop: space.xl }]}>Bearer token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="paste from ~/.secrets/harness-mobile-token"
            placeholderTextColor={colors.border}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
            accessibilityLabel="Bearer token"
          />
          <Text style={styles.hint}>
            Paste the contents of ~/.secrets/harness-mobile-token from your Mac (the token the
            harness MCP server authenticates against).
          </Text>

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [
                styles.button,
                styles.testButton,
                busy && styles.disabled,
                pressedOpacity({ pressed }),
              ]}
              onPress={test}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Test connection"
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.buttonText}>{testing ? 'Testing…' : 'Test connection'}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.button,
                busy && styles.disabled,
                pressedOpacity({ pressed }),
              ]}
              onPress={save}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Save settings"
              accessibilityHint="Verifies the connection, then saves"
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>

          {wasConfigured && (
            <Pressable
              style={({ pressed }) => [styles.resetButton, pressedOpacity({ pressed })]}
              onPress={reset}
              accessibilityRole="button"
              accessibilityLabel="Clear saved config"
            >
              <Text style={styles.resetText}>Clear saved config</Text>
            </Pressable>
          )}
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.lg, gap: space.sm },
  statusBanner: {
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginBottom: space.sm,
  },
  statusOk: { backgroundColor: 'rgba(34,197,94,0.12)', borderColor: colors.success },
  statusWarn: { backgroundColor: 'rgba(245,158,11,0.12)', borderColor: colors.warn },
  statusText: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  label: { color: colors.textPrimary, fontWeight: '600', fontSize: 14 },
  input: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    padding: space.md,
    borderRadius: radius.sm,
    fontSize: 15,
  },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xl },
  button: {
    flex: 1,
    backgroundColor: colors.primary,
    padding: space.md + 2,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  testButton: { backgroundColor: colors.border },
  buttonText: { color: colors.textPrimary, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  resetButton: { alignItems: 'center', padding: space.lg, marginTop: space.lg },
  resetText: { color: colors.danger, fontSize: 13 },
});
