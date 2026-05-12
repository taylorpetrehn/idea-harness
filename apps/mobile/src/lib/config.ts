/**
 * Persistent harness URL + token storage backed by expo-secure-store.
 * The token never lives in plain AsyncStorage; the URL travels with it
 * (low-stakes but symmetric).
 */

import * as SecureStore from 'expo-secure-store';

const KEY_URL = 'harness.baseUrl';
const KEY_TOKEN = 'harness.token';

export type HarnessConfig = {
  baseUrl: string;
  token: string;
};

export async function getConfig(): Promise<HarnessConfig | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(KEY_URL),
    SecureStore.getItemAsync(KEY_TOKEN),
  ]);
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export async function setConfig(cfg: HarnessConfig): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEY_URL, cfg.baseUrl),
    SecureStore.setItemAsync(KEY_TOKEN, cfg.token),
  ]);
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_URL),
    SecureStore.deleteItemAsync(KEY_TOKEN),
  ]);
}
