/**
 * Proves the clean-up a Live turn gets: Fix only. A configured Polish runs as Fix with a device key,
 * is skipped (words as heard) when only the machine's key could be used, and every failure keeps the
 * words. The provider and the daemon are fakes behind the same ports dictation's own tests use.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../../src/lib/stt/stt-settings.ts';
import { DeviceSpeedupKeys, type SpeedupKeyRecords } from '../../../src/lib/stt/speedup-keys.ts';
import {
  DEFAULT_VOICE_CLEANUP,
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  type VoiceCleanup,
} from '../../../src/lib/stt/voice-cleanup.ts';
import {
  cleanLiveTurn,
  LIVE_CLEANUP_TIMEOUT_MS,
  type LiveCleanupDeps,
} from '../../../src/lib/voice-chat/live-cleanup.ts';

class MemoryRecords implements SpeedupKeyRecords {
  readonly values = new Map<string, unknown>();
  async get(slot: string): Promise<unknown> {
    return this.values.get(slot);
  }
  async put(slot: string, value: unknown): Promise<void> {
    this.values.set(slot, value);
  }
  async delete(slot: string): Promise<void> {
    this.values.delete(slot);
  }
}

const daemon = daemonConnection({
  daemonId: 'daemon-alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'token-alpha',
});
const signal = new AbortController().signal;
const reply = (content: string): Response =>
  Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });

interface Rig {
  readonly deps: LiveCleanupDeps;
  readonly providerCalls: Record<string, unknown>[];
  readonly daemonCalls: Record<string, unknown>[];
}

const rig = async (
  options: {
    settings?: Partial<SttSettings>;
    cleanup?: Partial<VoiceCleanup>;
    key?: boolean;
    provider?: (body: Record<string, unknown>) => Response | Promise<Response>;
    daemon?: () => Response | Promise<Response>;
    context?: readonly string[];
  } = {},
): Promise<Rig> => {
  const providerCalls: Record<string, unknown>[] = [];
  const daemonCalls: Record<string, unknown>[] = [];
  const keys = new DeviceSpeedupKeys(new MemoryRecords(), crypto.subtle, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    providerCalls.push(body);
    return await (options.provider ?? (() => reply('Hello world, this is the dictation.')))(body);
  });
  if (options.key !== false) await keys.save('groq', 'gsk_test_0123456789abcdef');
  const deps: LiveCleanupDeps = {
    settings: { ...DEFAULT_STT_SETTINGS, enhancement: true, enhancementProvider: 'groq', ...options.settings },
    cleanup: { ...DEFAULT_VOICE_CLEANUP, ...options.cleanup },
    keys: options.key === false ? null : keys,
    daemon,
    fetchImpl: async (_url, init) => {
      daemonCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return await (
        options.daemon ?? (() => Response.json({ text: 'Hello world, this is the dictation.', provider: 'groq' }))
      )();
    },
    readContext: () => options.context ?? [],
  };
  return { deps, providerCalls, daemonCalls };
};

const TEXT = 'hello wold this is the dictation';

describe('cleanLiveTurn — what is cleaned and what is not', () => {
  it('leaves the words alone when clean-up is off, or there are none', async () => {
    const off = await rig({ settings: { enhancement: false } });
    should(await cleanLiveTurn(TEXT, off.deps, signal)).deepEqual({ text: TEXT, kept: 'raw' });
    const on = await rig();
    should(await cleanLiveTurn('   ', on.deps, signal)).deepEqual({ text: '   ', kept: 'raw' });
    should(on.providerCalls.length).equal(0);
  });

  it('corrects names on this device with no network at all', async () => {
    const { deps } = await rig({ settings: { enhancementProvider: 'local', dictionary: ['kteam = kteem'] } });
    should(await cleanLiveTurn('run kteem now', deps, signal)).deepEqual({ text: 'run kteam now', kept: 'cleaned' });
    should(await cleanLiveTurn('nothing to fix here', deps, signal)).deepEqual({
      text: 'nothing to fix here',
      kept: 'raw',
    });
  });

  it('sends nothing when the machine has clean-up off', async () => {
    const { deps, providerCalls, daemonCalls } = await rig({ cleanup: { style: 'off' } });
    should(await cleanLiveTurn(TEXT, deps, signal)).deepEqual({ text: TEXT, kept: 'raw' });
    should(providerCalls.length + daemonCalls.length).equal(0);
  });
});

describe('cleanLiveTurn — Fix only', () => {
  it('uses this device key straight to the provider and runs a configured Polish as Fix', async () => {
    const { deps, providerCalls, daemonCalls } = await rig({ cleanup: { style: 'polish' } });
    const result = await cleanLiveTurn(TEXT, deps, signal);
    should(result).deepEqual({ text: 'Hello world, this is the dictation.', kept: 'cleaned' });
    should(providerCalls.length).equal(1);
    should(daemonCalls.length).equal(0);
    const system = JSON.stringify(providerCalls[0]);
    should(system).containEql(JSON.stringify(DEFAULT_VOICE_CLEANUP_PROMPTS.fix).slice(1, 60));
    should(system).not.containEql(JSON.stringify(DEFAULT_VOICE_CLEANUP_PROMPTS.polish).slice(1, 60));
  });

  it('asks the daemon when there is no device key and the machine style is Fix', async () => {
    const { deps, daemonCalls } = await rig({ key: false });
    should(await cleanLiveTurn(TEXT, deps, signal)).deepEqual({
      text: 'Hello world, this is the dictation.',
      kept: 'cleaned',
    });
    should(daemonCalls.length).equal(1);
  });

  it('leaves the words as heard when only the machine key could run and its style is Polish', async () => {
    const { deps, daemonCalls } = await rig({ key: false, cleanup: { style: 'polish' } });
    should(await cleanLiveTurn(TEXT, deps, signal)).deepEqual({ text: TEXT, kept: 'raw' });
    should(daemonCalls.length).equal(0);
  });

  it('passes the conversation along only when the machine allows it, newest last and bounded', async () => {
    const { deps, providerCalls } = await rig({
      cleanup: { useConversation: true, conversationMessages: 2 },
      context: ['alpha-msg', 'beta-msg', 'gamma-msg'],
    });
    await cleanLiveTurn(TEXT, deps, signal);
    const body = JSON.stringify(providerCalls[0]);
    should(body).containEql('gamma-msg');
    should(body).containEql('beta-msg');
    should(body).not.containEql('alpha-msg');
    const plain = await rig({ context: ['secret chatter'] });
    await cleanLiveTurn(TEXT, plain.deps, signal);
    should(JSON.stringify(plain.providerCalls[0])).not.containEql('secret chatter');
  });

  it('is bounded: the deadline is short enough not to hold a send hostage', () => {
    should(LIVE_CLEANUP_TIMEOUT_MS).be.belowOrEqual(3_000);
  });
});

describe('cleanLiveTurn — when it does not work', () => {
  it('keeps the words when the provider answers nothing new or the guard refuses', async () => {
    const same = await rig({ provider: () => reply(TEXT) });
    should(await cleanLiveTurn(TEXT, same.deps, signal)).deepEqual({ text: TEXT, kept: 'raw' });
    const blank = await rig({ provider: () => reply('   ') });
    should((await cleanLiveTurn(TEXT, blank.deps, signal)).kept).equal('raw');
    const refused = await rig({
      key: false,
      daemon: () => Response.json({ text: TEXT, kept: 'raw', keptReason: 'x' }),
    });
    should(await cleanLiveTurn(TEXT, refused.deps, signal)).deepEqual({ text: TEXT, kept: 'raw' });
  });

  it('keeps the words on any failure: a provider error, the daemon down, a bad answer', async () => {
    const provider = await rig({ provider: () => new Response('no', { status: 500 }) });
    should(await cleanLiveTurn(TEXT, provider.deps, signal)).deepEqual({ text: TEXT, kept: 'raw' });
    const down = await rig({
      key: false,
      daemon: () => {
        throw new Error('offline');
      },
    });
    should(await cleanLiveTurn(TEXT, down.deps, signal)).deepEqual({ text: TEXT, kept: 'raw' });
    const aborted = new AbortController();
    aborted.abort();
    const early = await rig();
    should(await cleanLiveTurn(TEXT, early.deps, aborted.signal)).deepEqual({ text: TEXT, kept: 'raw' });
  });
});
