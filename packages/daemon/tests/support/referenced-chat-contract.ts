import { it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgendaConversationPageSchema, AgendaItemSchema, MAX_AGENDA_ITEM_LENGTH } from '@ferretry/protocol';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgendaVersionStore } from '../../src/adapters/agenda/file-agenda-versions.ts';
import { AgendaConversation } from '../../src/lib/agenda/observers.ts';
import { AgendaService } from '../../src/lib/agenda/service.ts';
import { inlineAgendaVersionsWorker } from './agenda-versions-worker.ts';

const SESSION = 'referenced-chat';
const AT = '2026-11-03T10:00:00.000Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };

/** Real persistence contract shared by the unit regressions and the adapter tier. */
export function referencedChatContract() {
  it('settles referenced chat verbatim through reply, restart, bounded pages and idempotent retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenda-referenced-chat-'));
    try {
      const directory = () => root;
      const versions = new FileAgendaVersionStore(directory, { spawn: inlineAgendaVersionsWorker });
      const repository = new FileAgendaLedgerRepository(directory, undefined, undefined, versions);
      const messages = new Map<string, string>();
      const service = new AgendaService(
        repository,
        { now: () => AT },
        { has: async () => true },
        { raised: async () => undefined },
        { changed: async () => undefined },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          find: async (_session, messageId = '') => ({
            ok: true,
            message: { messageId, at: AT, text: messages.get(messageId) ?? '' },
          }),
        },
        versions,
      );
      should(
        (
          await service.raise(
            SESSION,
            {
              source: 'agent-raised',
              sourceRef: null,
              subject: 'Which region?',
              why: 'The release waits.',
              premise: 'A deploy is ready.',
              context: 'It changes the service.',
              howToResolve: 'Answer in words.',
              ask: { kind: 'open-question' },
            },
            AGENT,
          )
        ).ok,
      ).be.true();
      const conversation = new AgendaConversation(service);
      const sources = [
        '    const answer = 42; // !A1\n',
        `    ${'x'.repeat(64_000)}Z !A1\n`,
        `    ${'😀\n'.repeat(370_000)}END !A1\n`,
      ];
      for (const [index, source] of sources.entries()) {
        const messageId = `m${index}`;
        messages.set(messageId, source);
        const turn = await conversation.prepare(SESSION, source);
        should(turn.referenced.map(item => item.id)).deepEqual(['A1']);
        await conversation.settle(SESSION, turn, source, { messageId, at: AT });
        await conversation.settle(SESSION, turn, source, { messageId, at: AT });
        const persisted = await new FileAgendaLedgerRepository(directory).read(SESSION);
        const entries = persisted?.conversations?.A1 ?? [];
        should(entries.filter(entry => entry.fromChat?.messageId === messageId)).have.length(1);
        should(entries[index]?.text).equal(source);
        should(entries[index]?.fromChat).deepEqual({ messageId, at: AT });
        should(persisted?.entries[0]?.item.resting?.sub).equal('waiting-on-ferret');
        for (const entry of persisted?.entries ?? []) {
          should(AgendaItemSchema.safeParse(entry.item).success).be.true();
          should(JSON.stringify(entry.item).length).be.belowOrEqual(MAX_AGENDA_ITEM_LENGTH);
        }
        let offset = 0;
        let copied = '';
        while (true) {
          const result = await service.conversationOf(SESSION, 'A1', index, offset);
          if (!result.ok) throw new Error(result.error.message);
          const page = AgendaConversationPageSchema.parse(result.value);
          copied += page.entry?.text ?? '';
          if (page.next?.index !== index) break;
          offset = page.next.offset;
        }
        should(copied).equal(source);
        const logged = await service.log(SESSION, 'A1', 'reply', 'OK', AGENT, messageId);
        should(!logged.ok && logged.error.code).equal('invalid');
      }
      // A failed automatic write must leave the source available to explicit log, without consuming its id.
      const source = '    Please retry !A1\n';
      messages.set('retry', source);
      const turn = await conversation.prepare(SESSION, source);
      const file = repository.file(SESSION);
      await rename(file, `${file}.saved`);
      await mkdir(file);
      await conversation.settle(SESSION, turn, source, { messageId: 'retry', at: AT });
      await rm(file, { recursive: true });
      await rename(`${file}.saved`, file);
      should((await service.log(SESSION, 'A1', 'reply', 'OK', AGENT, 'retry')).ok).be.true();
      const persisted = JSON.parse(await readFile(file, 'utf8'));
      should(
        persisted.conversations.A1.filter(
          (entry: { fromChat?: { messageId: string } }) => entry.fromChat?.messageId === 'retry',
        ),
      ).have.length(1);
      should(
        persisted.conversations.A1.find(
          (entry: { fromChat?: { messageId: string } }) => entry.fromChat?.messageId === 'retry',
        ).text,
      ).equal(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
