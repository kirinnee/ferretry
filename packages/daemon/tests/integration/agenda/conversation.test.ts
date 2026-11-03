import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgendaItemSchema, ResolvedAgendaItemSchema } from '@ferretry/protocol';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgendaVersionStore } from '../../../src/adapters/agenda/file-agenda-versions.ts';
import {
  type AgendaCommand,
  type AgendaMutation,
  applyAgendaCommandToSession,
} from '../../../src/lib/agenda/state-machine.ts';

const SESSION = 'conversation-integration';
const AT = '2026-11-03T10:00:00.000Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});
const accepted = (mutation: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!mutation.ok) throw new Error(mutation.error.message);
  return mutation;
};
const request = (subject: string) => ({
  source: 'agent-raised' as const,
  sourceRef: null,
  subject,
  why: 'The deploy needs a region.',
  premise: 'A release is ready.',
  context: 'The rollout is pending.',
  howToResolve: 'Answer in words.',
  ask: { kind: 'open-question' as const },
});

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'conversation-integration-'));
  homes.push(home);
  const directory = () => home;
  const versions = new FileAgendaVersionStore(directory);
  const repository = new FileAgendaLedgerRepository(directory, undefined, undefined, undefined, versions);
  const apply = async (command: AgendaCommand) =>
    accepted(await repository.transact(SESSION, current => applyAgendaCommandToSession(current, SESSION, command)));
  return { home, directory, versions, repository, apply };
}

describe('Durable agenda conversation', () => {
  it('round-trips oversized words, stable backdated logs and identical answers through merge, split and versions', async () => {
    const { directory, versions, apply } = await world();
    await apply({ action: 'raise', actor: AGENT, request: request('Which region?'), at: AT });
    await apply({ action: 'raise', actor: AGENT, request: request('Which quota?'), at: AT });
    const text = `    ${'x'.repeat(1_100_000)}Z\n`;
    for (const [id, messageId, at] of [
      ['A1', 'new', AT],
      ['A1', 'old', '2026-11-03T09:00:00.000Z'],
      ['A2', 'other', AT],
    ] as const) {
      await apply({
        action: 'log',
        actor: AGENT,
        id,
        mode: 'reply',
        words: 'OK',
        chat: { messageId, at, text },
        at: AT,
      });
    }
    const reloaded = new FileAgendaLedgerRepository(directory);
    const before = await reloaded.read(SESSION);
    should(before?.conversations?.A1?.map(entry => entry.fromChat?.messageId ?? entry.text)).deepEqual([
      'old',
      'new',
      'OK',
      'OK',
    ]);
    const merged = await apply({ action: 'merge', actor: AGENT, id: 'A1', from: 'A2', at: AT });
    should(merged.ledger.conversations?.A1?.filter(entry => entry.by === 'owner').map(entry => entry.text)).deepEqual([
      text,
      text,
      text,
    ]);
    const split = await apply({ action: 'split', actor: AGENT, id: 'A1', request: request('Which cache?'), at: AT });
    const child = split.item;
    should(child?.splitFrom).equal('A1');
    should(split.ledger.entries.find(entry => entry.item.id === 'A1')?.item.splitInto).containEql(child?.id);
    const final = await new FileAgendaLedgerRepository(directory).read(SESSION);
    should(final?.conversations?.A1).deepEqual(split.ledger.conversations?.A1);
    for (const entry of final?.entries ?? []) {
      should(
        (entry.lifecycle === 'active' ? AgendaItemSchema : ResolvedAgendaItemSchema).safeParse(entry.item).success,
      ).be.true();
      should(JSON.stringify(entry.item).length).be.below(1_000_000);
    }
    const history = await versions.list(SESSION, 'A1');
    should(history.length).be.above(3);
    should((await versions.get(SESSION, 'A1', history.at(-1)?.version ?? 0))?.item.conversationCount).equal(
      final?.conversations?.A1?.length,
    );
  });

  it('migrates a near-cap legacy item and a free-text answer losslessly through an unrelated write and restart', async () => {
    const { directory, repository, apply } = await world();
    const raised = await apply({ action: 'raise', actor: AGENT, request: request('Which region?'), at: AT });
    const item = {
      ...raised.item,
      conversation: undefined,
      conversationCount: undefined,
      body: 'b'.repeat(200_000),
      detail: 'd'.repeat(200_000),
      history: [1, 2, 3].map(minute => ({
        at: `2026-11-03T09:0${minute}:00.000Z`,
        kind: 'replied',
        note: 'r'.repeat(64_000),
      })),
      ownerAnswer: { at: AT, response: { kind: 'open-question', answer: 'Use eu-west, please.' }, request: 1 },
    };
    should(AgendaItemSchema.safeParse(item).success).be.true();
    const legacy = {
      ...raised.ledger,
      version: 2,
      conversations: undefined,
      entries: [{ ...raised.ledger.entries[0], item }],
    };
    await mkdir(dirname(repository.file(SESSION)), { recursive: true });
    await writeFile(repository.file(SESSION), JSON.stringify(legacy));
    await apply({ action: 'raise', actor: AGENT, request: request('Which cache?'), at: AT });
    const reread = await new FileAgendaLedgerRepository(directory).read(SESSION);
    should(reread?.entries).have.length(2);
    should(reread?.unreadable).be.undefined();
    should(reread?.conversations?.A1?.map(entry => entry.text)).deepEqual([
      ...Array(3).fill('r'.repeat(64_000)),
      'Use eu-west, please.',
    ]);
    const second = await new FileAgendaLedgerRepository(directory).read(SESSION);
    should(second?.conversations).deepEqual(reread?.conversations);
  });

  it('repairs a torn version tail before the next successful append after restart', async () => {
    const { home, directory, versions, apply } = await world();
    await apply({ action: 'raise', actor: AGENT, request: request('Which region?'), at: AT });
    const file = join(home, 'agenda-versions', 'A1.jsonl');
    const snapshot = await versions.get(SESSION, 'A1', 1);
    await rm(join(home, 'agenda-versions', 'A1.sqlite'));
    await writeFile(file, `${JSON.stringify({ snapshot })}\n`);
    await appendFile(file, '{"version":2,"item":');
    const restartedVersions = new FileAgendaVersionStore(directory);
    const repository = new FileAgendaLedgerRepository(directory, undefined, undefined, undefined, restartedVersions);
    await repository.transact(SESSION, current =>
      applyAgendaCommandToSession(current, SESSION, {
        action: 'rest',
        actor: AGENT,
        id: 'A1',
        why: 'Checking regions',
        at: AT,
      }),
    );
    should((await versions.list(SESSION, 'A1')).map(version => version.version)).deepEqual([1, 2]);
    should((await readFile(file, 'utf8')).endsWith('{"version":2,"item":')).be.true();
  });
});
