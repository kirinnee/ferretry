/**
 * Fixtures for the "This folder" rail suites, written out longhand as the shared contract and parsed
 * through the real schemas, so a change to the daemon's answer fails here rather than slipping past.
 */

import {
  type AttentionItem,
  type AttentionSnapshot,
  AttentionSnapshotSchema,
  type AvailableSkill,
  type ResolvedAttentionItem,
} from '@ferretry/protocol';
import type { ContextDoc, ContextMcpServer } from '../../../../src/features/context-rail/context-rail-model.ts';
import type { ContextSignalsPort } from '../../../../src/features/context-rail/context-rail-ports.ts';
import type { SkillsCatalog } from '../../../../src/features/skills/skills-catalog.ts';
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

export const skill = (overrides: Partial<AvailableSkill> & { name: string }): AvailableSkill => ({
  description: `What ${overrides.name} does.`,
  scope: 'global',
  origin: 'claude',
  ...overrides,
});

export const SKILLS: SkillsCatalog = {
  harness: 'claude',
  skills: [
    skill({ name: 'babysit-pr', description: 'Drive a PR to green' }),
    skill({ name: 'floop', description: 'Review → fix loop', origin: 'both' }),
    skill({ name: 'summary', description: 'Summarise this session for the human', scope: 'project' }),
  ],
};

export const MCP: readonly ContextMcpServer[] = [
  { name: 'github', transport: 'command', signsIn: false },
  {
    name: 'linear',
    transport: 'url',
    signsIn: true,
    connection: {
      component: 'linear',
      state: 'signed-in',
      issuer: 'https://auth.linear.example',
      expiresAt: '2026-10-23T10:00:00.000Z',
      renewable: true,
      secrets: [],
    },
  },
  { name: 'notion', transport: 'url', signsIn: true },
];

export const DOCS: readonly ContextDoc[] = [
  { path: 'CLAUDE.md', name: 'CLAUDE.md', size: 12_800 },
  { path: 'AGENTS.md', name: 'AGENTS.md', size: 1_434 },
];
