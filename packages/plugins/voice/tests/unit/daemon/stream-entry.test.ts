import { describe, expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { ENTRY_LEASE_MS, VOICE_ENTRY_MESSAGE } from '../../../contract/index.ts';
import { enterVoiceChat, VoiceEntryRefused, type VoiceEntryDeps } from '../../../daemon/lib/stream/entry.ts';
import { StreamRegistry } from '../../../daemon/lib/stream/registry.ts';
import { voiceRoutes } from '../../../daemon/routes.ts';

/**
 * A phone's own voice mode asks the MACHINE to tell the ferret (`POST /v1/voice/entry`), against the same claim the stream
 * uses: one entry per chat however many tabs, devices and engines are in voice mode there.
 */

const SESSION = 'vm-test-session';

function rig(overrides: Partial<VoiceEntryDeps> & { refuse?: boolean } = {}) {
  const sent: { ferretId: string; message: string; sendId: string }[] = [];
  let now = 1_000_000;
  const registry = overrides.registry ?? new StreamRegistry();
  const deps: VoiceEntryDeps = {
    registry,
    clock: { nowMs: () => now },
    send: () => async (ferretId, message, sendId) => {
      sent.push({ ferretId, message, sendId });
      return overrides.refuse === true ? { ok: false, code: 'send_refused' } : { ok: true };
    },
    resolveFerret: async reference => (reference === 'nobody' ? undefined : `id-of-${reference}`),
    log: { info: () => undefined },
    ...overrides,
  };
  return {
    deps,
    registry,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ask = { ferretId: 'desk', session: SESSION };

describe('the phone asks the machine to tell the ferret', () => {
  test('the first ask sends the entry message, as the owner, under the session; the second (another tab, a phone) sends nothing', async () => {
    const r = rig();
    expect(await enterVoiceChat(r.deps, ask)).toEqual({ sent: true });
    expect(r.sent).toEqual([{ ferretId: 'id-of-desk', message: VOICE_ENTRY_MESSAGE, sendId: `voice-on:${SESSION}` }]);
    expect(await enterVoiceChat(r.deps, { ...ask, session: 'vm-another-tab' })).toEqual({ sent: false });
    expect(r.sent).toHaveLength(1);
  });

  test('the machine’s own stream and the phone share the claim: the one that came first sent it', async () => {
    const r = rig();
    // The machine's stream took the chat's claim for the same ferret.
    expect(r.registry.enterVoice('id-of-desk', 1_000_000)).toBe(true);
    expect(await enterVoiceChat(r.deps, ask)).toEqual({ sent: false });
    expect(r.sent).toEqual([]);
  });

  test('a phone that keeps asking keeps the claim; one that stops lets it lapse and the next voice mode sends again', async () => {
    const r = rig();
    await enterVoiceChat(r.deps, ask);
    for (let renewal = 0; renewal < 6; renewal += 1) {
      r.advance(ENTRY_LEASE_MS - 1_000);
      expect(await enterVoiceChat(r.deps, ask)).toEqual({ sent: false });
    }
    r.advance(ENTRY_LEASE_MS + 1_000);
    expect(await enterVoiceChat(r.deps, { ...ask, session: 'vm-later-session' })).toEqual({ sent: true });
    expect(r.sent.map(each => each.sendId)).toEqual([`voice-on:${SESSION}`, 'voice-on:vm-later-session']);
  });

  test('a refused or failed send gives the claim up, so the next ask is the one that sends', async () => {
    const refused = rig({ refuse: true });
    expect(await enterVoiceChat(refused.deps, ask)).toEqual({ sent: false });
    expect(refused.registry.enterVoice('id-of-desk', 1_000_000)).toBe(true);
    const thrown = rig({
      send: () => async () => {
        throw new Error('the conversation went away');
      },
    });
    expect(await enterVoiceChat(thrown.deps, ask)).toEqual({ sent: false });
    expect(thrown.registry.enterVoice('id-of-desk', 1_000_000)).toBe(true);
  });

  test('it says why it cannot: a body that is not an ask, no Conversation, a ferret nobody has', async () => {
    const r = rig();
    for (const body of [
      undefined,
      {},
      { ferretId: 'desk' },
      { ferretId: 'desk', session: 'short' },
      { ...ask, extra: 1 },
    ])
      expect(enterVoiceChat(r.deps, body)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(enterVoiceChat(rig({ send: () => undefined }).deps, ask)).rejects.toMatchObject({
      status: 409,
      code: 'voice_unavailable',
    });
    expect(enterVoiceChat(r.deps, { ...ask, ferretId: 'nobody' })).rejects.toBeInstanceOf(VoiceEntryRefused);
    expect(r.sent).toEqual([]);
  });

  test('a ferret whose name cannot even be looked up is a ferret nobody has', async () => {
    const r = rig({
      resolveFerret: async () => {
        throw new Error('the roster is unreadable');
      },
    });
    await expect(enterVoiceChat(r.deps, ask)).rejects.toMatchObject({ status: 404, code: 'ferret_unknown' });
    expect(r.sent).toEqual([]);
  });
});

describe('POST /v1/voice/entry', () => {
  const none = {} as never;
  const routes = (entry: Parameters<typeof voiceRoutes>[5]) => voiceRoutes(none, none, none, none, none, entry);
  const call = (body: string) =>
    ({ request: new Request('http://x/v1/voice/entry', { method: 'POST', body }) }) as never;

  test('answers what the machine did, and turns a refusal into the status it names', async () => {
    const r = rig();
    const handler = routes(body => enterVoiceChat(r.deps, body))['POST /v1/voice/entry'];
    const sent = await handler(call(JSON.stringify(ask)));
    expect(sent.status).toBe(200);
    expect(JSON.parse(String((sent as { body?: string }).body))).toEqual({ sent: true });
    const again = await handler(call(JSON.stringify(ask)));
    expect(JSON.parse(String((again as { body?: string }).body))).toEqual({ sent: false });
    for (const body of ['not json', JSON.stringify({ ferretId: 'desk' })]) {
      const failure = await handler(call(body)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(400);
    }
  });
});
