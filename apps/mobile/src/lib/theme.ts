/**
 * Single source of truth for the dark palette + spacing tokens.
 * Screens and components import from here instead of hardcoding hex
 * literals, so a future NativeWind/theming pass (see README "deferred")
 * is a one-file change.
 */

import { Platform } from 'react-native';

export const colors = {
  bg: '#0f172a', // slate-900 — app background
  surface: '#1e293b', // slate-800 — cards / rows
  surfaceAlt: '#0b1220', // slightly darker inset
  border: '#334155', // slate-700 — hairlines / outlines

  textPrimary: '#f8fafc', // slate-50
  textSecondary: '#94a3b8', // slate-400 — labels, meta
  textMuted: '#94a3b8', // was slate-500 (#64748b); bumped for contrast on dark bg

  accent: '#a5b4fc', // indigo-300 — section titles, links
  primary: '#3b82f6', // blue-500 — primary buttons
  success: '#22c55e', // green-500 — accept
  danger: '#ef4444', // red-500 — destructive / reject
  warn: '#f59e0b', // amber-500 — needs-detail / decision CTA
  purple: '#8b5cf6', // violet-500 — PR CTA
} as const;

export const statusColors: Record<string, string> = {
  captured: '#64748b',
  brainstormed: '#22c55e',
  'needs-detail': '#f59e0b',
  'needs-critic-review': '#ef4444',
  accepted: '#10b981',
  building: '#3b82f6',
  'pr-open': '#8b5cf6',
  shipped: '#0ea5e9',
  rejected: '#475569',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 10, pill: 999 } as const;

// Cross-platform monospace (Menlo is iOS-only; Android has no "Menlo").
export const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// Standard pressed-state feedback for Pressables.
export const pressedOpacity = ({ pressed }: { pressed: boolean }) => ({ opacity: pressed ? 0.6 : 1 });
