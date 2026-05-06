/**
 * scripts/commands/_watch_tui/altscreen.ts
 *
 * Wrap an Ink render in the terminal's alternate screen buffer so the
 * TUI doesn't leave its last frame stuck in scrollback when it exits,
 * and consecutive renders (dashboard → watch TUI) don't stack on top
 * of each other.
 *
 *   ESC[?1049h  — switch TO alt screen, save cursor
 *   ESC[?1049l  — switch BACK to main screen, restore cursor
 *
 * Most terminals (xterm, iTerm2, Terminal.app, VS Code's integrated
 * terminal) support this. If the user's terminal doesn't, the escape
 * codes are written but visually no-op — the worst case is the old
 * stacked-frames behavior, not corruption.
 */

const ENTER = "\x1b[?1049h\x1b[H";
const LEAVE = "\x1b[?1049l";

export async function withAltScreen<T>(fn: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    // No TTY → no alt screen. Just run the fn.
    return fn();
  }

  process.stdout.write(ENTER);

  // If the process is killed mid-render, make sure we still leave the
  // alt screen so the user's prompt comes back clean.
  const restore = () => {
    try { process.stdout.write(LEAVE); } catch { /* ignore */ }
  };
  process.once("exit", restore);
  process.once("SIGINT", () => { restore(); process.exit(130); });
  process.once("SIGTERM", () => { restore(); process.exit(143); });

  try {
    return await fn();
  } finally {
    process.stdout.write(LEAVE);
    process.removeListener("exit", restore);
  }
}
