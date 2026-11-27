import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ferretStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { AVATAR_JOBS, isHeygenCdn, priceAvatarVideo, SPEND_LEDGER } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { dayOf } from '../../daemon/lib/spend.ts';

const HEYGEN_KEY = 'heygen-test-key-0123456789';
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4]);
const CDN = 'https://resource2.heygen.ai/video/transcode/abc/output.mp4';
const AVATAR = 'Daisy-inskirt-20220818';
const VOICE = '2d5b0e6cf36f460aa7fc47e3eee4ba54';

interface Made {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'strange' | 'gone';
  url: string | null;
}

/** The keys `POST /v3/videos` takes for an avatar video (the schema is `additionalProperties: false`); the fake refuses any other. */
const V3_AVATAR_KEYS = ['type', 'avatar_id', 'script', 'voice_id', 'aspect_ratio', 'resolution', 'engine'];

/**
 * HeyGen's API and storage as they answer, remembering every request that reached them. No real HeyGen is ever called.
 * It speaks only the v3 wire (`POST /v3/videos`, `GET /v3/videos/{id}`): the v2 and v1 paths HeyGen retired on 2026-10-31
 * answer 404, as the real API does, so a client still on them fails here.
 */
class FakeHeygen {
  readonly seen: { host: string; path: string; method: string; headers: Headers; body: string | undefined }[] = [];
  readonly videos = new Map<string, Made>();
  submit: 'ok' | 'drops' | 'garbled' | number = 'ok';
  /** The status read answers this instead of the video's own state while set. */
  statusAnswer: 'ok' | 'drops' | 500 = 'ok';
  cdn: 'ok' | 'not-found' | 'wrong-type' = 'ok';
  /** While set, storage answers only once this resolves: a download that is in flight. */
  cdnGate: Promise<void> | undefined;
  private count = 0;

  readonly fetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    this.seen.push({
      host: url.host,
      path: url.pathname + url.search,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.host === 'api.heygen.com') {
      const one = /^\/v3\/videos\/([^/]+)$/u.exec(url.pathname);
      if (method === 'POST' && url.pathname === '/v3/videos' && url.search === '') {
        if (this.submit === 'drops') throw new Error('connection dropped');
        if (typeof this.submit === 'number') return new Response('no', { status: this.submit });
        if (this.submit === 'garbled') return Response.json({ data: { nothing: true } });
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const stray =
          typeof body === 'object' && body !== null
            ? Object.keys(body).filter(key => !V3_AVATAR_KEYS.includes(key))
            : ['(no body)'];
        if (stray.length > 0)
          return Response.json(
            { error: { code: 'invalid_parameter', message: `unknown: ${stray.join(',')}` } },
            { status: 400 },
          );
        const id = `hv${++this.count}`;
        this.videos.set(id, { status: 'pending', url: null });
        return Response.json({ data: { video_id: id, status: 'waiting', output_format: 'mp4', resolution: '720p' } });
      }
      if (method === 'GET' && one !== null) {
        if (this.statusAnswer === 'drops') throw new Error('connection dropped');
        if (this.statusAnswer === 500) return new Response('no', { status: 500 });
        const id = decodeURIComponent(one[1]!);
        const video = this.videos.get(id);
        if (video === undefined || video.status === 'gone')
          return Response.json({ error: { code: 'not_found', message: 'Video not found.' } }, { status: 404 });
        return Response.json({ data: { id, status: video.status, video_url: video.url } });
      }
      return new Response('no such path', { status: 404 });
    }
    if (url.host.endsWith('heygen.ai')) {
      await this.cdnGate;
      if (this.cdn === 'not-found') return new Response('no', { status: 404 });
      return new Response(MP4, {
        headers: { 'content-type': this.cdn === 'wrong-type' ? 'text/html' : 'video/mp4' },
      });
    }
    throw new Error(`the fakes were asked for ${url.host}`);
  };

  to(host: string, method?: string) {
    return this.seen.filter(request => request.host === host && (method === undefined || request.method === method));
  }
  finish(id: string, how: Partial<Made> = {}): void {
    Object.assign(this.videos.get(id)!, { status: 'completed', url: CDN, ...how });
  }
}

interface World {
  readonly fake: FakeHeygen;
  readonly asks: FakeAsks;
  readonly delivered: { ferret: string; name: string; bytes: number }[];
  readonly host: Awaited<ReturnType<typeof testHost>>;
  readonly standing: { current: CallStanding };
  /** While true, a write to the jobs file fails (a full or damaged disk). */
  readonly jobsWrite: { fails: boolean };
}

async function world(
  options: {
    key?: boolean;
    ledger?: readonly object[];
    deliver?: 'ok' | 'nowhere';
    limits?: { dailyUsd?: number; askAboveUsd?: number };
  } = {},
): Promise<World> {
  const standing: { current: CallStanding } = { current: ferretStanding(ferretId('test-ferret')) };
  const fake = new FakeHeygen();
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
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => standing.current),
    fakes: { asks, ferrets },
    fetch: fake.fetch,
    vault: { HEYGEN_API_KEY: HEYGEN_KEY },
    config: {
      'create.yaml': {
        ...(options.key === false ? {} : { heygen: { key: '${secret:HEYGEN_API_KEY}' } }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      },
    },
  });
  if (options.ledger !== undefined)
    host
      .state('create')
      .plant(
        SPEND_LEDGER,
        `${options.ledger
          .map(line => JSON.stringify({ format: 1, ...line, day: dayOf(new Date(host.clock.nowMs()), 'UTC') }))
          .join('\n')}\n`,
      );
  const jobsWrite = { fails: false };
  const files = host.state('create').files;
  const set = files.set.bind(files);
  files.set = (path, text) => {
    if (jobsWrite.fails && path === 'avatar-jobs.jsonl') throw new Error('the disk is full');
    return set(path, text);
  };
  return { fake, asks, delivered, host, standing, jobsWrite };
}

const SHORT = 'Hello, and welcome to the show.';
/** 300 characters: 20 s of speech. */
const LONG = 'a'.repeat(300);
/** Avatar IV, pinned in the request, at HeyGen's dearest avatar type: $4.83 a minute, billed by the second: 80 500 micro-dollars each. */
const PER_SECOND = 80_500;
/** 31 characters: 3 s. */
const SHORT_COST = 3 * PER_SECOND;
const LONG_COST = 20 * PER_SECOND;

const avatar = (w: World, input: Record<string, unknown> = {}) =>
  w.host.tool('generate_avatar_video', { script: SHORT, avatar: AVATAR, voice: VOICE, ...input });
const status = (w: World, job: string) => w.host.tool('avatar_video_status', { job });
const jobOf = (text: string): string => /avt_[0-9a-f]{12}/u.exec(text)![0];

const lines = (w: World, file: string): readonly Record<string, unknown>[] =>
  (w.host.state('create').files.get(file) ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
const ledgerLines = (w: World) => lines(w, 'ledger.jsonl');
const net = (w: World): number =>
  ledgerLines(w).reduce((sum, line) => sum + (line.refund === true ? -1 : 1) * (line.microUsd as number), 0);
const jobLines = (w: World) => lines(w, 'avatar-jobs.jsonl');

describe('HeyGen avatar video is priced from a table, by the second, at the pinned engine’s rate', () => {
  test('Avatar IV’s $4.83 a minute is billed per second on the estimated duration, rounded UP', () => {
    expect(priceAvatarVideo(SHORT)).toEqual({ ok: true, microUsd: SHORT_COST, from: 'table' });
    expect(priceAvatarVideo(LONG)).toEqual({ ok: true, microUsd: LONG_COST, from: 'table' });
    // 15 characters a second: 16 characters is a started second, so two
    expect(priceAvatarVideo('a'.repeat(15))).toEqual({ ok: true, microUsd: PER_SECOND, from: 'table' });
    expect(priceAvatarVideo('a'.repeat(16))).toEqual({ ok: true, microUsd: 2 * PER_SECOND, from: 'table' });
    // a minute of speech is exactly HeyGen's published $4.83 a minute; never less
    expect(priceAvatarVideo('a'.repeat(900))).toEqual({ ok: true, microUsd: 4_830_000, from: 'table' });
    expect(priceAvatarVideo('a'.repeat(901))).toEqual({ ok: true, microUsd: 61 * PER_SECOND, from: 'table' });
    // the longest script allowed is $8.05: over the default $5 daily limit, so it is refused until the owner raises the limit
    expect(priceAvatarVideo('a'.repeat(1_500))).toEqual({ ok: true, microUsd: 100 * PER_SECOND, from: 'table' });
  });

  test('the video is fetched from HeyGen’s own storage over https and nowhere else', () => {
    expect(isHeygenCdn(CDN)).toBe(true);
    expect(isHeygenCdn('http://resource2.heygen.ai/x.mp4')).toBe(false);
    expect(isHeygenCdn('https://heygen.ai.evil.example/x.mp4')).toBe(false);
    expect(isHeygenCdn('https://evil.example/x.heygen.ai')).toBe(false);
    expect(isHeygenCdn('https://u:p@resource2.heygen.ai/x.mp4')).toBe(false);
    expect(isHeygenCdn('not a url')).toBe(false);
  });
});

describe('generate_avatar_video: priced before it is sent, reserved at submit, under the one cap and ask', () => {
  test('a short script costs $0.25 (3 s at Avatar IV’s $4.83 a minute), reserved once, sent with the key placed by the kernel, and answers a job id', async () => {
    const w = await world();
    const answer = await avatar(w);
    expect(answer.isError).toBeUndefined();
    const sent = w.fake.to('api.heygen.com', 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe('/v3/videos');
    expect(sent[0]!.headers.get('x-api-key')).toBe(HEYGEN_KEY);
    // the engine is pinned, so the price reserved is the price of the engine HeyGen will use
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      type: 'avatar',
      avatar_id: AVATAR,
      script: SHORT,
      voice_id: VOICE,
      aspect_ratio: '16:9',
      resolution: '720p',
      engine: { type: 'avatar_iv' },
    });
    expect(net(w)).toBe(SHORT_COST);
    expect(ledgerLines(w)[0]).toMatchObject({
      tool: 'generate_avatar_video',
      model: 'avatar',
      priced: 'table',
      ferret: 'test-ferret',
    });
    const job = jobOf(answer.text);
    expect(answer.text).toContain('avatar_video_status');
    expect(answer.text).toContain('$0.25');
    expect(answer.text).toContain('Do NOT call generate_avatar_video again');
    expect(jobLines(w)).toEqual([
      expect.objectContaining({
        kind: 'submitted',
        job,
        heygenVideo: 'hv1',
        ferret: 'test-ferret',
        microUsd: SHORT_COST,
      }),
    ]);
    // nothing was fetched and nothing delivered: the video does not exist yet
    expect(w.fake.to('resource2.heygen.ai')).toHaveLength(0);
    expect(w.delivered).toHaveLength(0);
  });

  test('9:16 asks HeyGen for a tall frame', async () => {
    const w = await world();
    await avatar(w, { aspect: '9:16' });
    expect(JSON.parse(w.fake.to('api.heygen.com', 'POST')[0]!.body!)).toMatchObject({
      aspect_ratio: '9:16',
      resolution: '720p',
    });
  });

  test('the retired v2 and v1 paths are never used: the fake refuses them, and a whole video is made on v3 alone', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    w.fake.finish('hv1');
    expect((await status(w, job)).text).toContain('type: video');
    const paths = w.fake.to('api.heygen.com').map(request => `${request.method} ${request.path}`);
    expect(paths).toEqual(['POST /v3/videos', 'GET /v3/videos/hv1']);
    // and the fake does refuse the old spellings
    for (const [method, path] of [
      ['POST', '/v2/video/generate'],
      ['GET', '/v1/video_status.get?video_id=hv1'],
    ] as const)
      expect((await w.fake.fetch(new URL(`https://api.heygen.com${path}`), { method })).status).toBe(404);
  });

  test('the key is never in the job file, the ledger or the answer', async () => {
    const w = await world();
    const answer = await avatar(w);
    const everything = [
      answer.text,
      w.host.state('create').files.get('avatar-jobs.jsonl'),
      w.host.state('create').files.get('ledger.jsonl'),
    ].join('\n');
    expect(everything).not.toContain(HEYGEN_KEY);
  });

  test('a $1.61 video (20 s) is over the $1 limit: it asks and sends nothing; once approved the same request goes, once', async () => {
    const w = await world();
    const answer = await avatar(w, { script: LONG });
    expect(answer.text).toContain('$1.61');
    expect(answer.text).toContain('Nothing was spent');
    expect(w.fake.seen).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(0);
    expect(jobLines(w)).toHaveLength(0);
    const [open] = await w.asks.open({});
    expect(open).toMatchObject({ source: 'create-spend', kind: 'permission', blocking: true, ferret: 'test-ferret' });
    expect(open!.subject).toContain('one avatar video');

    w.asks.answerAs({ ferret: 'test-ferret', id: open!.id }, 'approve');
    const approved = await avatar(w, { script: LONG });
    expect(approved.text).toContain('Queued one avatar video');
    expect(net(w)).toBe(LONG_COST);
    expect(w.fake.to('api.heygen.com', 'POST')).toHaveLength(1);
  });

  test('a declined ask spends nothing and says what to do instead', async () => {
    const w = await world();
    await avatar(w, { script: LONG });
    const [open] = await w.asks.open({});
    w.asks.answerAs({ ferret: 'test-ferret', id: open!.id }, 'reject');
    const declined = await avatar(w, { script: LONG });
    expect(declined.isError).toBe(true);
    expect(declined.text).toContain('declined');
    expect(w.fake.seen).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(0);
  });

  test('a call that would pass the $5 daily limit (counted with every other creative tool) is refused and nothing is sent', async () => {
    const w = await world({
      ledger: [
        {
          at: '2026-11-24T08:00:00.000Z',
          tool: 'generate_image',
          model: 'flux-pro',
          ferret: 'x',
          microUsd: 4_800_000,
          priced: 'table',
          request: '0123456789abcdef',
        },
      ],
    });
    const answer = await avatar(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('daily limit');
    expect(w.fake.seen).toHaveLength(0);
    expect(net(w)).toBe(4_800_000);
  });

  test('without a HeyGen key it is off and nothing leaves the machine', async () => {
    const w = await world({ key: false });
    const answer = await avatar(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('no HeyGen key');
    expect(w.fake.seen).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(0);
  });

  test('an avatar, a voice and a script are required; nothing is invented for them', async () => {
    const w = await world();
    for (const input of [
      { script: '   ' },
      { avatar: undefined },
      { voice: undefined },
      { avatar: 'a b' },
      { aspect: '1:1' },
    ]) {
      expect((await avatar(w, input)).isError).toBe(true);
    }
    expect(w.fake.seen).toHaveLength(0);
  });

  test('a submit HeyGen refuses with a 4xx billed nothing: refunded, no job', async () => {
    const w = await world();
    w.fake.submit = 422;
    const answer = await avatar(w);
    expect(answer.isError).toBe(true);
    expect(net(w)).toBe(0);
    expect(ledgerLines(w)).toHaveLength(2);
    expect(jobLines(w)).toHaveLength(0);
  });

  test('a submit that drops, answers 5xx or cannot be read may have been billed: it stays counted, with no job', async () => {
    for (const submit of ['drops', 503, 'garbled'] as const) {
      const w = await world();
      w.fake.submit = submit;
      const answer = await avatar(w);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('may have billed');
      expect(net(w)).toBe(SHORT_COST);
      expect(jobLines(w)).toHaveLength(0);
    }
  });

  test('the same video asked for again while its job is open is that job, not a second payment', async () => {
    const w = await world();
    const first = await avatar(w);
    const again = await avatar(w);
    expect(again.isError).toBeUndefined();
    expect(again.text).toContain(jobOf(first.text));
    expect(again.text).toContain('Nothing more was spent');
    expect(w.fake.to('api.heygen.com', 'POST')).toHaveLength(1);
    expect(net(w)).toBe(SHORT_COST);
    await avatar(w, { script: 'Another script.' });
    expect(w.fake.to('api.heygen.com', 'POST')).toHaveLength(2);
    expect(net(w)).toBe(SHORT_COST + 80_500);
  });
});

describe('avatar_video_status: checking is free; the video is fetched once it is made', () => {
  test('while it is made it says so and spends nothing; once made it is fetched, saved, and shown with the cost line', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    const waiting = await status(w, job);
    expect(waiting.isError).toBeUndefined();
    expect(waiting.text).toContain('being made');
    expect(waiting.text).toContain('Nothing more was spent');
    w.fake.videos.get('hv1')!.status = 'processing';
    expect((await status(w, job)).text).toContain('being made');
    expect(w.delivered).toHaveLength(0);

    w.fake.finish('hv1');
    const ready = await status(w, job);
    expect(ready.isError).toBeUndefined();
    expect(w.fake.to('resource2.heygen.ai')).toHaveLength(1);
    // the storage is fetched with no key
    expect(w.fake.to('resource2.heygen.ai')[0]!.headers.get('x-api-key')).toBeNull();
    expect(w.delivered).toEqual([
      { ferret: 'test-ferret', name: `create-avatar-${job.slice(4)}.mp4`, bytes: MP4.byteLength },
    ]);
    expect(ready.text).toContain('type: video');
    expect(ready.text).toContain(`src: media:create-avatar-${job.slice(4)}.mp4`);
    expect(ready.text).toContain('avatar video, 16:9 · $0.25');
    expect(jobLines(w).at(-1)).toMatchObject({ kind: 'finished', job, outcome: 'delivered' });
    expect(net(w)).toBe(SHORT_COST);

    // asked again: the same answer, no new fetch, no new charge
    const again = await status(w, job);
    expect(again.text).toContain('type: video');
    expect(w.fake.to('resource2.heygen.ai')).toHaveLength(1);
    expect(w.delivered).toHaveLength(1);
    expect(net(w)).toBe(SHORT_COST);
  });

  test('a video HeyGen failed stays counted (no refund is relied on) and the ferret is told not to ask again', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    w.fake.videos.get('hv1')!.status = 'failed';
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Not made');
    expect(answer.text).toContain('still counts');
    expect(net(w)).toBe(SHORT_COST);
    expect(jobLines(w).at(-1)).toMatchObject({ kind: 'finished', outcome: 'counted' });
    const later = await status(w, job);
    expect(later.isError).toBe(true);
    expect(w.fake.to('api.heygen.com', 'GET')).toHaveLength(1);
    expect(net(w)).toBe(SHORT_COST);
  });

  test('a video HeyGen no longer knows, or a finished answer with no video, is counted too', async () => {
    const gone = await world();
    const goneJob = jobOf((await avatar(gone)).text);
    gone.fake.videos.get('hv1')!.status = 'gone';
    expect((await status(gone, goneJob)).text).toContain('still counts');
    expect(net(gone)).toBe(SHORT_COST);

    const empty = await world();
    const emptyJob = jobOf((await avatar(empty)).text);
    empty.fake.finish('hv1', { url: null });
    expect((await status(empty, emptyJob)).text).toContain('held no video');
    expect(net(empty)).toBe(SHORT_COST);
  });

  test('a check that cannot be read or does not answer is no verdict: the job is kept and asked again for free', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    for (const how of ['drops', 500] as const) {
      w.fake.statusAnswer = how;
      const answer = await status(w, job);
      expect(answer.text).toContain('Could not check');
      expect(answer.text).toContain('nothing more was spent');
    }
    w.fake.statusAnswer = 'ok';
    w.fake.videos.get('hv1')!.status = 'strange';
    expect((await status(w, job)).text).toContain('Could not check');
    expect(jobLines(w)).toHaveLength(1);
    expect(net(w)).toBe(SHORT_COST);
  });

  test('a link that is not on HeyGen’s own storage is never fetched: closed as counted, told not to retry', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    w.fake.finish('hv1', { url: 'https://evil.example/x.mp4' });
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Do NOT retry');
    expect(w.fake.seen.some(request => request.host === 'evil.example')).toBe(false);
    expect(w.delivered).toHaveLength(0);
    expect(jobLines(w).at(-1)).toMatchObject({ kind: 'finished', outcome: 'counted' });
    expect(net(w)).toBe(SHORT_COST);
  });

  test('a storage read that fails is read again later, free; something that is not a video is closed as counted', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    w.fake.finish('hv1');
    w.fake.cdn = 'not-found';
    const retry = await status(w, job);
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain('call avatar_video_status again');
    expect(jobLines(w)).toHaveLength(1);
    w.fake.cdn = 'ok';
    expect((await status(w, job)).text).toContain('type: video');

    const odd = await world();
    const oddJob = jobOf((await avatar(odd)).text);
    odd.fake.finish('hv1');
    odd.fake.cdn = 'wrong-type';
    expect((await status(odd, oddJob)).text).toContain('Do NOT retry');
    expect(jobLines(odd).at(-1)).toMatchObject({ kind: 'finished', outcome: 'counted' });
  });

  test('a video that could not be saved for the ferret is kept open and asked again for free', async () => {
    const w = await world({ deliver: 'nowhere' });
    const job = jobOf((await avatar(w)).text);
    w.fake.finish('hv1');
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('could not be saved');
    expect(jobLines(w)).toHaveLength(1);
  });

  test('a job is its ferret’s own: another ferret’s id is answered as if there were none', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    w.standing.current = ferretStanding(ferretId('other-ferret'));
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('no avatar video job');
    expect(w.fake.to('api.heygen.com', 'GET')).toHaveLength(0);
  });

  test('a job survives a restart: a new daemon reads it from the file and charges nothing again', async () => {
    const first = await world();
    const job = jobOf((await avatar(first)).text);
    const carried = first.host.state('create').files.get('avatar-jobs.jsonl')!;
    const ledger = first.host.state('create').files.get('ledger.jsonl')!;
    const second = await world();
    second.host.state('create').plant(AVATAR_JOBS, carried);
    second.host.state('create').plant(SPEND_LEDGER, ledger);
    second.fake.videos.set('hv1', { status: 'completed', url: CDN });
    expect((await status(second, job)).text).toContain('type: video');
    expect(net(second)).toBe(SHORT_COST);
  });
});

describe('avatar_video_status: the edges of the shared queue and the job file', () => {
  test('a status request that names no valid job is refused before anything is read', async () => {
    const w = await world();
    const answer = await status(w, 'not-a-job');
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('not valid');
    expect(w.fake.seen).toHaveLength(0);
  });

  test('a job that cannot be saved after HeyGen queued it is paid for and counted, and says not to ask again', async () => {
    const w = await world();
    w.jobsWrite.fails = true;
    const answer = await avatar(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('the job could not be saved');
    expect(answer.text).toContain('Do NOT ask again');
    expect(net(w)).toBe(SHORT_COST);
  });

  test('an end that cannot be written changes nothing: the job stays open and is asked again', async () => {
    const w = await world();
    const job = jobOf((await avatar(w)).text);
    w.fake.videos.get('hv1')!.status = 'failed';
    w.jobsWrite.fails = true;
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('its end could not be saved');
    expect(net(w)).toBe(SHORT_COST);
    w.jobsWrite.fails = false;
    expect((await status(w, job)).text).toContain('Not made');
  });

  test('a second ask while the video is coming down fetches nothing; past two downloads and two waiting, the rest are turned away', async () => {
    const w = await world({ limits: { dailyUsd: 20 } });
    const jobs: string[] = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(jobOf((await avatar(w, { script: `script number ${i}` })).text));
      w.fake.finish(`hv${i + 1}`);
    }
    let open!: () => void;
    w.fake.cdnGate = new Promise<void>(resolve => (open = resolve));
    const asked = jobs.map(job => status(w, job));
    await Bun.sleep(200);
    // Two are coming down; two more wait for a place; two were turned away at once.
    expect(w.fake.to('resource2.heygen.ai')).toHaveLength(2);
    // Asking for one that is coming down is told so and starts no second fetch.
    const meanwhile = await status(w, jobs[0]!);
    expect(meanwhile.text).toContain('is being fetched right now');
    open();
    const answers = await Promise.all(asked);
    const turnedAway = answers.filter(answer => answer.text.includes('Too many videos'));
    expect(turnedAway).toHaveLength(2);
    expect(turnedAway.every(answer => answer.text.includes('Nothing more was spent'))).toBe(true);
    expect(answers.filter(answer => answer.text.includes('type: video'))).toHaveLength(4);
    expect(w.delivered).toHaveLength(4);
    expect(net(w)).toBe(6 * 80_500);
  });
});

describe('the owner is told what leaves the machine', () => {
  test('docs/create.md names HeyGen, and the script, among the third parties a prompt is sent to', async () => {
    const doc = await Bun.file(new URL('../../../../../docs/create.md', import.meta.url)).text();
    const disclosure = doc.split('\n\n').find(paragraph => paragraph.includes('are third parties'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('HeyGen');
    expect(disclosure).toContain('script');
  });
});
