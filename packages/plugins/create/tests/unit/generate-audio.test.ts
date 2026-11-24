import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { SPEND_LEDGER } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { dayOf } from '../../daemon/lib/spend.ts';

const FAL_KEY = 'fal-test-key-0123456789';
const XI_KEY = 'xi-test-key-9876543210';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0x21, 1, 2, 3, 4]);
const CDN = 'https://v3.fal.media/files/lion/sound.mp3';
const SFX_PATH = '/fal-ai/elevenlabs/sound-effects/v2';
const MUSIC_PATH = '/fal-ai/elevenlabs/music';

/** fal, ElevenLabs and fal's storage as they answer, remembering every request that reached them. */
class FakeProviders {
  readonly seen: { host: string; path: string; method: string; headers: Headers; body: string | undefined }[] = [];
  /** What fal's price endpoint answers per endpoint; `undefined` = no row. */
  prices = new Map<string, { unit_price: number; unit: string }>([
    ['fal-ai/elevenlabs/sound-effects/v2', { unit_price: 0.002, unit: 'seconds' }],
    ['fal-ai/elevenlabs/music', { unit_price: 0.6, unit: 'minutes' }],
  ]);
  priceStatus = 200;
  /** How a fal run ends: a status, or `drops` (the connection dies). */
  falRunStatus = 200;
  falRunDrops = false;
  falAnswer: unknown = { audio: { url: CDN, content_type: 'audio/mpeg' } };
  audioUrl = CDN;
  audioType = 'audio/mpeg';
  audio: Uint8Array = MP3;
  cdn: 'ok' | 'not-found' | 'throws' | 'declares-huge' = 'ok';
  /** How ElevenLabs answers: its JSON, a status, a raw audio body (which the Vault refuses), or a dropped connection. */
  xi: 'ok' | 'raw-audio' | 'drops' | number = 'ok';
  xiAnswer: unknown = undefined;
  speech: Uint8Array = MP3;

  readonly fetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    this.seen.push({
      host: url.host,
      path: url.pathname + url.search,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.host === 'api.fal.ai') {
      if (this.priceStatus !== 200) return new Response('no', { status: this.priceStatus });
      const endpoint = url.searchParams.get('endpoint_id') ?? '';
      const row = this.prices.get(endpoint);
      return Response.json({ prices: row === undefined ? [] : [{ endpoint_id: endpoint, currency: 'USD', ...row }] });
    }
    if (url.host === 'fal.run') {
      if (this.falRunDrops) throw new Error('connection dropped');
      if (this.falRunStatus !== 200) return new Response('no', { status: this.falRunStatus });
      const answer = this.falAnswer as { audio?: { url: string } };
      return Response.json(answer.audio === undefined ? answer : { audio: { url: this.audioUrl } });
    }
    if (url.host === 'api.elevenlabs.io') {
      if (this.xi === 'drops') throw new Error('connection dropped');
      if (typeof this.xi === 'number') return new Response('no', { status: this.xi });
      if (this.xi === 'raw-audio')
        return new Response(
          this.speech.buffer.slice(
            this.speech.byteOffset,
            this.speech.byteOffset + this.speech.byteLength,
          ) as ArrayBuffer,
          { status: 200, headers: { 'content-type': 'audio/mpeg' } },
        );
      return Response.json(
        this.xiAnswer ?? {
          audio_base64: Buffer.from(this.speech).toString('base64'),
          alignment: {
            characters: ['h', 'i'],
            character_start_times_seconds: [0, 0.1],
            character_end_times_seconds: [0.1, 0.2],
          },
        },
      );
    }
    if (url.host.endsWith('fal.media')) {
      // A plain reply object: the unit tier runs many files in one process, some of which replace the global
      // `Response` and `Blob`, and these bytes must reach the tool exactly as they are here.
      if (this.cdn === 'throws') throw new Error('connection reset');
      const bytes = this.audio;
      return {
        ok: this.cdn !== 'not-found',
        status: this.cdn === 'not-found' ? 404 : 200,
        headers: new Map<string, string>([
          ['content-type', this.audioType],
          ...(this.cdn === 'declares-huge' ? ([['content-length', String(64 * 1024 * 1024)]] as const) : []),
        ]) as unknown as Headers,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    }
    throw new Error(`the fakes were asked for ${url.host}`);
  };

  to(host: string): readonly (typeof this.seen)[number][] {
    return this.seen.filter(request => request.host === host);
  }
}

interface World {
  readonly fake: FakeProviders;
  readonly asks: FakeAsks;
  readonly delivered: { ferret: string; name: string; bytes: number }[];
  readonly host: Awaited<ReturnType<typeof testHost>>;
  readonly standing: { current: CallStanding };
}

async function world(
  options: {
    fal?: boolean;
    xi?: boolean;
    limits?: { dailyUsd?: number; askAboveUsd?: number };
    ledger?: readonly object[];
    deliver?: 'ok' | 'nowhere';
  } = {},
): Promise<World> {
  const standing: { current: CallStanding } = { current: ferretStanding(ferretId('test-ferret')) };
  const fake = new FakeProviders();
  const asks = new FakeAsks();
  const delivered: World['delivered'] = [];
  const ferrets = {
    harness: async (ferret: string) =>
      options.deliver === 'nowhere'
        ? undefined
        : {
            deliverMedia: async (files: readonly { name: string; contents: Uint8Array }[]) =>
              files.map(file => {
                delivered.push({ ferret, name: file.name, bytes: file.contents.byteLength });
                return file.name;
              }),
          },
  };
  const config = {
    ...(options.fal === false ? {} : { fal: { key: '${secret:FAL_KEY}' } }),
    ...(options.xi === false ? {} : { elevenlabs: { key: '${secret:ELEVENLABS_API_KEY}' } }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => standing.current),
    fakes: { asks, ferrets },
    fetch: fake.fetch,
    vault: { FAL_KEY, ELEVENLABS_API_KEY: XI_KEY },
    config: { 'create.yaml': config },
  });
  if (options.ledger !== undefined)
    host
      .state('create')
      .plant(
        SPEND_LEDGER,
        options.ledger
          .map(line => JSON.stringify({ format: 1, ...line, day: dayOf(new Date(host.clock.nowMs()), 'UTC') }))
          .join('\n') + '\n',
      );
  return { fake, asks, delivered, host, standing };
}

const speak = (w: World, input: Record<string, unknown> = {}) =>
  w.host.tool('generate_speech', { text: 'Hello from the fox.', ...input });
const sfx = (w: World, input: Record<string, unknown> = {}) =>
  w.host.tool('generate_sfx', { prompt: 'a small bell', ...input });
const music = (w: World, input: Record<string, unknown> = {}) =>
  w.host.tool('generate_music', { prompt: 'a calm piano jingle', ...input });

const ledgerLines = (w: World): readonly Record<string, unknown>[] =>
  (w.host.state('create').files.get('ledger.jsonl') ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
const net = (w: World): number =>
  ledgerLines(w).reduce((sum, line) => sum + (line.refund === true ? -1 : 1) * (line.microUsd as number), 0);
const planted = (microUsd: number) => ({
  at: '2026-11-24T08:00:00.000Z',
  tool: 'generate_image',
  model: 'flux-pro',
  ferret: 'other',
  microUsd,
  priced: 'table',
  request: '0123456789abcdef',
});

describe('generate_speech: ElevenLabs’ JSON endpoint, priced from the table before it is sent', () => {
  test('reads the text through /with-timestamps with the key as xi-api-key, and hands over the decoded audio', async () => {
    const w = await world();
    const answer = await speak(w);
    expect(answer.isError).toBeUndefined();
    const sent = w.fake.to('api.elevenlabs.io');
    expect(sent).toHaveLength(1);
    // the JSON endpoint (raw audio is not allowed through the Vault), the default voice, the 64 kbit/s MP3
    expect(sent[0]!.path).toBe('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/with-timestamps?output_format=mp3_44100_64');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers.get('xi-api-key')).toBe(XI_KEY);
    expect(sent[0]!.headers.get('authorization')).toBeNull();
    expect(JSON.parse(sent[0]!.body!)).toEqual({ text: 'Hello from the fox.', model_id: 'eleven_flash_v2_5' });
    // fal was never asked, and the fal key never went to ElevenLabs
    expect(w.fake.to('fal.run')).toHaveLength(0);
    // 19 characters at $0.05 per 1 000 = $0.00095
    expect(answer.text).toContain('Made one voiceover with flash for $0.001 (the listed price');
    expect(answer.text).toContain(
      'Put these lines in your reply:\nflash voice, 19 characters · $0.001 · $0.001 of $5.00 today\n```fy-render\ntype: audio\nalt: Hello from the fox.\nsrc: media:create-speech-flash-',
    );
    expect(w.delivered).toEqual([
      {
        ferret: 'test-ferret',
        name: expect.stringMatching(/^create-speech-flash-[0-9a-f]{8}\.mp3$/u),
        bytes: MP3.byteLength,
      },
    ]);
    expect(ledgerLines(w)).toMatchObject([
      { tool: 'generate_speech', model: 'flash', ferret: 'test-ferret', microUsd: 950, priced: 'table' },
    ]);
    // nothing the ferret reads holds either key, and nothing the ledger keeps holds a key or the text
    const kept = JSON.stringify([...w.host.state('create').files.values()]);
    for (const secret of [XI_KEY, FAL_KEY]) {
      expect(answer.text).not.toContain(secret);
      expect(kept).not.toContain(secret);
    }
    expect(kept).not.toContain('Hello from the fox');
    expect(w.host.logs.map(log => `${log.message} ${JSON.stringify(log.fields ?? {})}`).join('\n')).not.toContain(
      XI_KEY,
    );
  });

  test('a voice and the multilingual model are passed on, and the dearer model is priced as dearer', async () => {
    const w = await world();
    const answer = await speak(w, { voice: 'AZnzlk1XvdvUeBnXmlld', model: 'multilingual', text: 'x'.repeat(1000) });
    expect(answer.isError).toBeUndefined();
    const sent = w.fake.to('api.elevenlabs.io')[0]!;
    expect(sent.path).toContain('/v1/text-to-speech/AZnzlk1XvdvUeBnXmlld/with-timestamps');
    expect(JSON.parse(sent.body!).model_id).toBe('eleven_multilingual_v2');
    // 1 000 characters at $0.10 per 1 000
    expect(ledgerLines(w)).toMatchObject([{ model: 'multilingual', microUsd: 100_000 }]);
  });

  test('with no ElevenLabs key named in create.yaml nothing leaves the machine, whatever fal has', async () => {
    const w = await world({ xi: false });
    const answer = await speak(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('fy secret set ELEVENLABS_API_KEY');
    expect(w.fake.seen).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(0);
  });

  test('an invalid request spends nothing', async () => {
    const w = await world();
    for (const input of [
      { text: '' },
      { text: 'x'.repeat(1501) },
      { text: 'hi', voice: '../../v1/user' },
      { text: 'hi', voice: 'short' },
      { text: 'hi', model: 'v3' },
      { text: 'hi', extra: 1 },
    ]) {
      expect((await w.host.tool('generate_speech', input)).isError).toBe(true);
    }
    expect(w.fake.seen).toHaveLength(0);
  });

  test('raw audio is not allowed through the Vault: a binary reply is unreadable, and it stays counted (it may be billed)', async () => {
    const w = await world();
    w.fake.xi = 'raw-audio';
    const answer = await speak(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('could not read');
    expect(w.delivered).toHaveLength(0);
    expect(net(w)).toBe(950);
  });

  test('an answer with no audio, or audio that is not base64, is no speech', async () => {
    for (const reply of [{ alignment: {} }, { audio_base64: '' }, { audio_base64: 'not base64 !!' }, 'nope']) {
      const w = await world();
      w.fake.xiAnswer = reply;
      const answer = await speak(w);
      expect(answer.isError).toBe(true);
      expect(w.delivered).toHaveLength(0);
    }
  });

  test('only a definite no-charge gives the reservation back', async () => {
    for (const status of [401, 403, 422, 429]) {
      const w = await world();
      w.fake.xi = status;
      const answer = await speak(w);
      expect(answer.isError).toBe(true);
      expect(ledgerLines(w)).toMatchObject([{ microUsd: 950 }, { microUsd: 950, refund: true }]);
      expect(net(w)).toBe(0);
    }
    for (const how of [502, 'drops'] as const) {
      const w = await world();
      w.fake.xi = how;
      const answer = await speak(w);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('ElevenLabs may have billed it');
      expect(net(w)).toBe(950);
    }
  });

  test('a rejected key says ElevenLabs, not fal', async () => {
    const w = await world();
    w.fake.xi = 401;
    expect((await speak(w)).text).toContain('ElevenLabs refused the key');
  });

  test('speech past the chat’s 1 MB is kept but not shown', async () => {
    const w = await world();
    w.fake.speech = new Uint8Array(1024 * 1024 + 1);
    const answer = await speak(w);
    expect(answer.text).toContain('over the 1 MB the chat plays');
    expect(answer.text).not.toContain('fy-render');
    expect(w.delivered).toHaveLength(1);
  });

  test('speech that cannot be saved is said, and the spend stays recorded', async () => {
    const w = await world({ deliver: 'nowhere' });
    const answer = await speak(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('made and paid for');
    expect(net(w)).toBe(950);
  });
});

describe('generate_sfx: fal’s sound-effects endpoint, priced by the second', () => {
  test('prices from fal’s own rate, runs it, fetches the file with no key and shows a player', async () => {
    const w = await world();
    const answer = await sfx(w, { seconds: 5 });
    expect(answer.isError).toBeUndefined();
    expect(w.fake.seen.map(request => request.host)).toEqual(['api.fal.ai', 'fal.run', 'v3.fal.media']);
    expect(w.fake.seen[0]!.path).toContain('endpoint_id=fal-ai%2Felevenlabs%2Fsound-effects%2Fv2');
    expect(w.fake.seen[1]!.path).toBe(SFX_PATH);
    expect(w.fake.seen[1]!.headers.get('authorization')).toBe(`Key ${FAL_KEY}`);
    expect(w.fake.seen[2]!.headers.get('authorization')).toBeNull();
    expect(JSON.parse(w.fake.seen[1]!.body!)).toMatchObject({
      text: 'a small bell',
      duration_seconds: 5,
      output_format: 'mp3_44100_64',
    });
    // 5 s at $0.002 a second
    expect(answer.text).toContain('Made a 5 s sound effect for $0.01 (fal’s price');
    expect(answer.text).toContain(
      'Put these lines in your reply:\nsound effect, 5 s · $0.01 · $0.01 of $5.00 today\n```fy-render\ntype: audio\nalt: a small bell\nsrc: media:create-sfx-',
    );
    expect(ledgerLines(w)).toMatchObject([
      { tool: 'generate_sfx', model: 'sound-effects', microUsd: 10_000, priced: 'fal' },
    ]);
    expect(w.delivered).toHaveLength(1);
    expect(w.fake.to('api.elevenlabs.io')).toHaveLength(0);
  });

  test('the table prices it when fal’s price endpoint cannot be reached, and the length is the price', async () => {
    const w = await world();
    w.fake.priceStatus = 500;
    const answer = await sfx(w, { seconds: 22 });
    expect(answer.text).toContain('the listed price');
    expect(ledgerLines(w)).toMatchObject([{ microUsd: 44_000, priced: 'table' }]);
  });

  test('a per-minute live rate is read as whole minutes; a unit that cannot be read refuses and sends nothing', async () => {
    const w = await world();
    w.fake.prices.set('fal-ai/elevenlabs/sound-effects/v2', { unit_price: 0.1, unit: 'minutes' });
    await sfx(w, { seconds: 3 });
    expect(ledgerLines(w)).toMatchObject([{ microUsd: 100_000 }]);

    const odd = await world();
    odd.fake.prices.set('fal-ai/elevenlabs/sound-effects/v2', { unit_price: 1, unit: 'image' });
    const answer = await sfx(odd);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Create cannot price');
    expect(odd.fake.to('fal.run')).toHaveLength(0);
  });

  test('with no fal key nothing leaves the machine, whatever ElevenLabs has', async () => {
    const w = await world({ fal: false });
    const answer = await sfx(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('fy secret set FAL_KEY');
    expect(w.fake.seen).toHaveLength(0);
  });

  test('an invalid request spends nothing', async () => {
    const w = await world();
    for (const input of [
      { prompt: '' },
      { prompt: 'x', seconds: 23 },
      { prompt: 'x', seconds: 0.1 },
      { prompt: 'x', extra: 1 },
    ])
      expect((await w.host.tool('generate_sfx', input)).isError).toBe(true);
    expect(w.fake.seen).toHaveLength(0);
  });

  test('a fal run that refused is given back; one that may have been billed stays counted', async () => {
    const refused = await world();
    refused.fake.falRunStatus = 422;
    expect((await sfx(refused)).isError).toBe(true);
    expect(net(refused)).toBe(0);
    const dropped = await world();
    dropped.fake.falRunDrops = true;
    expect((await sfx(dropped)).isError).toBe(true);
    expect(net(dropped)).toBe(10_000);
  });

  test('what fal’s storage may answer wrongly never becomes a sound, and the spend is still recorded', async () => {
    const wrong: readonly [string, (fake: FakeProviders) => void][] = [
      ['answered 404', fake => (fake.cdn = 'not-found')],
      ['could not be fetched', fake => (fake.cdn = 'throws')],
      ['larger than Create will fetch', fake => (fake.cdn = 'declares-huge')],
      ['not a sound', fake => (fake.audioType = 'text/html')],
      ['empty file', fake => (fake.audio = new Uint8Array(0))],
      ['not on fal’s own storage', fake => (fake.audioUrl = 'https://evil.example/a.mp3')],
    ];
    for (const [sentence, arrange] of wrong) {
      const w = await world();
      arrange(w.fake);
      const answer = await sfx(w);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(sentence);
      expect(w.delivered).toHaveLength(0);
      expect(net(w)).toBe(10_000);
    }
  });
});

describe('generate_music: fal’s ElevenLabs music, billed by the whole minute', () => {
  test('a 10 second jingle is priced as a minute, and the length goes on the wire in milliseconds', async () => {
    const w = await world();
    const answer = await music(w, { seconds: 10, instrumental: true });
    expect(answer.isError).toBeUndefined();
    expect(w.fake.seen[1]!.path).toBe(MUSIC_PATH);
    expect(JSON.parse(w.fake.seen[1]!.body!)).toMatchObject({
      prompt: 'a calm piano jingle',
      music_length_ms: 10_000,
      force_instrumental: true,
      output_format: 'mp3_44100_64',
    });
    expect(answer.text).toContain('Made 10 s of music for $0.60');
    expect(answer.text).toContain('music, 10 s · $0.60 · $0.60 of $5.00 today');
    expect(answer.text).toContain('type: audio');
    expect(ledgerLines(w)).toMatchObject([
      { tool: 'generate_music', model: 'music', microUsd: 600_000, priced: 'fal' },
    ]);
  });

  test('a per-second live rate is also priced from the whole minute, never under what fal bills', async () => {
    const w = await world();
    w.fake.prices.set('fal-ai/elevenlabs/music', { unit_price: 0.01, unit: 'seconds' });
    await music(w, { seconds: 30 });
    expect(ledgerLines(w)).toMatchObject([{ microUsd: 600_000 }]);
  });

  test('the table prices it when fal cannot be asked', async () => {
    const w = await world();
    w.fake.priceStatus = 503;
    await music(w);
    expect(ledgerLines(w)).toMatchObject([{ microUsd: 600_000, priced: 'table' }]);
  });

  test('the length is bounded to short music, and an invalid request spends nothing', async () => {
    const w = await world();
    for (const input of [
      { prompt: '' },
      { prompt: 'x', seconds: 2 },
      { prompt: 'x', seconds: 61 },
      { prompt: 'x', seconds: 10.5 },
      { prompt: 'x', instrumental: 'yes' },
    ])
      expect((await w.host.tool('generate_music', input)).isError).toBe(true);
    expect(w.fake.seen).toHaveLength(0);
  });
});

/** What the owner reads under an ask: the draft Create raised, caught on its way to Asks. */
function watchRaised(w: World): { context?: string }[] {
  const raised: { context?: string }[] = [];
  const raise = w.asks.raise.bind(w.asks);
  w.asks.raise = async draft => {
    raised.push(draft);
    return await raise(draft);
  };
  return raised;
}

describe('one ledger, one cap, one queue for every tool', () => {
  test('a sound call that would pass $5 with a picture already bought is refused, and nothing is sent', async () => {
    const w = await world({ ledger: [planted(4_900_000)] });
    const answer = await music(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('daily limit of $5.00');
    expect(w.fake.to('fal.run')).toHaveLength(0);
    // the same day's cheaper tool still goes
    expect((await speak(w)).isError).toBeUndefined();
  });

  test('two ferrets asking for different tools together cannot both pass the same cap', async () => {
    const w = await world({ limits: { dailyUsd: 0.01 } });
    const [a, b] = await Promise.all([speak(w), sfx(w)]);
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    expect(ledgerLines(w)).toHaveLength(1);
  });

  test('a call over the one-call limit asks, sends nothing, and an approval is spent by the one call it approved', async () => {
    const w = await world({ limits: { askAboveUsd: 0.5 } });
    const raised = watchRaised(w);
    const waiting = await music(w);
    expect(waiting.isError).toBeUndefined();
    expect(waiting.text).toContain('Not sent yet');
    expect(waiting.text).toContain('call generate_music again');
    expect(w.fake.seen.filter(request => request.host === 'fal.run')).toHaveLength(0);
    const [open] = await w.asks.open({});
    expect(open).toMatchObject({ source: 'create-spend', kind: 'permission', blocking: true, ferret: 'test-ferret' });
    expect(open!.subject).toContain('a short piece of music');
    expect(raised[0]?.context).toBe('Prompt:\na calm piano jingle');

    w.asks.answerAs({ ferret: 'test-ferret', id: open!.id }, 'approve');
    // the same request goes through once; a different tool's request is a different question
    expect((await music(w)).text).toContain('Made 30 s of music');
    expect((await music(w)).text).toContain('Not sent yet');
    expect(ledgerLines(w)).toHaveLength(1);
  });

  test('a dear voiceover asks with its text, and a rejection refuses with what to do instead', async () => {
    const w = await world({ limits: { askAboveUsd: 0.01 } });
    const raised = watchRaised(w);
    const input = { text: 'y'.repeat(300), model: 'multilingual' }; // $0.03
    await speak(w, input);
    const [open] = await w.asks.open({});
    expect(open!.subject).toContain('a voiceover');
    expect(raised[0]?.context).toBe(`Text:\n${'y'.repeat(300)}`);
    w.asks.answerAs({ ferret: 'test-ferret', id: open!.id }, 'reject');
    const answer = await speak(w, input);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('declined');
    expect(answer.text).toContain('shorter text or the flash model');
    expect(w.fake.to('api.elevenlabs.io')).toHaveLength(0);
  });

  test('only a ferret may spend: the owner’s own call is refused for every tool', async () => {
    const w = await world();
    w.standing.current = ownerStanding();
    for (const name of ['generate_speech', 'generate_sfx', 'generate_music'])
      expect((await w.host.tool(name, { text: 'hi', prompt: 'hi' } as never)).isError).toBe(true);
    expect(w.fake.seen).toHaveLength(0);
  });
});
