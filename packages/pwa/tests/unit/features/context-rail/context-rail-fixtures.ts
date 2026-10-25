/**
 * Fixtures for the Context suites, written out longhand as the shared contract and parsed
 * through the real schemas, so a change to the daemon's answer fails here rather than slipping past.
 */

import {
  type AttentionItem,
  type AttentionSnapshot,
  AttentionSnapshotSchema,
  type McpInventory,
  McpInventorySchema,
  type McpInventoryServer,
  type ResolvedAttentionItem,
  type SessionSkillsInventory,
  SessionSkillsInventorySchema,
  type SkillEntry,
} from '@ferretry/protocol';
import type { ContextDoc } from '../../../../src/features/context-rail/context-rail-model.ts';
import type { ContextSignalsPort } from '../../../../src/features/context-rail/context-rail-ports.ts';
import type { AttentionLoadStatus } from '../../../../src/lib/attention-store.ts';

export const NOW = Date.parse('2026-10-16T10:00:00.000Z');

export const openItem = (overrides: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id: 'A1',
    source: 'question',
    sourceRef: null,
    subject: 'Use the seeded test account?',
    why: 'The login page needs a user.',
    waitingSince: '2026-10-16T09:58:00.000Z',
    howToResolve: 'Pick one.',
    ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    raisedBy: 'agent',
    raisedBySession: 'session-a',
    raisedByName: 'Hadi',
    ...overrides,
  }) as AttentionItem;

export const answeredItem = (overrides: Partial<ResolvedAttentionItem> = {}): ResolvedAttentionItem =>
  ({
    id: 'A2',
    source: 'question',
    sourceRef: null,
    subject: 'Port 1455 was busy',
    why: 'Another server holds it.',
    waitingSince: '2026-10-16T08:00:00.000Z',
    howToResolve: 'Choose.',
    ask: { kind: 'multiple-choice', options: [{ label: 'Start over' }, { label: 'Wait' }] },
    raisedBy: 'agent',
    raisedBySession: 'session-a',
    raisedByName: null,
    resolvedAt: '2026-10-16T09:00:00.000Z',
    resolutionNote: null,
    response: { kind: 'multiple-choice', choice: 'Start over' },
    disposition: 'done',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    ...overrides,
  }) as ResolvedAttentionItem;

export const snapshot = (
  items: readonly AttentionItem[] = [openItem()],
  resolved: readonly ResolvedAttentionItem[] = [answeredItem()],
): AttentionSnapshot =>
  AttentionSnapshotSchema.parse({
    v: 1,
    sessionId: 'session-a',
    items,
    resolved,
    count: items.length,
    parseErrors: 0,
    updatedAt: '2026-10-16T09:59:00.000Z',
  });

/** A signals port a test drives: what was answered, and a way to change what the board holds. */
export interface FakeSignals extends ContextSignalsPort {
  readonly responses: unknown[];
  readonly resolved: string[];
  loads: number;
  set(status: AttentionLoadStatus, value?: AttentionSnapshot): void;
  /** The next answer or resolve fails with this, once. */
  failNext?: Error;
  /** The next load fails, once. */
  failLoad?: boolean;
}

export const fakeSignals = (initial?: AttentionSnapshot, status: AttentionLoadStatus = 'ready'): FakeSignals => {
  const listeners = new Set<() => void>();
  let state: { status: AttentionLoadStatus; value: AttentionSnapshot | undefined } = {
    status: initial === undefined ? 'loading' : status,
    value: initial,
  };
  const fake: FakeSignals = {
    responses: [],
    resolved: [],
    loads: 0,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => state.status,
    snapshot: () => state.value,
    load: async () => {
      fake.loads += 1;
      if (fake.failLoad === true) {
        fake.failLoad = false;
        throw new Error('the board did not load');
      }
    },
    respond: async (id, response) => {
      const failure = fake.failNext;
      fake.failNext = undefined;
      if (failure !== undefined) throw failure;
      fake.responses.push({ id, response });
    },
    resolve: async id => {
      const failure = fake.failNext;
      fake.failNext = undefined;
      if (failure !== undefined) throw failure;
      fake.resolved.push(id);
    },
    set(next, value) {
      state = { status: next, value };
      for (const listener of listeners) listener();
    },
  };
  return fake;
};

export const skill = (overrides: Partial<SkillEntry> & { name: string }): SkillEntry => ({
  description: `What ${overrides.name} does.`,
  harness: 'claude',
  scope: 'user',
  path: `/fy/fleet/homes/claude-work/skills/${overrides.name}/SKILL.md`,
  runtimes: ['claude-work'],
  ...overrides,
});

export const SKILLS: SessionSkillsInventory = SessionSkillsInventorySchema.parse({
  sessionId: 'session-a',
  harness: 'claude',
  runtime: 'claude-work',
  truncated: false,
  skills: [
    skill({ name: 'babysit-pr', description: 'Drive a PR to green', scope: 'ferretry' }),
    skill({ name: 'floop', description: 'Review → fix loop' }),
    skill({
      name: 'summary',
      description: 'Summarise this session for the human',
      scope: 'project',
      path: '/work/app/.claude/skills/summary/SKILL.md',
      project: { root: '/work/app' },
    }),
    skill({ name: 'summary', description: 'An older summary', shadowedBy: 'project' }),
  ],
});

export const mcpServer = (overrides: Partial<McpInventoryServer> & { name: string }): McpInventoryServer => ({
  id: `id-${overrides.name}-${overrides.scope ?? 'component'}`,
  scope: 'component',
  harness: 'claude',
  transport: 'http',
  target: `https://${overrides.name}.example/mcp`,
  runtimes: [{ runtime: 'claude-work' }],
  ...overrides,
});

export const MCP: McpInventory = McpInventorySchema.parse({
  problems: [],
  servers: [
    mcpServer({ name: 'ferretry', scope: 'ferretry', transport: 'stdio', target: 'fy mcp serve' }),
    mcpServer({ name: 'github', scope: 'user', transport: 'stdio', target: 'npx', source: '/fy/home/.claude.json' }),
    mcpServer({
      name: 'linear',
      signIn: { subject: 'linear', required: true },
      connection: {
        component: 'linear',
        state: 'signed-in',
        issuer: 'https://auth.linear.example',
        expiresAt: '2026-10-23T10:00:00.000Z',
        renewable: true,
        secrets: [],
      },
    }),
    mcpServer({
      name: 'notion',
      scope: 'project',
      source: '/work/app/.mcp.json',
      project: { root: '/work/app' },
      runtimes: [{ runtime: 'claude-work', approval: 'approved' }],
      signIn: { subject: 'notion..a1b2c3d4e5f6', required: false },
    }),
    mcpServer({
      name: 'lint',
      scope: 'project',
      transport: 'stdio',
      target: 'npx',
      source: '/work/app/.mcp.json',
      project: { root: '/work/app' },
      runtimes: [{ runtime: 'claude-work', approval: 'pending' }],
    }),
    mcpServer({ name: 'scratch', scope: 'local', transport: 'stdio', target: 'node', project: { root: '/work/app' } }),
  ],
});

export const DOCS: readonly ContextDoc[] = [
  { path: 'CLAUDE.md', name: 'CLAUDE.md', size: 12_800 },
  { path: 'AGENTS.md', name: 'AGENTS.md', size: 1_434 },
];
