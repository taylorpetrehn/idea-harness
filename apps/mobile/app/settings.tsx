import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
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

import { clearConfig, getConfig, setConfig } from '../src/lib/config';
import { pingWith } from '../src/lib/mcp';

export default function SettingsScreen() {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const cfg = await getConfig();
      if (cfg) {
        setBaseUrl(cfg.baseUrl);
        setToken(cfg.token);
      }
      setLoaded(true);
    })();
  }, []);

  const test = async () => {
    if (!baseUrl || !token) {
      Alert.alert('Missing fields', 'Enter both URL and token first.');
      return;
    }
    setTesting(true);
    try {
      await pingWith({ baseUrl, token });
      Alert.alert('Connected', 'Harness MCP responded successfully.');
    } catch (err) {
      Alert.alert('Connection failed', (err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!baseUrl || !token) {
      Alert.alert('Missing fields', 'Enter both URL and token first.');
      return;
    }
    await setConfig({ baseUrl: baseUrl.trim(), token: token.trim() });
    router.back();
  };

  const reset = async () => {
    await clearConfig();
    setBaseUrl('');
    setToken('');
  };

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#94a3b8" />
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.label}>Harness URL</Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder="https://taylor-mac.tail-scale.ts.net"
            placeholderTextColor="#475569"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />
          <Text style={styles.hint}>
            Your Mac's Tailscale hostname (or tailnet IP). Don't include the /rpc path.
          </Text>

          <Text style={[styles.label, { marginTop: 24 }]}>Bearer token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="paste from ~/.secrets/harness-mobile-token"
            placeholderTextColor="#475569"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />
          <Text style={styles.hint}>
            Generate on the Mac with `harness mcp serve --http --token-file ~/.secrets/harness-mobile-token --generate-token`.
          </Text>

          <View style={styles.actions}>
            <Pressable style={[styles.button, styles.testButton]} onPress={test} disabled={testing}>
              <Text style={styles.buttonText}>{testing ? 'Testing…' : 'Test connection'}</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={save}>
              <Text style={styles.buttonText}>Save</Text>
            </Pressable>
          </View>

          <Pressable style={styles.resetButton} onPress={reset}>
            <Text style={styles.resetText}>Clear saved config</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scroll: { padding: 16, gap: 8 },
  label: { color: '#f8fafc', fontWeight: '600', fontSize: 14 },
  input: {
    backgroundColor: '#1e293b',
    color: '#f8fafc',
    padding: 12,
    borderRadius: 8,
    fontSize: 15,
  },
  hint: { color: '#64748b', fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 24 },
  button: {
    flex: 1,
    backgroundColor: '#3b82f6',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  testButton: { backgroundColor: '#475569' },
  buttonText: { color: '#f8fafc', fontWeight: '600' },
  resetButton: { alignItems: 'center', padding: 16, marginTop: 16 },
  resetText: { color: '#ef4444', fontSize: 13 },
});
