import { describe, expect, it } from 'bun:test';
import {
  buildStartBody,
  canStartFerret,
  emptyNewFerretDraft,
  type NewFerretDraft,
  startAttemptFor,
  startFerret,
} from '../../../../app/features/new-ferret/new-ferret-draft.ts';
import { type Call, scripted } from '../support/client.ts';

const draft = (overrides: Partial<NewFerretDraft> = {}): NewFerretDraft => ({
  ...emptyNewFerretDraft,
  runtime: 'claude-a',
  folder: '/work/a',
  prompt: 'Go',
  ...overrides,
});

describe('canStartFerret', () => {
  it('needs a runtime, a folder and — in auto mode — a prompt', () => {
    expect(canStartFerret(emptyNewFerretDraft, false)).toBeFalse();
    expect(canStartFerret(draft(), false)).toBeTrue();
    expect(canStartFerret(draft({ runtime: '  ' }), false)).toBeFalse();
    expect(canStartFerret(draft({ folder: ' ' }), false)).toBeFalse();
    expect(canStartFerret(draft({ prompt: ' ' }), false)).toBeFalse();
  });

  it('lets an interactive ferret start bare, and nothing start twice', () => {
    expect(canStartFerret(draft({ mode: 'interactive', prompt: '' }), false)).toBeTrue();
    expect(canStartFerret(draft(), true)).toBeFalse();
  });
});

describe('buildStartBody', () => {
  it('trims text, drops blanks and sends the options flat as the daemon parses them', () => {
    expect(
      buildStartBody(
        draft({
          runtime: ' claude-a ',
          folder: ' /work/a ',
          model: ' opus ',
          label: ' site ',
          prompt: ' Go ',
          fast: true,
          remoteControl: true,
        }),
      ),
    ).toEqual({
      runtime: 'claude-a',
      folder: '/work/a',
      model: 'opus',
      mode: 'auto',
      fast: true,
      remoteControl: true,
      label: 'site',
      prompt: 'Go',
    });
  });

  it('sends fast and Remote Control only when they were asked for', () => {
    const body = buildStartBody(draft({ model: '', label: '' }));
    expect(body).toEqual({ runtime: 'claude-a', folder: '/work/a', mode: 'auto', prompt: 'Go' });
    expect(body).not.toHaveProperty('fast');
    expect(body).not.toHaveProperty('remoteControl');
  });

  it('refuses a body the daemon would refuse: a runtime that is not a name, or no folder', () => {
    expect(() => buildStartBody(draft({ runtime: 'Not A Runtime!' }))).toThrow();
    expect(() => buildStartBody(draft({ folder: '' }))).toThrow();
  });
});

describe('startFerret', () => {
  it('posts the body through the route key and answers the new ferret’s id', async () => {
    const calls: Call[] = [];
    const id = await startFerret(scripted({ 'POST /v1/ferrets': { id: 'f9' } }, calls), draft());
    expect(id).toBe('f9');
    expect(calls).toEqual([
      {
        route: 'POST /v1/ferrets',
        params: undefined,
        query: undefined,
        body: { runtime: 'claude-a', folder: '/work/a', mode: 'auto', prompt: 'Go' },
        headers: { 'x-fy-request-id': expect.any(String) },
      },
    ]);
  });

  it('carries a request id the daemon requires (a start with none is refused), the caller’s own when given', async () => {
    const calls: Call[] = [];
    const client = scripted({ 'POST /v1/ferrets': { id: 'f9' } }, calls);
    await startFerret(client, draft());
    await startFerret(client, draft(), 'req-1');
    expect(calls[0]?.headers?.['x-fy-request-id']).toMatch(/\S+/u);
    expect(calls[1]?.headers).toEqual({ 'x-fy-request-id': 'req-1' });
  });

  it('lets a daemon refusal through with its own sentence, and refuses an answer with no id', async () => {
    await expect(startFerret(scripted({ 'POST /v1/ferrets': new Error('no such runtime') }), draft())).rejects.toThrow(
      'no such runtime',
    );
    await expect(startFerret(scripted({ 'POST /v1/ferrets': {} }), draft())).rejects.toThrow();
  });
});

/** A daemon that commits starts by (request id, body) like the real one, and a transport that can lose a successful answer. */
function daemonThatLosesAnswers(loseFirst: number) {
  const started = new Map<string, { payload: string; id: string }>();
  const posts: string[] = [];
  let lost = 0;
  const client = scripted({
    'POST /v1/ferrets': (call: Call) => {
      const requestId = call.headers?.['x-fy-request-id'] ?? '';
      posts.push(requestId);
      const payload = JSON.stringify(call.body);
      const held = started.get(requestId);
      const id = held?.payload === payload ? held.id : `f${String(started.size + 1)}`;
      if (held === undefined) started.set(requestId, { payload, id });
      // The start is COMMITTED; only the answer is lost.
      if (lost < loseFirst) {
        lost += 1;
        throw new TypeError('fetch failed');
      }
      return { id };
    },
    'GET /v1/ferrets/by-request/:requestId': () => {
      throw new Error('recovery unavailable');
    },
  });
  return { client, started, posts };
}

describe('a start whose answer was lost', () => {
  it('keeps one attempt for the same draft, so a resubmit after a lost answer starts ONE ferret', async () => {
    const world = daemonThatLosesAnswers(3);
    const first = startAttemptFor(draft());
    await expect(startFerret(world.client, draft(), first)).rejects.toThrow('fetch failed');

    // The page keeps the attempt and the person presses Submit again with the draft unchanged.
    const again = startAttemptFor(draft(), first);
    expect(again).toBe(first);
    const id = await startFerret(world.client, draft(), again);

    expect(id).toBe('f1');
    expect(world.started.size).toBe(1);
    expect(new Set(world.posts).size).toBe(1);
  });

  it('mints a fresh id only for a draft that changed: a genuinely new start', () => {
    const first = startAttemptFor(draft());
    expect(startAttemptFor(draft(), first)).toBe(first);
    const changed = startAttemptFor(draft({ prompt: 'Go elsewhere' }), first);
    expect(changed.requestId).not.toBe(first.requestId);
    expect(changed.payload).not.toBe(first.payload);
  });

  it('retries the same POST once and then asks the daemon which ferret that request id started', async () => {
    const calls: Call[] = [];
    let posts = 0;
    const client = scripted(
      {
        'POST /v1/ferrets': () => {
          posts += 1;
          throw new TypeError('fetch failed');
        },
        'GET /v1/ferrets/by-request/:requestId': { id: 'f7' },
      },
      calls,
    );
    const attempt = startAttemptFor(draft());

    expect(await startFerret(client, draft(), attempt)).toBe('f7');

    expect(posts).toBe(2);
    const recovery = calls.at(-1);
    expect(recovery?.params).toEqual({ requestId: attempt.requestId });
    // The digest is the sha-256 of the exact body text the attempt holds.
    const expected = new Bun.CryptoHasher('sha256').update(attempt.payload).digest('hex');
    expect(recovery?.query).toEqual({ payload: expected });
  });

  it('throws the original failure when this browser cannot digest the body, so recovery cannot be asked', async () => {
    const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    try {
      const calls: Call[] = [];
      const client = scripted({ 'POST /v1/ferrets': new TypeError('fetch failed') }, calls);

      await expect(startFerret(client, draft(), startAttemptFor(draft()))).rejects.toThrow('fetch failed');
      expect(calls.map(call => call.route)).toEqual(['POST /v1/ferrets', 'POST /v1/ferrets']);
    } finally {
      if (subtle !== undefined) Object.defineProperty(globalThis.crypto, 'subtle', subtle);
    }
  });

  it('throws a daemon refusal at once: an answered start did not happen, and nothing is retried', async () => {
    const calls: Call[] = [];
    const refusal = Object.assign(new Error('no such runtime'), { status: 404 });
    const client = scripted({ 'POST /v1/ferrets': refusal }, calls);

    await expect(startFerret(client, draft(), startAttemptFor(draft()))).rejects.toThrow('no such runtime');
    expect(calls).toHaveLength(1);
  });

  it('throws the original failure when the recovery finds nothing, and the attempt can be sent again', async () => {
    const world = daemonThatLosesAnswers(2);
    const attempt = startAttemptFor(draft());

    await expect(startFerret(world.client, draft(), attempt)).rejects.toThrow('fetch failed');
    expect(await startFerret(world.client, draft(), attempt)).toBe('f1');
  });
});
