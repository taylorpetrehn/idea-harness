import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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
    <QueryClientProvider client={client}>
      <SafeAreaProvider>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: '#0f172a' },
            headerTintColor: '#f8fafc',
            contentStyle: { backgroundColor: '#0f172a' },
          }}
        >
          <Stack.Screen name="index" options={{ title: 'Inbox' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings', presentation: 'modal' }} />
          <Stack.Screen name="idea/[slug]" options={{ title: 'Idea' }} />
          <Stack.Screen name="idea/[slug]/decision" options={{ title: 'Decision', presentation: 'modal' }} />
          <Stack.Screen name="idea/[slug]/pr" options={{ title: 'PR Status' }} />
        </Stack>
        <StatusBar style="light" />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
