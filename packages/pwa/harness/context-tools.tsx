/**
 * Info › Context's MCP and Skills sub-tabs, and the Components page's MCP rows, on pages of their own
 * (`?context-tools=<frame>`): the real components, answered locally, so every scope, status, Check and
 * Sign in is walkable without a daemon (docs/mcp-scopes.md).
 *
 * Its own module rather than more lines in `main.tsx`, for the reason `mcp-sign-in.tsx` gives. Every
 * address and path here is a fake.
 */

import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import { ContextRailBody } from '../src/features/context-rail/context-rail-body.tsx';
import {
  type ContextSignalsPort,
  sessionMcpLoader,
  sessionSkillsInventoryLoader,
  skillFileLoader,
} from '../src/features/context-rail/context-rail-ports.ts';
import { ComponentsTab } from '../src/features/fleet/components/components-tab.tsx';
import { itemHref } from '../src/features/fleet/components/machine-links.ts';
import type { FleetClientFactory } from '../src/features/fleet/fleet-client.ts';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { harnessCatalogAnswer } from './account-model-catalog.ts';

const CONTEXT_TOOLS_FRAMES = ['mcp', 'skills', 'skill-open', 'components-mcp', 'unreachable'] as const;
export type ContextToolsFrame = (typeof CONTEXT_TOOLS_FRAMES)[number];

/** The frame `?context-tools=<frame>` names, or `undefined`. */
export const contextToolsFrame = (search: string): ContextToolsFrame | undefined => {
  const named = new URLSearchParams(search).get('context-tools');
  return CONTEXT_TOOLS_FRAMES.find(frame => frame === named);
};

const MACHINE = 'Liftoff MBP';
const CONNECTION = daemonConnection({ daemonId: 'harness-daemon', baseUrl: 'http://127.0.0.1:1', deviceId: 'harness' });
const in_ = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

const server = (fields: Record<string, unknown>) => ({
  harness: 'claude',
  transport: 'http',
  runtimes: [{ runtime: 'claude-default' }],
  ...fields,
});

/** Every scope a ferret reads, with the states the owner asked to see: approved, not approved, signed in. */
const SESSION_MCP = {
  problems: [],
  servers: [
    server({ id: 'tools', name: 'ferretry', scope: 'ferretry', transport: 'stdio', target: 'fy mcp serve' }),
    server({
      id: 'docs',
      name: 'docs',
      scope: 'project',
      target: 'https://mcp.docs.example/mcp',
      source: '/home/me/work/app/.mcp.json',
      project: { root: '/home/me/work/app', name: 'app' },
      runtimes: [{ runtime: 'claude-default', approval: 'approved' }],
      signIn: { subject: 'docs..5f1c2a9b7e3d', required: false },
    }),
    server({
      id: 'lint',
      name: 'lint',
      scope: 'project',
      transport: 'stdio',
      target: 'npx',
      source: '/home/me/work/app/.mcp.json',
      project: { root: '/home/me/work/app', name: 'app' },
      runtimes: [{ runtime: 'claude-default', approval: 'pending' }],
    }),
    server({
      id: 'scratch',
      name: 'scratch',
      scope: 'local',
      transport: 'stdio',
      target: 'node',
      project: { root: '/home/me/work/app', name: 'app' },
    }),
    server({
      id: 'github',
      name: 'github',
      scope: 'user',
      transport: 'stdio',
      target: 'npx',
      source: '~/.claude.json',
    }),
    server({
      id: 'linear',
      name: 'linear',
      scope: 'component',
      target: 'https://mcp.linear.app/mcp',
      signIn: { subject: 'linear', required: true },
      connection: {
        component: 'linear',
        state: 'signed-in',
        issuer: 'https://mcp.linear.app',
        signedInAt: in_(-5),
        expiresAt: in_(179),
        renewable: true,
        secrets: [],
      },
    }),
    server({
      id: 'notion',
      name: 'notion',
      scope: 'component',
      target: 'https://mcp.notion.com/mcp',
      signIn: { subject: 'notion', required: true },
    }),
  ],
};

const skill = (fields: Record<string, unknown>) => ({
  harness: 'claude',
  scope: 'user',
  runtimes: ['claude-default'],
  ...fields,
});

const SESSION_SKILLS = {
  sessionId: 'harness-session',
  harness: 'claude',
  runtime: 'claude-default',
  truncated: false,
  skills: [
    skill({
      name: 'release',
      description: 'Cut a release of this repo: changelog, tag, and the cask bump.',
      scope: 'project',
      path: '/home/me/work/app/.claude/skills/release/SKILL.md',
      project: { root: '/home/me/work/app' },
    }),
    skill({
      name: 'summary',
      description: 'Summarise this session for the human, outcome first.',
      scope: 'project',
      path: '/home/me/work/app/.claude/skills/summary/SKILL.md',
      project: { root: '/home/me/work/app' },
    }),
    skill({
      name: 'babysit-pr',
      description: 'Open a PR and drive it to green.',
      scope: 'ferretry',
      path: '/home/me/.ferretry/fleet/homes/a1/skills/babysit-pr/SKILL.md',
    }),
    skill({
      name: 'floop',
      description: 'Review the current changes until every reviewer is satisfied.',
      path: '/home/me/.ferretry/fleet/homes/a1/skills/floop/SKILL.md',
    }),
    skill({
      name: 'summary',
      description: 'An older summary skill.',
      path: '/home/me/.ferretry/fleet/homes/a1/skills/summary/SKILL.md',
      shadowedBy: 'project',
    }),
  ],
};

const SKILL_FILE = `---
name: release
description: Cut a release of this repo.
---

# Release

1. Write the changelog from the merged PRs.
2. Tag \`vX.Y.Z\` and push the tag.
3. Bump the cask once the release workflow is green.
`;

const MACHINE_MCP = {
  problems: [],
  servers: [
    server({ id: 'm-github', name: 'github', scope: 'component', transport: 'stdio', target: 'npx' }),
    server({ id: 'm-notes', name: 'notes', scope: 'component', transport: 'stdio', target: 'uvx' }),
    server({
      id: 'm-linear',
      name: 'linear',
      scope: 'component',
      target: 'https://mcp.linear.app/mcp',
      signIn: { subject: 'linear', required: true },
    }),
  ],
};

const checked = (id: string, name: string, outcome: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  transport: 'http',
  outcome,
  elapsedMs: 212,
  checkedAt: new Date().toISOString(),
  ...extra,
});

const answer = (frame: ContextToolsFrame, path: string, init?: RequestInit): unknown => {
  const method = init?.method ?? 'GET';
  if (frame === 'unreachable') return new Error('could not reach fyd at 127.0.0.1:7777 (ECONNREFUSED)');
  if (path === '/v1/sessions/harness-session/mcp/servers') return SESSION_MCP;
  if (path === '/v1/sessions/harness-session/skills/inventory') return SESSION_SKILLS;
  if (path.startsWith('/v1/skills/file'))
    return { path: '/home/me/work/app/.claude/skills/release/SKILL.md', content: SKILL_FILE };
  if (path === '/v1/mcp') return MACHINE_MCP;
  if (path === '/v1/mcp/check' && method === 'POST') {
    const id = (JSON.parse(String(init?.body ?? '{}')) as { id?: string }).id;
    if (id === 'docs')
      return checked('docs', 'docs', 'needs-sign-in', { message: 'It asks for a sign-in. It answered 401.' });
    if (id === 'github' || id === 'm-github')
      return checked(id, 'github', 'connected', {
        transport: 'stdio',
        serverName: 'GitHub',
        toolCount: 4,
        tools: ['create_issue', 'list_pulls', 'get_file', 'search_code'],
      });
    if (id === 'lint') return checked('lint', 'lint', 'not-approved', { transport: 'stdio' });
    return new Error('could not reach fyd at 127.0.0.1:7777 (ECONNREFUSED)');
  }
  if (path === '/v1/fleet/mcp-auth') return { connections: [] };
  if (path === '/v1/fleet/mcp-auth/docs..5f1c2a9b7e3d' && method === 'POST')
    return new FyHttpError('Unlock this device first.', 403, 'grant_step_up_required');
  return harnessCatalogAnswer(path, init);
};

const clientFor =
  (frame: ContextToolsFrame): FleetClientFactory =>
  async () => ({
    request: (async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const value = answer(frame, path, init);
      if (value instanceof Error) throw value;
      return schema.parse(value);
    }) as Awaited<ReturnType<FleetClientFactory>>['request'],
  });

const NO_SIGNALS: ContextSignalsPort = {
  subscribe: () => () => undefined,
  status: () => 'ready',
  snapshot: () => undefined,
  load: async () => undefined,
  respond: async () => undefined,
  resolve: async () => undefined,
};

export function ContextToolsHarness({ frame }: { readonly frame: ContextToolsFrame }) {
  useAppViewport();
  const [createClient] = useState(() => clientFor(frame));
  useState(() => {
    if (frame === 'components-mcp')
      window.history.replaceState(null, '', `${window.location.search}${itemHref(MACHINE, 'components', '')}`);
    return null;
  });
  if (frame === 'components-mcp')
    return (
      <main className="min-h-dvh bg-bg px-4 py-4" data-harness-context-tools={frame}>
        <div className="mx-auto w-full max-w-[760px]">
          <ComponentsTab
            connection={CONNECTION}
            machineName={MACHINE}
            machine={null}
            online
            checking={false}
            onRetry={() => undefined}
            createClient={createClient}
          />
        </div>
      </main>
    );
  const tab = frame === 'mcp' || frame === 'unreachable' ? 'mcp' : 'skills';
  return (
    <main className="flex min-h-dvh justify-end bg-bg" data-harness-context-tools={frame}>
      {/* Info's right panel on a desktop; the whole width on a phone. */}
      <aside className="flex min-h-dvh w-full flex-col border-l border-border-soft bg-surface md:w-[400px]">
        <ContextRailBody
          agentName="Hadi"
          sessionId="harness-session"
          machineName={MACHINE}
          signals={NO_SIGNALS}
          loadMcp={sessionMcpLoader(CONNECTION, createClient, 'harness-session')}
          loadSkills={sessionSkillsInventoryLoader(CONNECTION, createClient, 'harness-session')}
          loadSkillFile={skillFileLoader(CONNECTION, createClient, 'harness-session')}
          loadDocs={async () => []}
          onInsertSkill={() => undefined}
          onOpenFile={() => undefined}
          mcpSignIn={{ connection: CONNECTION, createClient, machineName: MACHINE }}
          onAddMcp={() => undefined}
          tabs={['files', 'docs', 'skills', 'mcp']}
          tab={tab}
          label="Context sections"
        />
      </aside>
    </main>
  );
}
