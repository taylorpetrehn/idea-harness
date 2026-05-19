/**
 * Tiny JSON-RPC 2.0 client for the harness HTTP MCP transport
 * (cli/harness/commands/mcp_server.py --http).
 *
 * Auth: bearer token from expo-secure-store. URL: whatever Taylor sets in
 * Settings, typically a Tailscale tailnet IP or funnel hostname.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { getConfig, type HarnessConfig } from './config';

export type IdeaSummary = {
  slug: string;
  title: string;
  status: string;
  project: string | null;
  score: number | null;
  last_touched: string;
  path: string;
};

export type IdeaDetail = IdeaSummary & {
  frontmatter: Record<string, unknown>;
  body: string;
};

type JsonRpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

let _rpcId = 0;
const nextId = () => ++_rpcId;

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const cfg = await getConfig();
  if (!cfg) {
    throw new HarnessNotConfigured();
  }
  return rpcWith<T>(cfg, method, params);
}

export class HarnessNotConfigured extends Error {
  constructor() {
    super('Open Settings and enter the harness URL + token before using the app.');
    this.name = 'HarnessNotConfigured';
  }
}

async function rpcWith<T>(cfg: HarnessConfig, method: string, params: Record<string, unknown>): Promise<T> {
  const body = { jsonrpc: '2.0' as const, id: nextId(), method, params };
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    throw new Error('Unauthorized — check the token in Settings.');
  }
  if (res.status >= 500) {
    throw new Error(`Harness server error (${res.status}). Check the harness mcp serve log.`);
  }
  const text = await res.text();
  if (!text) {
    throw new Error('Empty response from harness.');
  }
  const payload = JSON.parse(text) as JsonRpcResponse<T>;
  if (payload.error) {
    throw new Error(payload.error.message);
  }
  return payload.result as T;
}

/**
 * Calls an MCP tool by name. The server wraps the result in `content: [{type:"text",text:"<json>"}]`,
 * so we unwrap that and parse the inner JSON.
 */
async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await rpc<{ content: { type: string; text: string }[] }>('tools/call', {
    name,
    arguments: args,
  });
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new Error(`tool ${name} returned no content`);
  }
  return JSON.parse(text) as T;
}

// ----- public API ----------------------------------------------------------

export async function ping(): Promise<void> {
  await rpc<unknown>('ping');
}

export async function pingWith(cfg: HarnessConfig): Promise<void> {
  await rpcWith<unknown>(cfg, 'ping', {});
}

export type AgentSession = {
  id: string | null;
  status: string;
  summary: string;
  started_at: string | null;
  cwd: string | null;
  model: string | null;
};

export const queryKeys = {
  ideas: (filter?: { status?: string; project?: string; scoreGte?: number }) =>
    ['ideas', filter ?? {}] as const,
  idea: (slug: string) => ['idea', slug] as const,
  agents: (filter?: { status?: string; limit?: number }) =>
    ['agents', filter ?? {}] as const,
};

export function useIdeas(filter?: { status?: string; project?: string; scoreGte?: number }) {
  return useQuery({
    queryKey: queryKeys.ideas(filter),
    queryFn: () =>
      callTool<{ ideas: IdeaSummary[]; count: number }>('ideas.list', {
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.project ? { project: filter.project } : {}),
        ...(filter?.scoreGte !== undefined ? { score_gte: filter.scoreGte } : {}),
      }),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

export function useIdea(slug: string | undefined) {
  return useQuery({
    queryKey: slug ? queryKeys.idea(slug) : ['idea', '<missing>'],
    enabled: !!slug,
    queryFn: () => callTool<IdeaDetail>('ideas.show', { slug }),
  });
}

function makeMutation(tool: string) {
  return function useIdeaMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (args: {
        slug: string;
        note?: string;
        project?: string;
        decision?: string;
        variant?: string;
      }) => callTool<{ slug: string; previous_status?: string; status?: string }>(tool, args),
      onSuccess: (_data, vars) => {
        // Invalidate both the list and the specific idea.
        qc.invalidateQueries({ queryKey: ['ideas'] });
        qc.invalidateQueries({ queryKey: queryKeys.idea(vars.slug) });
      },
    });
  };
}

export const useAccept = makeMutation('ideas.accept');
export const useReject = makeMutation('ideas.reject');
export const useReroute = makeMutation('ideas.reroute');
// Structured ## Decision write + decided_at (+ flips needs-detail → brainstormed).
export const useDecide = makeMutation('ideas.decide');

/**
 * Live Claude Code agent sessions via `claude agents --json` on the host.
 * Wraps the Claude Code 2.1.139 `agents.list` MCP tool. Tolerates a missing
 * `claude` binary by surfacing `error` in the payload instead of throwing.
 */
export function useAgents(filter?: { status?: string; limit?: number }) {
  return useQuery({
    queryKey: queryKeys.agents(filter),
    queryFn: () =>
      callTool<{ agents: AgentSession[]; count: number; error?: string }>('agents.list', {
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.limit ? { limit: filter.limit } : {}),
      }),
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
