import { describe, expect, it } from 'bun:test';
import { SHARED_DRAFT_ERROR_CODES } from '../../../../daemon/seams/protocol.ts';
import {
  SharedDraftError,
  type SharedDraftErrorCode,
  SharedDraftPresence,
  SharedDraftService,
  SharedDraftStreamHandler,
} from '../../../../daemon/drafts/lib/index.ts';
import {
  sharedDraftRoutes,
  sharedDraftSocketRoutes,
  sentDraftClearer,
} from '../../../../daemon/drafts/lib/mounts/shared-drafts.ts';
import { at } from '../../../support/instant.ts';
import { answerOf, callOf, refusalOf } from '../../../support/mount-call.ts';

const G = 'gen-1';
const OWNER = 'device:phone';
const ID = { ferretId: 's1' };
const PATH = '/v1/ferrets/:ferretId/shared-draft';

const service = () =>
  new SharedDraftService(
    {
      has: async sessionId => sessionId === 's1',
      hasOpenItem: async (_sessionId, item) => item === 'A1',
    },
    { load: async () => undefined, save: async () => undefined, remove: async () => undefined, items: async () => [] },
    { now: () => at('2026-11-01T00:00:00.000Z') },
    { after: () => ({ cancel: () => undefined }) },
    { next: () => G },
  );

const edit = (base: number, text: readonly (number | string)[]) => ({ generation: G, epoch: 0, base, text });

describe('the shared draft routes', () => {
  it('lets only the owner’s shell or one of their paired devices read or edit a draft', async () => {
    const routes = sharedDraftRoutes(service());
    for (const actor of [undefined, 'admin-ui', 'peer:f2', 'warden']) {
      const refusal = await refusalOf(routes, 'GET', PATH, { params: ID, actor });
      expect({ actor, status: refusal.status, code: refusal.code }).toEqual({
        actor,
        status: 403,
        code: SHARED_DRAFT_ERROR_CODES.ownerOnly,
      });
    }
    expect((await answerOf(routes, 'GET', PATH, { params: ID, actor: 'admin-cli' })).status).toBe(200);
    expect((await answerOf(routes, 'GET', PATH, { params: ID, actor: OWNER })).status).toBe(200);
  });

  it('reads a session’s chat draft, and an agenda item’s reply box with ?item=', async () => {
    const routes = sharedDraftRoutes(service());
    const chat = await answerOf(routes, 'GET', PATH, { params: ID, actor: OWNER });
    expect(chat.json).toMatchObject({ text: '' });
    const item = await answerOf(routes, 'GET', PATH, { params: ID, actor: OWNER, query: { item: 'A1' } });
    expect(item.status).toBe(200);
  });

  it('refuses an unusable session id, a repeated or malformed item, and a session or item it does not have', async () => {
    const routes = sharedDraftRoutes(service());
    const code = async (spec: Parameters<typeof refusalOf>[3]) => (await refusalOf(routes, 'GET', PATH, spec)).code;
    expect(await code({ params: { ferretId: '' }, actor: OWNER })).toBe('invalid_session_id');
    expect(await code({ params: ID, actor: OWNER, query: { item: ['A1', 'A2'] } })).toBe('invalid_query');
    expect(await code({ params: ID, actor: OWNER, query: { item: 'nonsense' } })).toBe(
      SHARED_DRAFT_ERROR_CODES.invalid,
    );
    expect(await code({ params: { ferretId: 'ghost' }, actor: OWNER })).toBe('not-found');
    expect(await code({ params: ID, actor: OWNER, query: { item: 'A9' } })).toBe('not-found');
  });

  it('applies an edit and answers it without the stream’s repeat marker', async () => {
    const routes = sharedDraftRoutes(service());
    const first = await answerOf(routes, 'POST', PATH, { params: ID, actor: OWNER, body: edit(0, ['hi']) });
    expect(first.status).toBe(200);
    expect(first.json).not.toHaveProperty('repeatOf');
    expect(first.json).toMatchObject({ snapshot: { text: 'hi' } });

    const slotted = await answerOf(routes, 'POST', PATH, {
      params: ID,
      actor: OWNER,
      query: { item: 'A1' },
      body: edit(0, ['reply']),
    });
    expect(slotted.json).toMatchObject({ snapshot: { text: 'reply' } });
  });

  it('refuses a stale edit with the status and code of that refusal', async () => {
    const routes = sharedDraftRoutes(service());
    const stale = await refusalOf(routes, 'POST', PATH, {
      params: ID,
      actor: OWNER,
      body: { generation: 'older', epoch: 0, base: 0, text: ['again'] },
    });
    expect(stale.status).toBe(409);
    expect(stale.code).toBe(SHARED_DRAFT_ERROR_CODES.stale);
  });

  it('words every draft refusal with its own status', async () => {
    const expected: Record<SharedDraftErrorCode, [number, string]> = {
      'not-found': [404, 'not-found'],
      stale: [409, SHARED_DRAFT_ERROR_CODES.stale],
      'too-long': [413, SHARED_DRAFT_ERROR_CODES.tooLong],
      'too-many-items': [413, SHARED_DRAFT_ERROR_CODES.tooManyItems],
      'rate-limited': [429, SHARED_DRAFT_ERROR_CODES.rateLimited],
      invalid: [422, SHARED_DRAFT_ERROR_CODES.invalid],
      'too-many-drafts': [413, SHARED_DRAFT_ERROR_CODES.tooManyDrafts],
    };
    for (const [failure, [status, code]] of Object.entries(expected) as Array<
      [SharedDraftErrorCode, [number, string]]
    >) {
      const failing = {
        read: async () => Promise.reject(new SharedDraftError(failure, 'no')),
      } as unknown as SharedDraftService;
      const refusal = await refusalOf(sharedDraftRoutes(failing), 'GET', PATH, { params: ID, actor: OWNER });
      expect({ failure, status: refusal.status, code: refusal.code }).toEqual({ failure, status, code });
    }
  });

  it('lets a failure that is not a draft’s own through unchanged', async () => {
    const failing = { read: async () => Promise.reject(new TypeError('boom')) } as unknown as SharedDraftService;
    expect((await refusalOf(sharedDraftRoutes(failing), 'GET', PATH, { params: ID, actor: OWNER })).message).toBe(
      'boom',
    );
  });
});

describe('the shared draft stream', () => {
  const STREAM = '/v1/ferrets/:ferretId/shared-draft/stream';
  const subsystem = (names: Record<string, string> = {}) => ({
    presence: new SharedDraftPresence(),
    deviceName: async (id: string) => names[id],
    nextPeer: () => 'peer-1',
    clock: { nowMs: () => 0 },
  });
  const accept = async (
    drafts: SharedDraftService,
    spec: Parameters<typeof callOf>[0],
    names?: Record<string, string>,
  ) => {
    const [route] = sharedDraftSocketRoutes(drafts, subsystem(names));
    return await route!.accept(callOf(spec));
  };
  const downstream = { send: () => 1, close: () => undefined, bufferedBytes: () => 0 };

  it('proves the session exists and the caller is the owner before the protocol switches', async () => {
    const drafts = service();
    expect(
      (
        await sharedDraftSocketRoutes(drafts, subsystem())[0]
          ?.accept(callOf({ params: ID, actor: 'peer:f2' }))
          .catch(e => e)
      )?.status,
    ).toBe(403);
    const missing = await accept(drafts, { params: { ferretId: 'ghost' }, actor: OWNER }).catch(error => error);
    expect(missing.status).toBe(404);
    const attach = await accept(drafts, { params: ID, actor: OWNER });
    expect(await attach(downstream as never)).toBeInstanceOf(SharedDraftStreamHandler);
    expect(STREAM).toContain('stream');
  });

  it('names the composer by the device’s own name, another device when it has none, and this computer for the shell', async () => {
    const drafts = service();
    for (const [actor, names] of [
      ['device:phone', { phone: 'Zoe’s phone' }],
      ['device:other', {}],
      ['admin-cli', {}],
    ] as const) {
      const attach = await accept(drafts, { params: ID, actor }, names);
      expect(await attach(downstream as never)).toBeInstanceOf(SharedDraftStreamHandler);
    }
  });

  it('takes a draft position only whole, and a slot only once', async () => {
    const drafts = service();
    const whole = { generation: G, epoch: '0', rev: '3' };
    const attach = await accept(drafts, { params: ID, actor: OWNER, query: { ...whole, item: 'A1' } });
    expect(await attach(downstream as never)).toBeInstanceOf(SharedDraftStreamHandler);

    const refused = async (query: Record<string, string | readonly string[]>) =>
      (await accept(drafts, { params: ID, actor: OWNER, query }).catch(error => error)).code;
    expect(await refused({ generation: G })).toBe('invalid_query');
    expect(await refused({ epoch: '0', rev: '1' })).toBe('invalid_query');
    expect(await refused({ generation: G, epoch: 'x', rev: '1' })).toBe('invalid_query');
    expect(await refused({ generation: G, epoch: '0', rev: '1234567890' })).toBe('invalid_query');
    expect(await refused({ generation: 'g'.repeat(65), epoch: '0', rev: '1' })).toBe('invalid_query');
    expect(await refused({ generation: '', epoch: '0', rev: '1' })).toBe('invalid_query');
    expect(await refused({ generation: [G, G], epoch: '0', rev: '1' })).toBe('invalid_query');
  });
});

describe('sentDraftClearer', () => {
  const sent = { generation: G, epoch: 0, base: 1, text: [1] as const };

  it('takes what a send carried out of the draft as the daemon’s own edit, for the owner only', async () => {
    const edits: unknown[][] = [];
    const clear = sentDraftClearer({ edit: async (...args: unknown[]) => void edits.push(args) } as never);
    await clear('s1', undefined, 'req-1', sent);
    await clear('s1', 'peer:f2', 'req-1', sent);
    expect(edits).toEqual([]);

    await clear('s1', OWNER, 'req-1', { ...sent, remove: ['i1'] });
    await clear('s1', 'admin-cli', 'req-2', { ...sent, slot: 'A1' });
    expect(edits).toHaveLength(2);
    expect(edits[0]?.[1]).toEqual({ generation: G, epoch: 0, base: 1, text: [1], remove: ['i1'], sent: true });
    expect(edits[0]?.[3]).toEqual({ metered: false });
    expect(edits[1]?.[3]).toEqual({ metered: false, slot: 'A1' });
  });

  it('never applies a send that would add words to the draft', async () => {
    const edits: unknown[][] = [];
    const clear = sentDraftClearer({ edit: async (...args: unknown[]) => void edits.push(args) } as never);
    await clear('s1', OWNER, 'req-1', { ...sent, text: [1, 'sneaky'] });
    expect(edits).toEqual([]);
  });
});
