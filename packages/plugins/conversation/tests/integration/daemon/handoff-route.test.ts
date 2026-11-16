import { describe, expect, test } from 'bun:test';
import mailboxDaemon from '@ferretry/core-mailbox/daemon';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretId, FerretTurnDocument, FerretTurns } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import { HandoffDocumentSchema } from '@ferretry/core-mailbox/contract';
import daemon from '../../../daemon/index.ts';
import { wardenStandIn } from '../../support/warden-plugin.ts';

/**
 * `GET /v1/ferrets/:ferretId/handoffs/:name` — what the owner actually sent in a turn document, read through the
 * daemon from Ferrets' own turn store. The owner's chat shows these words in place of "Read the file …/turn-001.md
 * now, then carefully follow every instruction inside it"; a route that cannot answer makes the chat say the file
 * "can no longer be read" although it is on disk.
 */

const F1 = ferretId('f1');

/** A Ferrets whose turn store holds exactly the documents a test gives it (best effort: a strict read is not used). */
class TurnDocs extends FakeFerrets {
  documents: readonly FerretTurnDocument[] = [];
  reads = 0;

  async turns(ferret: FerretId): Promise<FerretTurns | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      list: async () => {
        this.reads += 1;
        return this.documents;
      },
    };
  }
}

async function world(documents: readonly FerretTurnDocument[]) {
  const ferrets = new TurnDocs();
  ferrets.add({ id: F1, state: 'idle' });
  ferrets.documents = documents;
  const host = await testHost({
    plugins: [mailboxDaemon, daemon, wardenStandIn],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-08T09:00:00Z'),
  });
  const get = async (name: string, ferret = 'f1') =>
    await host.request('GET', `/v1/ferrets/${ferret}/handoffs/${name}`, { as: owner() });
  return { host, ferrets, get };
}

describe('the hand-off read route', () => {
  test('a new ferret’s opening turn answers the owner’s own words, without the assigned-task heading', async () => {
    const { get } = await world([{ turn: 1, text: '# Assigned task\n\nSmoke test: say hello.\n' }]);
    const response = await get('turn-001');
    expect(response.status).toBe(200);
    const body = HandoffDocumentSchema.parse(await response.json());
    expect(body).toEqual({ name: 'turn-001', message: 'Smoke test: say hello.', attachments: [] });
  });

  test('a later turn is answered by its number, and who it is from rides beside the words, never in them', async () => {
    const { get } = await world([
      { turn: 1, text: '# Assigned task\n\nfirst\n' },
      { turn: 8, text: 'please look again\n', by: { kind: 'ferretry', feature: 'warden' } },
    ]);
    const body = HandoffDocumentSchema.parse(await (await get('turn-008')).json());
    expect(body.message).toBe('please look again');
    expect(body.by).toEqual({ kind: 'ferretry', feature: 'warden' });
  });

  test('a revive’s protocol reminder is taken off the end of the words', async () => {
    const { get } = await world([
      { turn: 2, text: 'carry on\n\nContinue using the same completion and interaction protocol.\n' },
    ]);
    expect(HandoffDocumentSchema.parse(await (await get('turn-002')).json()).message).toBe('carry on');
  });

  test('files listed under the words come back as attachments; only a copy in the ferret’s own folder carries an id', async () => {
    const own = '/state/ferrets/sessions/f1/attachments/att-1/shot.png';
    const other = '/elsewhere/notes/att-2/notes.txt';
    const { get } = await world([
      {
        turn: 3,
        text: `see these\n\nAttached files — open them from these paths:\n- ${own} (image/png)\n- ${other} (text/plain)\n`,
      },
    ]);
    const body = HandoffDocumentSchema.parse(await (await get('turn-003')).json());
    expect(body.message).toBe('see these');
    expect(body.attachments).toEqual([
      { attachmentId: 'att-1', filename: 'shot.png', mime: 'image/png' },
      { filename: 'notes.txt', mime: 'text/plain' },
    ]);
  });

  test('a turn that is not on disk is a 404, so the chat says the file is gone only when it really is', async () => {
    const { get } = await world([{ turn: 1, text: '# Assigned task\n\nhi\n' }]);
    expect((await get('turn-009')).status).toBe(404);
  });

  test('a ferret this daemon does not know is a 404', async () => {
    const { get } = await world([{ turn: 1, text: 'hi\n' }]);
    expect((await get('turn-001', 'nobody')).status).toBe(404);
  });

  test('a name outside the closed grammar is refused before anything is read', async () => {
    const { get, ferrets } = await world([{ turn: 1, text: 'hi\n' }]);
    expect((await get('..%2Fenvironment')).status).toBe(400);
    expect(ferrets.reads).toBe(0);
  });
});
