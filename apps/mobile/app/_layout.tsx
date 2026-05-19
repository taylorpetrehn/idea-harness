import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { colors } from '../src/lib/theme';

export default function RootLayout() {
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 15_000,
            refetchOnReconnect: true,
          },
        },
      }),
    []
  );

  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <SafeAreaProvider>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.textPrimary,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="index" options={{ title: 'Inbox' }} />
            <Stack.Screen name="settings" options={{ title: 'Settings', presentation: 'modal' }} />
            <Stack.Screen name="idea/[slug]" options={{ title: 'Idea' }} />
            <Stack.Screen
              name="idea/[slug]/decision"
              options={{ title: 'Decision', presentation: 'modal' }}
            />
            <Stack.Screen name="idea/[slug]/pr" options={{ title: 'PR Status' }} />
          </Stack>
          <StatusBar style="light" />
        </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
