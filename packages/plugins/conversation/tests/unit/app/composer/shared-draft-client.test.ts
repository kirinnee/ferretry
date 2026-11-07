import { describe, expect, test } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { daemonConnection, daemonFerretScope } from '../../../../app/composer/seam.ts';
import { editSharedDraft, fetchSharedDraft } from '../../../../app/composer/shared-draft-client.ts';

const FERRET = 'mvuc7tsf-0c3d50df' as FerretId;
const daemon = daemonConnection('up');
const scope = daemonFerretScope(daemon, FERRET);
const snapshot = {
  v: 1 as const,
  ferret: FERRET,
  generation: 'gen-1',
  epoch: 0,
  rev: 1,
  text: 'hi',
  items: [],
  updatedAt: '2026-11-01T00:00:00.000Z' as Instant,
};

interface Call {
  readonly route: string;
  readonly init?: unknown;
}

/** A fake of the half's client: records each call and answers with `answer`, or throws it when it is an error. */
const caller = (answer: unknown) => {
  const calls: Call[] = [];
  return {
    calls,
    call: async <Answer>(route: string, init?: unknown): Promise<Answer> => {
      calls.push({ route, ...(init === undefined ? {} : { init }) });
      if (answer instanceof Error) throw answer;
      return answer as Answer;
    },
  };
};

describe('shared draft client', () => {
  test('reads the ferret’s own draft from its own route', async () => {
    const client = caller(snapshot);
    const draft = await fetchSharedDraft(client, scope);
    expect(draft).toEqual(snapshot);
    expect(client.calls).toEqual([
      { route: 'GET /v1/ferrets/:ferretId/shared-draft', init: { params: { ferretId: FERRET } } },
    ]);
  });

  test('reads an Agenda item’s own draft from the same route, naming its item', async () => {
    const card = daemonFerretScope(daemon, FERRET, 'A5');
    const client = caller({ ...snapshot, slot: 'A5' });
    const draft = await fetchSharedDraft(client, card);
    expect(draft.slot).toBe('A5');
    expect(client.calls).toEqual([
      {
        route: 'GET /v1/ferrets/:ferretId/shared-draft',
        init: { params: { ferretId: FERRET }, query: { item: 'A5' } },
      },
    ]);
  });

  test('refuses the chat’s draft for a card, and a card’s for the chat', async () => {
    const card = daemonFerretScope(daemon, FERRET, 'A5');
    await expect(fetchSharedDraft(caller(snapshot), card)).rejects.toMatchObject({ status: 502 });
    await expect(fetchSharedDraft(caller({ ...snapshot, slot: 'A6' }), card)).rejects.toMatchObject({ status: 502 });
    await expect(fetchSharedDraft(caller({ ...snapshot, slot: 'A5' }), scope)).rejects.toMatchObject({ status: 502 });
  });

  test('posts an edit and returns the edit as the daemon sequenced it', async () => {
    const client = caller({
      applied: { generation: 'gen-1', epoch: 0, rev: 2, text: [2, '!'], add: [], remove: [] },
      snapshot: { ...snapshot, rev: 2, text: 'hi!' },
    });
    const result = await editSharedDraft(client, scope, { generation: 'gen-1', epoch: 0, base: 1, text: [2, '!'] });
    expect(client.calls).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/shared-draft',
        init: { params: { ferretId: FERRET }, body: { generation: 'gen-1', epoch: 0, base: 1, text: [2, '!'] } },
      },
    ]);
    expect(result.snapshot.text).toBe('hi!');
  });

  test('keeps the daemon’s own refusal code, so the composer can tell stale from too long', async () => {
    const refused = editSharedDraft(
      caller(new DaemonCallError(409, 'shared_draft_stale', 'read the draft again')),
      scope,
      { generation: 'gen-1', epoch: 0, base: 0 },
    );
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'shared_draft_stale' });
  });

  test('refuses another ferret’s draft and a shapeless answer', async () => {
    const foreign = fetchSharedDraft(caller({ ...snapshot, ferret: 'mvuc7tsf-11111111' }), scope);
    await expect(foreign).rejects.toBeInstanceOf(DaemonCallError);
    await expect(fetchSharedDraft(caller({ text: 'hi' }), scope)).rejects.toMatchObject({ status: 502 });
    const noDraft = editSharedDraft(caller({}), scope, { generation: 'gen-1', epoch: 0, base: 0 });
    await expect(noDraft).rejects.toMatchObject({ status: 502 });
  });
});
