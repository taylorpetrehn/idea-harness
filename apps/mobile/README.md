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
- **Full ## Decision submission** — ✅ done. The Decision screen writes
  a structured `## Decision` block (+ sets `decided_at`, flips
  `needs-detail → brainstormed`) via the `ideas.decide` MCP tool, with a
  one-tap variant quick-pick.

## File-state contract with the harness

The mobile app is a thin view over the same canonical filesystem state
that the Mac CLI uses. The MCP server (Phase 2) is the only writer the
app talks to — the app never edits idea.md directly. Every mutation
(accept / reject / reroute) round-trips through `harness ideas
{accept,reject,reroute}` which does atomic frontmatter writes.

This means: a `/inflight` invocation on the Mac and a pull-to-refresh on
the phone show the same data, every time.

## Production build → TestFlight (durable, no Metro)

The dev build streams JS from Metro, so it dies when Metro stops or the
Mac reboots. A TestFlight build embeds the bundle and runs standalone on
the phone — the durable counterpart to the managed `harness mcp serve`
LaunchAgent. It still talks to that server over Tailscale (enter the URL
+ token in Settings exactly as with the dev build).

EAS is scaffolded ([`eas.json`](eas.json)): remote-managed app versions
+ `autoIncrement` (build numbers never collide), `production` profile
for the store, `preview` for ad-hoc internal installs. `app.json` has
the App Store encryption-compliance flag set so TestFlight won't prompt
on every build.

### Prerequisites (yours — interactive)

- An Expo account (you have one via **LetsBarker**) and the
  `eas-cli` (used here via `npx eas-cli@latest`, no global install).
- **Apple Developer Program** membership (LetsBarker implies you have
  it) — reuse the same Apple Team for this app.
- **Required asset:** a 1024×1024 PNG **app icon, no alpha/transparency**
  at `./assets/icon.png`, plus `"icon": "./assets/icon.png"` under
  `expo` in `app.json`. There is none yet — App Store/TestFlight will
  reject a build without it. (Ask me to drop in a placeholder if you
  want to exercise the pipeline before the real icon exists.)

### Steps

Run from `apps/mobile/`. The logins are interactive — type them with a
leading `!` in this session so the output lands here and I can react:

```bash
! npx eas-cli@latest login          # the LetsBarker Expo account
! npx eas-cli@latest init           # links/creates the Expo project; writes extra.eas.projectId to app.json
# Create the app in App Store Connect with bundle id com.taylorpetrehn.ideaharness
#   (or let the submit step create it). Then either fill eas.json
#   submit.production.ios.{appleId,ascAppId}, or just rely on prompts.
! npx testflight                    # one command: EAS cloud build (production) + submit to TestFlight
```

`npx testflight` ≡ `npx eas-cli@latest build -p ios --profile production --submit`.
It prompts for Apple auth the first time; set `EXPO_APPLE_ID` and
`EXPO_APPLE_TEAM_ID` (the CLI prints the Team ID) to skip future
prompts. First build is ~10–20 min in the cloud + Apple processing;
then add yourself as an internal tester in App Store Connect and
install via the TestFlight app — standalone, survives reboot.

### Updating

`autoIncrement` + remote `appVersionSource` handle build numbers — just
re-run `npx testflight`. Bump `expo.version` in `app.json` only for a
new user-facing version. EAS Build runs `expo prebuild` in the cloud,
so the absent `ios/` dir is fine.

> Known-benign: `expo-doctor` reports the `tsc` npm script "conflicts"
> with `node_modules/.bin/tsc`. npm script precedence means
> `npm run tsc` still works; it does not affect EAS Build. Left as-is to
> avoid rippling a rename through docs/tooling.
