import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import { QueueOwnerWords } from '../../../src/adapters/board/session-owner-words.ts';
import type { SessionParents } from '../../../src/lib/board/index.ts';

const SESSION = 'mvuc7tsf-0c3d50df';
const SUB = 'mvvilibo-3df19c85';

const message = (id: string, text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id,
  sender: 'human',
  text,
  attachmentIds: [],
  enqueuedAt: '2026-10-30T10:00:00.000Z',
  state: 'read',
  stateAt: '2026-10-30T10:00:00.000Z',
  revision: 1,
  ...extra,
});

const parents: SessionParents = { parentOf: async id => (id === SUB ? SESSION : undefined) };

const words = (
  messages: readonly QueuedMessage[] | Error,
  files: Record<string, string> = {},
  lineage: SessionParents = parents,
) =>
  new QueueOwnerWords(
    {
      list: async () => {
        if (messages instanceof Error) throw messages;
        return messages;
      },
    },
    lineage,
    id => `/sessions/${id}/turns/turn-001.md`,
    async file => {
      const text = files[file];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
  );

describe('QueueOwnerWords', () => {
  it('should answer the owner messages in any state, and no one else', async () => {
    const said = await words([
      message('a', 'first from the owner', { state: 'queued' }),
      message('b', 'second from the app', { by: { kind: 'owner' } }),
      message('c', 'a lead ferret wrote this', { sender: 'agent', by: { kind: 'ferret', name: 'jaeda' } }),
      message('d', 'a human-sender message on a ferret behalf', { by: { kind: 'ferret', name: 'jaeda' } }),
      message('e', 'the daemon notice', { sender: 'daemon', by: { kind: 'ferretry', feature: 'Board' } }),
    ]).said(SESSION);
    should(said).eql(['first from the owner', 'second from the app']);
  });

  it('should add the first turn when no ferret started the session', async () => {
    const file = `/sessions/${SESSION}/turns/turn-001.md`;
    should(await words([message('a', 'hello')], { [file]: 'the brief' }).said(SESSION)).eql(['hello', 'the brief']);
  });

  it('should leave the first turn out when a ferret started the session', async () => {
    const file = `/sessions/${SUB}/turns/turn-001.md`;
    should(await words([message('a', 'hello')], { [file]: "the lead's brief" }).said(SUB)).eql(['hello']);
  });

  it('should answer the messages when the first turn is missing', async () => {
    should(await words([message('a', 'hello')]).said(SESSION)).eql(['hello']);
  });

  it('should answer the first turn when the queue cannot be read', async () => {
    const file = `/sessions/${SESSION}/turns/turn-001.md`;
    should(await words(new Error('torn'), { [file]: 'the brief' }).said(SESSION)).eql(['the brief']);
  });

  it('should answer nothing for a session whose lineage cannot be read', async () => {
    const broken: SessionParents = {
      parentOf: async () => {
        throw new Error('no config');
      },
    };
    const file = `/sessions/${SESSION}/turns/turn-001.md`;
    should(await words([], { [file]: 'the brief' }, broken).said(SESSION)).eql([]);
  });

  it('should answer nothing for an id that is not a session id', async () => {
    should(await words([message('a', 'hello')]).said('not a session')).eql([]);
  });
});
