import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionConfig, SessionConfigSchema } from '@ferretry/protocol';
import should from 'should';
import {
  type BudgetStorage,
  budgetHoldsWriter,
  claudeSubagentFiles,
  FileBudgetTold,
  readBudgetHoldsSync,
  StorageBudgetSessions,
} from '../../../src/adapters/budget/ports.ts';
import type { SessionId } from '../../../src/lib/session-id.ts';
import type { IndexedSession } from '../../../src/lib/storage-types.ts';

/** One session document, through the protocol schema so the fixture cannot drift from the wire. */
const sessionConfig = (overrides: Readonly<Record<string, unknown>>): SessionConfig =>
  SessionConfigSchema.parse({
    id: 's1',
    incarnation: 's1-1',
    runtimeGeneration: 1,
    name: 'Budgeted Work',
    modelHint: 'claude-opus-5-5',
    model: 'claude-opus-5-5',
    agent: 'claude-liftoff',
    harness: 'claude',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work/ferretry',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    turn: 1,
    intervalSeconds: 30,
    timeoutSeconds: 0,
    nudgeAfterSeconds: 0,
    killAfterSeconds: 0,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'full',
    maxSnapshots: 10,
    retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    ...overrides,
  });

const scratch: string[] = [];
afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('claudeSubagentFiles', () => {
  it("should find a Claude session's sub-agent transcripts beside its own, and none when there are none", async () => {
    const home = await mkdtemp(join(tmpdir(), 'fy-budget-'));
    scratch.push(home);
    const transcript = join(home, 'abc.jsonl');
    await writeFile(transcript, '');
    should(await claudeSubagentFiles(transcript)).eql([]);
    await mkdir(join(home, 'abc', 'subagents'), { recursive: true });
    await writeFile(join(home, 'abc', 'subagents', 'agent-b.jsonl'), '');
    await writeFile(join(home, 'abc', 'subagents', 'agent-a.jsonl'), '');
    await writeFile(join(home, 'abc', 'subagents', 'agent-a.meta.json'), '{}');
    should(await claudeSubagentFiles(transcript)).eql([
      join(home, 'abc', 'subagents', 'agent-a.jsonl'),
      join(home, 'abc', 'subagents', 'agent-b.jsonl'),
    ]);
  });
});

describe('the kept holds', () => {
  it('should read back what was written, and a missing or garbled file as none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fy-budget-'));
    scratch.push(home);
    const path = join(home, 'budget-holds.json');
    should(readBudgetHoldsSync(path)).eql({});
    const holds = {
      liftoff: { period: 'daily', level: 'over_hard', limitUsd: 60, resetsAtMs: 1_800_000_000_000, timeZone: 'UTC' },
    } as const;
    await budgetHoldsWriter({ writeTextAtomic: async (target, text) => await writeFile(target, text) }, path)(holds);
    should(readBudgetHoldsSync(path)).eql(holds);
    await writeFile(path, '{"liftoff": {"period": "monthly"}}');
    should(readBudgetHoldsSync(path)).eql({});
  });
});

describe('FileBudgetTold', () => {
  it('should read what it wrote, and an absent or garbled record as nothing told', async () => {
    const files = new Map<string, string>();
    const told = new FileBudgetTold(
      {
        readText: async path => files.get(path),
        writeTextAtomic: async (path, text) => {
          files.set(path, text);
        },
      },
      '/state/budget-told.json',
    );
    should(await told.read()).eql([]);
    await told.write(['liftoff|daily|2026-10-30T00:00:00.000Z']);
    should(await told.read()).eql(['liftoff|daily|2026-10-30T00:00:00.000Z']);
    files.set('/state/budget-told.json', '{not json');
    should(await told.read()).eql([]);
  });
});

describe('StorageBudgetSessions', () => {
  const config = (id: string, agent: string, extra: Readonly<Record<string, unknown>> = {}) =>
    sessionConfig({ id, incarnation: `${id}-1`, agent, teammate: `ferret-${id}`, ...extra });

  function storageOf(
    sessions: IndexedSession[],
    configs: Record<string, unknown>,
  ): BudgetStorage & { configReads: number } {
    const storage = {
      configReads: 0,
      listSessions: () => sessions,
      readConfig: async (id: SessionId) => {
        storage.configReads += 1;
        return configs[id];
      },
      readState: async () => undefined,
    };
    return storage;
  }

  it('should list the running sessions and those updated in the period, with the login each ran on', async () => {
    const indexed = (id: string, status: string, updatedAt: string): IndexedSession =>
      ({ id, status, updatedAt, lastSequence: 0, journalLine: 0, journal: null }) as unknown as IndexedSession;
    const storage = storageOf(
      [
        indexed('run', 'running', '2026-10-01T00:00:00Z'),
        indexed('recent', 'completed', '2026-10-29T00:00:00Z'),
        indexed('old', 'completed', '2026-10-01T00:00:00Z'),
        indexed('other', 'running', '2026-10-30T00:00:00Z'),
        indexed('garbled', 'running', '2026-10-30T00:00:00Z'),
        indexed('twice', 'completed', '2026-10-30T00:00:00Z'),
      ],
      {
        run: config('run', 'claude-liftoff'),
        recent: config('recent', 'claude-home', {
          migration: { from: 'claude-liftoff', to: 'claude-home', at: '2026-10-29T01:00:00.000Z' },
        }),
        old: config('old', 'claude-liftoff'),
        other: config('other', 'codex-a', { harness: 'codex' }),
        garbled: { not: 'a session config' },
        // Moved twice, the second time converted from Claude: both moves count, and the file it left is named.
        twice: config('twice', 'codex-a', {
          harness: 'codex',
          migration: { from: 'claude-home', to: 'codex-a', at: '2026-10-30T04:00:00.000Z' },
          migrations: [
            { from: 'claude-home', to: 'codex-a', at: '2026-10-30T04:00:00.000Z' },
            { from: 'claude-liftoff', to: 'claude-home', at: '2026-10-30T02:00:00.000Z' },
          ],
          conversion: {
            v: 1,
            converter: 1,
            fromHarness: 'claude',
            fromConversation: 'c-1',
            fromFile: '/home/person/.claude/projects/x/c-1.jsonl',
            toHarness: 'codex',
            toConversation: 'x-1',
            at: '2026-10-30T04:00:00.000Z',
            keptTurns: 3,
            omittedTurns: 0,
          },
        }),
      },
    );
    const sessions = new StorageBudgetSessions(storage);
    const listed = await sessions.sessions(Date.parse('2026-10-26T00:00:00Z'));
    should(listed).eql([
      { id: 'run', harness: 'claude', agent: 'claude-liftoff', moves: [] },
      {
        id: 'recent',
        harness: 'claude',
        agent: 'claude-home',
        moves: [{ from: 'claude-liftoff', atMs: Date.parse('2026-10-29T01:00:00Z') }],
      },
      { id: 'other', harness: 'codex', agent: 'codex-a', moves: [] },
      {
        id: 'twice',
        harness: 'codex',
        agent: 'codex-a',
        // Oldest first, whatever order they were written in.
        moves: [
          { from: 'claude-liftoff', atMs: Date.parse('2026-10-30T02:00:00Z') },
          { from: 'claude-home', atMs: Date.parse('2026-10-30T04:00:00Z') },
        ],
      },
    ]);
    should(await sessions.convertedFrom('twice')).eql({
      path: '/home/person/.claude/projects/x/c-1.jsonl',
      harness: 'claude',
    });
    should(await sessions.convertedFrom('run')).be.undefined();
    should(await sessions.live(new Set(['claude-liftoff']))).eql([
      { id: 'run', name: 'ferret-run', agent: 'claude-liftoff' },
    ]);
    should(await sessions.recent(new Set(['claude-home']))).eql({
      id: 'recent',
      name: 'ferret-recent',
      agent: 'claude-home',
    });
    should(await sessions.recent(new Set(['nobody']))).be.undefined();
    const reads = storage.configReads;
    await sessions.sessions(Date.parse('2026-10-26T00:00:00Z'));
    // Nothing moved in the index, so no document was read again.
    should(storage.configReads).equal(reads);
  });
});
