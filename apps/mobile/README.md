# Idea Harness · mobile

Expo Router app for browsing and triaging captured ideas from the phone.
Connects over Tailscale HTTPS to the harness MCP server running on Taylor's
Mac (`harness mcp serve --http --token-file ~/.secrets/harness-mobile-token`).

## Stack

- Expo SDK 55 + Expo Router v55 (file-based routing under [app/](app/))
- TanStack Query v5 for fetch + cache
- expo-secure-store for the bearer token
- No NativeWind in Phase 3 — plain StyleSheet, dark-themed; we can layer
  Tailwind in later if Taylor wants

## Screens

| Route | Purpose |
|---|---|
| [`app/index.tsx`](app/index.tsx) | Inbox — ideas grouped by status, pull-to-refresh |
| [`app/idea/[slug]/index.tsx`](app/idea/[slug]/index.tsx) | Idea detail + accept/reject action bar |
| [`app/idea/[slug]/decision.tsx`](app/idea/[slug]/decision.tsx) | needs-detail handling: shows Open Question + Variants, accept-with-note |
| [`app/idea/[slug]/pr.tsx`](app/idea/[slug]/pr.tsx) | PR Status — link to GitHub + review.json pointer |
| [`app/settings.tsx`](app/settings.tsx) | Harness URL + bearer-token config with test-connection |

## Run

```bash
cd apps/mobile/
npm install
npm run start
# Scan the QR with Expo Go on the phone, or run on simulator:
npm run ios
```

First-launch flow: the Inbox screen detects missing config and routes you
to Settings. Paste your Mac's Tailscale URL and the contents of
`~/.secrets/harness-mobile-token`. Hit **Test connection** to verify
before saving.

## Phase 3 scope (what's done, what's deferred)

Done:

- All 4 screens specced in the [bridge plan](../../docs/bridge-plan.md#phase-3--mobile-app--worktree-runner-primitive-2-weeks)
- TanStack Query + token storage via expo-secure-store
- Tailscale-friendly HTTPS transport (no localhost assumption)

Deferred:

- **Push notifications** — Phase 4. The harness will keep using ntfy.sh
  for the "Claude needs you" pings; the app shows whatever's in the
  inbox when you open it.
- **NativeWind / theming** — the dark palette is hardcoded for v1.
  Taylor's existing mobile patterns (`mobile/CLAUDE.md` in LetsBarker)
  can be layered in if/when this app earns more polish.
- **i18n** — no translations layer yet; Phase 4 if the app ships to
  anyone besides Taylor.
- **Full ## Decision submission** — current "Accept with note" appends
  to ## Notes via the MCP `note` field. Writing structured `## Decision`
  back into idea.md needs a new MCP tool (e.g. `ideas.decide`) which is
  a small Phase 4 add.

## File-state contract with the harness

The mobile app is a thin view over the same canonical filesystem state
that the Mac CLI uses. The MCP server (Phase 2) is the only writer the
app talks to — the app never edits idea.md directly. Every mutation
(accept / reject / reroute) round-trips through `harness ideas
{accept,reject,reroute}` which does atomic frontmatter writes.

This means: a `/inflight` invocation on the Mac and a pull-to-refresh on
the phone show the same data, every time.
