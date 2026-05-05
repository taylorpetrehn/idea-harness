/**
 * scripts/commands/completions.ts
 *
 * `harness completions <bash|zsh|fish>` — emit a shell completion
 * script. Static commands are baked in; idea-slug completion is
 * dynamic via `harness ideas list --json`.
 *
 * Install (zsh example):
 *   harness completions zsh > ~/.zfunc/_harness
 *   echo 'fpath+=~/.zfunc; autoload -U compinit; compinit' >> ~/.zshrc
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";

export interface CompletionsArgs {
  shell: "bash" | "zsh" | "fish";
}

const CompletionsData = z.object({
  shell: z.string(),
  bytes: z.number(),
});

registerVerb({
  verb: "completions",
  description: "Emit a shell completion script for bash, zsh, or fish.",
  data: CompletionsData,
});

const TOP_VERBS = [
  "capture",
  "brainstorm",
  "ideas",
  "review",
  "ship",
  "build",
  "resume",
  "cleanup",
  "inspect",
  "doctor",
  "completions",
  "contracts",
  "serve",
];

const BASH_SCRIPT = `#!/usr/bin/env bash
_harness_complete() {
  local cur prev words cword
  _init_completion || return

  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${TOP_VERBS.join(" ")}" -- "\${cur}") )
    return 0
  fi

  case "\${words[1]}" in
    ideas)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "list show waiting" -- "\${cur}") )
      fi
      ;;
    review)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "next in-flight accept reject thought set" -- "\${cur}") )
      fi
      ;;
    build)
      if [[ \${cword} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "start resume watch status" -- "\${cur}") )
      fi
      ;;
  esac
}
complete -F _harness_complete harness
`;

const ZSH_SCRIPT = `#compdef harness

_harness() {
  local -a verbs
  verbs=(
    'capture:Add a new idea'
    'brainstorm:Run the plan→brainstorm→critic pipeline'
    'ideas:Inspect captured ideas'
    'review:Conversational review hooks'
    'ship:Do the obvious next thing'
    'build:Build/resume/watch a single idea'
    'resume:Recover a building idea'
    'cleanup:Remove worktrees for shipped ideas'
    'inspect:Show recent runs and metrics'
    'doctor:Environment health check'
    'completions:Emit a shell completion script'
    'contracts:Emit JSON Schema for verb data'
    'serve:Run as MCP/HTTP server'
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'harness verb' verbs
    return
  fi
  case "$words[2]" in
    ideas)   _values 'ideas verb' 'list' 'show' 'waiting' ;;
    review)  _values 'review verb' 'next' 'in-flight' 'accept' 'reject' 'thought' 'set' ;;
    build)   _values 'build verb' 'start' 'resume' 'watch' 'status' ;;
  esac
}

_harness "$@"
`;

const FISH_SCRIPT = `function __harness_slugs
  harness ideas list --json 2>/dev/null | python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  for i in d.get('data',{}).get('ideas',[]): print(i['slug'])
except Exception:
  pass"
end

complete -c harness -f
${TOP_VERBS.map((v) => `complete -c harness -n '__fish_use_subcommand' -a ${v}`).join("\n")}
complete -c harness -n '__fish_seen_subcommand_from review' -a 'next in-flight accept reject thought set'
complete -c harness -n '__fish_seen_subcommand_from ideas'  -a 'list show waiting'
complete -c harness -n '__fish_seen_subcommand_from build'  -a 'start resume watch status'
complete -c harness -n '__fish_seen_subcommand_from resume' -a "(__harness_slugs)"
`;

export async function run(args: CompletionsArgs, out: Output): Promise<void> {
  let script: string;
  switch (args.shell) {
    case "bash": script = BASH_SCRIPT; break;
    case "zsh":  script = ZSH_SCRIPT; break;
    case "fish": script = FISH_SCRIPT; break;
    default:
      out.error("BAD_INPUT", `Unsupported shell "${args.shell}".`, {
        hint: "Supported: bash | zsh | fish",
      });
      return;
  }
  out.stdout(script);
  out.result(
    { shell: args.shell, bytes: Buffer.byteLength(script) },
    `Source it from your shell rc, e.g.: harness completions ${args.shell} > ~/.config/harness.${args.shell}`
  );
}
