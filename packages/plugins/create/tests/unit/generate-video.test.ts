import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ferretStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { SPEND_LEDGER, VIDEO_JOBS } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { dayOf } from '../../daemon/lib/spend.ts';

const FAL_KEY = 'fal-test-key-0123456789';
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4]);
const CDN = 'https://v3b.fal.media/files/b/lion/output.mp4';
const KLING = 'fal-ai/kling-video/v2.6/pro/text-to-video';
const VEO = 'fal-ai/veo3.1/fast';
const QUEUE = 'https://queue.fal.run';

/** How one queued request is seen by the status and the result reads. */
interface Queued {
  endpoint: string;
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'NOT_FOUND';
  error?: string;
  /** fal's class of the error on the status read (`runner_disconnected`, `client_cancelled` …). */
  errorType?: string;
  /** The result read: its status, or `ok`. */
  result: 'ok' | number | 'no-video';
  statusDrops: boolean;
}

/** fal's queue, its price endpoint and its storage as they answer, remembering every request that reached them. */
class FakeFal {
  readonly seen: { host: string; path: string; method: string; headers: Headers; body: string | undefined }[] = [];
  readonly queued = new Map<string, Queued>();
  prices = new Map<string, { unit_price: number; unit: string }>();
  submit: 'ok' | 'drops' | 'garbled' | number = 'ok';
  videoUrl = CDN;
  cdn: 'ok' | 'not-found' | 'wrong-type' = 'ok';
  video: Uint8Array = MP4;
  /** While set, storage answers only once this resolves: a download that is in flight. */
  cdnGate: Promise<void> | undefined;
  /** Bytes the tool has pulled from the body of storage's answers (a body read to its end counts all of it). */
  streamed = 0;
  /** Storage answers in flight (opened, not yet read to the end or cancelled) and the most there were at once. */
  inFlight = 0;
  peak = 0;
  /** The status every new request starts with. */
  startAs: Queued['status'] = 'IN_QUEUE';
  private count = 0;

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
      const endpoint = url.searchParams.get('endpoint_id') ?? '';
      const row = this.prices.get(endpoint);
      return Response.json({ prices: row === undefined ? [] : [{ endpoint_id: endpoint, currency: 'USD', ...row }] });
    }
    if (url.host === 'queue.fal.run') {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        if (this.submit === 'drops') throw new Error('connection dropped');
        if (typeof this.submit === 'number') return new Response('no', { status: this.submit });
        if (this.submit === 'garbled')
          return Response.json({ request_id: 'req-x', status_url: 'https://evil.example/s' });
        const id = `req-${++this.count}`;
        const endpoint = url.pathname.slice(1);
        this.queued.set(id, { endpoint, status: this.startAs, result: 'ok', statusDrops: false });
        const app = endpoint.split('/').slice(0, 2).join('/');
        return Response.json({
          request_id: id,
          status_url: `${QUEUE}/${app}/requests/${id}/status`,
          response_url: `${QUEUE}/${app}/requests/${id}`,
          cancel_url: `${QUEUE}/${app}/requests/${id}/cancel`,
        });
      }
      const match = /\/requests\/([^/]+)(\/status)?$/u.exec(url.pathname);
      const job = match === null ? undefined : this.queued.get(match[1]!);
      if (job === undefined || job.status === 'NOT_FOUND') return new Response('no', { status: 404 });
      if (match![2] !== undefined) {
        if (job.statusDrops) throw new Error('connection dropped');
        return Response.json(
          {
            status: job.status,
            request_id: match![1],
            ...(job.error === undefined ? {} : { error: job.error }),
            ...(job.errorType === undefined ? {} : { error_type: job.errorType }),
          },
          { status: job.status === 'COMPLETED' ? 200 : 202 },
        );
      }
      if (job.result === 'no-video') return Response.json({ nothing: true });
      if (typeof job.result === 'number') return new Response('no', { status: job.result });
      return Response.json({ video: { url: this.videoUrl, content_type: 'video/mp4' } });
    }
    if (url.host.endsWith('fal.media')) {
      await this.cdnGate;
      if (this.cdn === 'not-found')
        return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) } as never;
      const bytes = this.video;
      this.inFlight++;
      this.peak = Math.max(this.peak, this.inFlight);
      return {
        ok: true,
        status: 200,
        headers: new Map<string, string>([['content-type', this.cdn === 'wrong-type' ? 'text/html' : 'video/mp4']]),
        body: this.streamOf(bytes),
      } as unknown as Response;
    }
    throw new Error(`the fakes were asked for ${url.host}`);
  };

  /** The bytes as a body read a megabyte at a time, so a reader that stops early leaves the rest unread. */
  private streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    let at = 0;
    const done = (): void => {
      this.inFlight -= 1;
    };
    return new ReadableStream<Uint8Array>(
      {
        pull: controller => {
          if (at >= bytes.byteLength) {
            controller.close();
            done();
            return;
          }
          const next = bytes.subarray(at, at + 1024 * 1024);
          at += next.byteLength;
          this.streamed += next.byteLength;
          controller.enqueue(next);
        },
        cancel: done,
      },
      { highWaterMark: 0 },
    );
  }

  to(host: string, method?: string) {
    return this.seen.filter(request => request.host === host && (method === undefined || request.method === method));
  }
  /** Ends a queued request the way fal does when the clip is made. */
  finish(id: string, how: Partial<Queued> = {}): void {
    Object.assign(this.queued.get(id)!, { status: 'COMPLETED', ...how });
  }
}

interface World {
  readonly fake: FakeFal;
  readonly asks: FakeAsks;
  readonly delivered: { ferret: string; name: string; bytes: number }[];
  readonly host: Awaited<ReturnType<typeof testHost>>;
  readonly standing: { current: CallStanding };
  /** While true, a write to the jobs file fails (a full or damaged disk). */
  readonly jobsWrite: { fails: boolean };
}

async function world(
  options: {
    fal?: boolean;
    limits?: { dailyUsd?: number; askAboveUsd?: number };
    ledger?: readonly object[];
    /** Raw text of a ledger and a jobs file carried over from an earlier daemon: a restart. */
    carried?: { ledger?: string; jobs?: string };
    fake?: FakeFal;
    deliver?: 'ok' | 'nowhere';
  } = {},
): Promise<World> {
  const standing: { current: CallStanding } = { current: ferretStanding(ferretId('test-ferret')) };
  const fake = options.fake ?? new FakeFal();
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
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => standing.current),
    fakes: { asks, ferrets },
    fetch: fake.fetch,
    vault: { FAL_KEY },
    config: { 'create.yaml': config },
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
  if (options.carried?.ledger !== undefined) host.state('create').plant(SPEND_LEDGER, options.carried.ledger);
  if (options.carried?.jobs !== undefined) host.state('create').plant(VIDEO_JOBS, options.carried.jobs);
  const jobsWrite = { fails: false };
  const files = host.state('create').files;
  const set = files.set.bind(files);
  files.set = (path, text) => {
    if (jobsWrite.fails && path === 'jobs.jsonl') throw new Error('the disk is full');
    return set(path, text);
  };
  return { fake, asks, delivered, host, standing, jobsWrite };
}

const video = (w: World, input: Record<string, unknown> = {}) =>
  w.host.tool('generate_video', { prompt: 'a fox runs through snow', ...input });
const status = (w: World, job: string) => w.host.tool('generation_status', { job });
const jobOf = (text: string): string => /vid_[0-9a-f]{12}/u.exec(text)![0];

const lines = (w: World, file: string): readonly Record<string, unknown>[] =>
  (w.host.state('create').files.get(file) ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
const ledgerLines = (w: World) => lines(w, 'ledger.jsonl');
const net = (w: World): number =>
  ledgerLines(w).reduce((sum, line) => sum + (line.refund === true ? -1 : 1) * (line.microUsd as number), 0);
const jobLines = (w: World) => lines(w, 'jobs.jsonl');

describe('generate_video: queued, priced before it is sent, reserved at submit', () => {
  test('Kling 5 s is $0.35 from the table, reserved once, queued with every setting named, and answers a job id', async () => {
    const w = await world();
    const answer = await video(w);
    expect(answer.isError).toBeUndefined();
    const sent = w.fake.to('queue.fal.run', 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe(`/${KLING}`);
    expect(sent[0]!.headers.get('authorization')).toBe(`Key ${FAL_KEY}`);
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      prompt: 'a fox runs through snow',
      duration: '5',
      aspect_ratio: '16:9',
      generate_audio: false,
      enable_safety_checker: true,
    });
    // the price was read first, from fal's own endpoint, and fal gave none: the table priced it
    expect(w.fake.to('api.fal.ai')).toHaveLength(1);
    expect(net(w)).toBe(350_000);
    expect(ledgerLines(w)[0]).toMatchObject({
      tool: 'generate_video',
      model: 'kling',
      priced: 'table',
      ferret: 'test-ferret',
    });
    const job = jobOf(answer.text);
    expect(answer.text).toContain('generation_status');
    expect(answer.text).toContain('$0.35');
    expect(answer.text).toContain('Do NOT call generate_video again');
    expect(jobLines(w)).toHaveLength(1);
    expect(jobLines(w)[0]).toMatchObject({
      kind: 'submitted',
      job,
      falRequest: 'req-1',
      ferret: 'test-ferret',
      model: 'kling',
    });
    // nothing was fetched and nothing delivered: the clip does not exist yet
    expect(w.fake.to('v3b.fal.media')).toHaveLength(0);
    expect(w.delivered).toHaveLength(0);
  });

  test('the key is never in the job file, the ledger or the answer', async () => {
    const w = await world();
    const answer = await video(w);
    const everything = [
      answer.text,
      w.host.state('create').files.get('jobs.jsonl'),
      w.host.state('create').files.get('ledger.jsonl'),
    ].join('\n');
    expect(everything).not.toContain(FAL_KEY);
  });

  test('Veo 8 s with sound is $1.20, over the $1 limit: it asks and sends nothing', async () => {
    const w = await world();
    const answer = await video(w, { model: 'veo-fast', audio: true });
    expect(answer.text).toContain('$1.20');
    expect(answer.text).toContain('Nothing was spent');
    expect(w.fake.to('queue.fal.run')).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(0);
    expect(jobLines(w)).toHaveLength(0);
    const [open] = await w.asks.open({});
    expect(open).toMatchObject({ source: 'create-spend', kind: 'permission', blocking: true, ferret: 'test-ferret' });
    expect(open!.subject).toContain('one video clip');

    // the owner approves: the SAME request goes through once, paid at the approved price, queued, and the approval is spent
    w.asks.answerAs({ ferret: 'test-ferret', id: open!.id }, 'approve');
    const approved = await video(w, { model: 'veo-fast', audio: true });
    expect(approved.text).toContain('Queued one video clip');
    expect(net(w)).toBe(1_200_000);
    expect(w.fake.to('queue.fal.run', 'POST')).toHaveLength(1);
  });

  test('Veo 8 s with no sound is $0.80 and goes; its body names the length, shape, resolution and sound', async () => {
    const w = await world();
    const answer = await video(w, { model: 'veo-fast' });
    expect(answer.isError).toBeUndefined();
    expect(net(w)).toBe(800_000);
    const sent = w.fake.to('queue.fal.run', 'POST')[0]!;
    expect(sent.path).toBe(`/${VEO}`);
    expect(JSON.parse(sent.body!)).toEqual({
      prompt: 'a fox runs through snow',
      duration: '8s',
      aspect_ratio: '16:9',
      resolution: '720p',
      generate_audio: false,
    });
  });

  test('a call that would pass $5 for the day is refused and nothing is sent', async () => {
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
    const answer = await video(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('daily limit');
    expect(w.fake.to('queue.fal.run')).toHaveLength(0);
  });

  test('a live rate above the table prices the call (fal’s price); one below it does not lower it', async () => {
    const high = await world();
    high.fake.prices.set(KLING, { unit_price: 0.1, unit: 'second' });
    await video(high);
    expect(net(high)).toBe(500_000);
    expect(ledgerLines(high)[0]!.priced).toBe('fal');
    const low = await world();
    low.fake.prices.set(KLING, { unit_price: 0.01, unit: 'second' });
    await video(low);
    expect(net(low)).toBe(350_000);
    expect(ledgerLines(low)[0]!.priced).toBe('table');
  });

  test('a live rate in a unit that is not the second refuses the call before anything is sent', async () => {
    const w = await world();
    w.fake.prices.set(KLING, { unit_price: 0.7, unit: 'video' });
    const answer = await video(w);
    expect(answer.isError).toBe(true);
    expect(w.fake.to('queue.fal.run')).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(0);
  });

  test('settings a model does not take are refused before any price is read', async () => {
    const w = await world();
    for (const input of [
      { seconds: 7 },
      { model: 'veo-fast', aspect: '1:1' },
      { resolution: '1080p' },
      { model: 'veo-fast', seconds: 5 },
      { prompt: '   ' },
    ]) {
      const answer = await video(w, input);
      expect(answer.isError).toBe(true);
    }
    expect(w.fake.seen).toHaveLength(0);
  });

  test('without a fal key it is off and nothing leaves the machine', async () => {
    const w = await world({ fal: false });
    const answer = await video(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('no fal key');
    expect(w.fake.seen).toHaveLength(0);
  });

  test('a submit fal refuses with a 4xx billed nothing: refunded, no job', async () => {
    const w = await world();
    w.fake.submit = 422;
    const answer = await video(w);
    expect(answer.isError).toBe(true);
    expect(net(w)).toBe(0);
    expect(ledgerLines(w)).toHaveLength(2);
    expect(jobLines(w)).toHaveLength(0);
  });

  test('a submit that drops or answers 5xx may have been billed: it stays counted, with no job', async () => {
    for (const submit of ['drops', 503] as const) {
      const w = await world();
      w.fake.submit = submit;
      const answer = await video(w);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('may have billed');
      expect(net(w)).toBe(350_000);
      expect(jobLines(w)).toHaveLength(0);
    }
  });

  test('an answer fal gave that Create will not follow is counted, with no job', async () => {
    const w = await world();
    w.fake.submit = 'garbled';
    const answer = await video(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('may have billed');
    expect(net(w)).toBe(350_000);
    expect(jobLines(w)).toHaveLength(0);
  });

  test('a job that cannot be saved after fal queued it is paid for and counted, and says not to ask again', async () => {
    const w = await world();
    w.jobsWrite.fails = true;
    const answer = await video(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('the job could not be saved');
    expect(answer.text).toContain('Do NOT ask again');
    expect(net(w)).toBe(350_000);
  });

  test('the same clip asked for again while its job is open is that job, not a second payment', async () => {
    const w = await world();
    const first = await video(w);
    const again = await video(w);
    expect(again.isError).toBeUndefined();
    expect(again.text).toContain(jobOf(first.text));
    expect(again.text).toContain('Nothing more was spent');
    expect(w.fake.to('queue.fal.run', 'POST')).toHaveLength(1);
    expect(net(w)).toBe(350_000);
    // different words are another clip
    await video(w, { prompt: 'a cat naps' });
    expect(w.fake.to('queue.fal.run', 'POST')).toHaveLength(2);
    expect(net(w)).toBe(700_000);
  });
});

describe('generation_status: checking is free; the clip is fetched once it is made', () => {
  test('while it waits or is made it says so and spends nothing', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    const queued = await status(w, job);
    expect(queued.isError).toBeUndefined();
    expect(queued.text).toContain('waiting in fal');
    w.fake.queued.get('req-1')!.status = 'IN_PROGRESS';
    expect((await status(w, job)).text).toContain('being made');
    expect(net(w)).toBe(350_000);
    expect(ledgerLines(w)).toHaveLength(1);
    expect(w.fake.to('v3b.fal.media')).toHaveLength(0);
    expect(w.fake.to('queue.fal.run', 'POST')).toHaveLength(1);
    // the read of status goes to the address fal gave, with the key
    const read = w.fake.to('queue.fal.run', 'GET')[0]!;
    expect(read.path).toBe('/fal-ai/kling-video/requests/req-1/status');
    expect(read.headers.get('authorization')).toBe(`Key ${FAL_KEY}`);
  });

  test('made: fetched from fal’s storage with no key, delivered to the media folder, answered as a video block with its cost', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    const answer = await status(w, job);
    expect(answer.isError).toBeUndefined();
    const fetched = w.fake.to('v3b.fal.media');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.headers.get('authorization')).toBeNull();
    expect(w.delivered).toEqual([
      { ferret: 'test-ferret', name: `create-video-kling-${job.slice(4)}.mp4`, bytes: MP4.byteLength },
    ]);
    expect(answer.text).toContain('Put these lines in your reply:');
    expect(answer.text).toContain('kling, 5 s · $0.35 · $0.35 of $5.00 today');
    expect(answer.text).toContain(
      '```fy-render\ntype: video\nalt: a fox runs through snow\nsrc: media:create-video-kling-',
    );
    expect(answer.text).toContain('\n---\n```');
    // the one reservation made at submit is the only spend
    expect(net(w)).toBe(350_000);
    expect(ledgerLines(w)).toHaveLength(1);
    expect(jobLines(w)[1]).toMatchObject({ kind: 'finished', job, outcome: 'delivered' });
  });

  test('a clip downloading does not hold up another job’s check, and the same job is fetched once', async () => {
    const w = await world();
    const first = jobOf((await video(w)).text);
    const second = jobOf((await video(w, { prompt: 'a bear walks through rain' })).text);
    let open!: () => void;
    w.fake.cdnGate = new Promise<void>(resolve => (open = resolve));
    w.fake.finish('req-1');
    const downloading = status(w, first);
    await Bun.sleep(50);
    // Another job is checked while the first clip is still coming down.
    const other = await Promise.race([status(w, second), Bun.sleep(500).then(() => 'blocked' as const)]);
    // The same job asked meanwhile is told it is being fetched, and fetches nothing.
    const again = await Promise.race([status(w, first), Bun.sleep(500).then(() => 'blocked' as const)]);
    open();
    const done = await downloading;
    expect(other).not.toBe('blocked');
    expect((other as { text: string }).text).toContain('Nothing more was spent');
    expect(again).not.toBe('blocked');
    expect((again as { text: string }).text).toContain('is being fetched');
    expect(done.text).toContain('Put these lines in your reply:');
    expect(w.fake.to('v3b.fal.media')).toHaveLength(1);
    expect(w.delivered).toHaveLength(1);
    expect(net(w)).toBe(700_000);
  });

  test('a clip with no declared length is cut off while it is read, not after all of it was held', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    w.fake.video = new Uint8Array(200 * 1024 * 1024);
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Do NOT retry');
    // The 32 MiB cap plus the chunk that crossed it, never the 200 MiB the host offered.
    expect(w.fake.streamed).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expect(w.fake.streamed).toBeLessThanOrEqual(34 * 1024 * 1024);
    expect(net(w)).toBe(350_000);
  });

  test('at most two clips come down at once, a few more wait, and the rest are told to ask again', async () => {
    const w = await world();
    const jobs: string[] = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(jobOf((await video(w, { prompt: `clip number ${i}` })).text));
      w.fake.finish(`req-${i + 1}`);
    }
    let open!: () => void;
    w.fake.cdnGate = new Promise<void>(resolve => (open = resolve));
    const asked = jobs.map(job => status(w, job));
    await Bun.sleep(200);
    // Two are coming down; two more wait for a place; two were turned away at once.
    expect(w.fake.to('v3b.fal.media')).toHaveLength(2);
    open();
    const answers = await Promise.all(asked);
    const turnedAway = answers.filter(answer => answer.text.includes('Too many clips'));
    expect(turnedAway).toHaveLength(2);
    expect(turnedAway.every(answer => answer.text.includes('Nothing more was spent'))).toBe(true);
    expect(answers.filter(answer => answer.text.includes('Put these lines in your reply:'))).toHaveLength(4);
    expect(w.fake.peak).toBeLessThanOrEqual(2);
    expect(w.delivered).toHaveLength(4);
    // A turned-away job is fetched when it is asked again, and nothing was spent twice.
    const again = jobs[answers.findIndex(answer => answer.text.includes('Too many clips'))]!;
    expect((await status(w, again)).text).toContain('Put these lines in your reply:');
    expect(net(w)).toBe(6 * 350_000);
  });

  test('asked again after it was delivered it gives the same block, fetches nothing and charges nothing', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    const first = await status(w, job);
    const second = await status(w, job);
    expect(second.text.split('\n').slice(1)).toEqual(first.text.split('\n').slice(1));
    expect(w.fake.to('v3b.fal.media')).toHaveLength(1);
    expect(w.fake.to('queue.fal.run', 'GET')).toHaveLength(2);
    expect(w.delivered).toHaveLength(1);
    expect(net(w)).toBe(350_000);
  });

  test('a clip over the 32 MiB a media file can be shown at is paid for and not fetched: counted, not retried', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    w.fake.video = new Uint8Array(33 * 1024 * 1024);
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Do NOT retry');
    expect(net(w)).toBe(350_000);
  });

  test('another ferret’s job, and an id that was never made, are answered as no job', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.standing.current = ferretStanding(ferretId('someone-else'));
    expect((await status(w, job)).isError).toBe(true);
    expect((await status(w, job)).text).toContain('no video job');
    expect((await status(w, 'vid_000000000000')).text).toContain('no video job');
    expect((await w.host.tool('generation_status', { job: 'nope' })).isError).toBe(true);
    expect(w.fake.to('queue.fal.run', 'GET')).toHaveLength(0);
  });

  test('a poll that cannot be read keeps the job and tells the ferret to ask again', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.queued.get('req-1')!.statusDrops = true;
    const answer = await status(w, job);
    expect(answer.text).toContain('Could not check');
    expect(answer.text).toContain('nothing more was spent');
    w.fake.queued.get('req-1')!.statusDrops = false;
    w.fake.finish('req-1');
    expect((await status(w, job)).text).toContain('type: video');
    expect(net(w)).toBe(350_000);
  });
});

describe('a job fal fails is refunded only when fal bills nothing', () => {
  test('fal ends it with an error and no output: refunded, and it says so every time', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1', { error: 'the runner was lost', errorType: 'runner_disconnected' });
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('given back');
    expect(net(w)).toBe(0);
    // the refund repeats the reserved line on the reserved day
    const [reserved, refund] = ledgerLines(w);
    expect(refund).toEqual({ ...reserved, refund: true });
    expect(jobLines(w)[1]).toMatchObject({ kind: 'finished', outcome: 'refunded' });
    // asked again: the same, with no second refund and no new request to fal
    const reads = w.fake.to('queue.fal.run', 'GET').length;
    expect((await status(w, job)).text).toContain('given back');
    expect(net(w)).toBe(0);
    expect(ledgerLines(w)).toHaveLength(2);
    expect(w.fake.to('queue.fal.run', 'GET')).toHaveLength(reads);
  });

  test('an error_type of fal’s 5xx class, or bad_request, is refunded; each is checked on its own', async () => {
    for (const errorType of [
      'request_timeout',
      'startup_timeout',
      'runner_scheduling_failure',
      'runner_disconnected',
      'runner_server_error',
      'internal_error',
      'bad_request',
    ]) {
      const w = await world();
      const job = jobOf((await video(w)).text);
      w.fake.finish('req-1', { error: 'it failed', errorType });
      const answer = await status(w, job);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('given back');
      expect(net(w)).toBe(0);
      expect(jobLines(w)[1]).toMatchObject({ kind: 'finished', outcome: 'refunded' });
    }
  });

  test('a cancel, a dropped client, a content-policy refusal, an unknown error_type or none at all stays counted', async () => {
    for (const errorType of [
      'client_cancelled',
      'client_disconnected',
      'content_policy_violation',
      'something_new_fal_added',
      undefined,
    ]) {
      const w = await world();
      const job = jobOf((await video(w)).text);
      w.fake.finish('req-1', { error: 'it failed', ...(errorType === undefined ? {} : { errorType }) });
      const answer = await status(w, job);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('still counts');
      expect(answer.text).not.toContain('given back');
      expect(net(w)).toBe(350_000);
      expect(ledgerLines(w)).toHaveLength(1);
      expect(jobLines(w)[1]).toMatchObject({ kind: 'finished', outcome: 'counted' });
    }
  });

  test('a clean status then a result that answers 500, 422 or 499 was billed: still charged, re-checked, and delivered when the read recovers', async () => {
    for (const result of [500, 422, 499]) {
      const w = await world();
      const job = jobOf((await video(w)).text);
      w.fake.finish('req-1', { result });
      const answer = await status(w, job);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('paid for');
      expect(answer.text).not.toContain('given back');
      expect(net(w)).toBe(350_000);
      expect(ledgerLines(w)).toHaveLength(1);
      expect(jobLines(w).filter(line => line.kind === 'finished')).toHaveLength(0);
      // asked again while it still fails: still open, still charged once
      expect((await status(w, job)).isError).toBe(true);
      expect(net(w)).toBe(350_000);
      // the read recovers: the clip is delivered, and the one reservation stands
      w.fake.queued.get('req-1')!.result = 'ok';
      const done = await status(w, job);
      expect(done.isError).toBeUndefined();
      expect(done.text).toContain('type: video');
      expect(w.delivered).toHaveLength(1);
      expect(net(w)).toBe(350_000);
      expect(jobLines(w).at(-1)).toMatchObject({ kind: 'finished', outcome: 'delivered' });
    }
  });

  test('a failed read that cannot be written down still keeps the job open and says to ask again', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1', { result: 500 });
    w.jobsWrite.fails = true;
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('call generation_status again');
    expect(net(w)).toBe(350_000);
  });

  test('a job whose end cannot be written is not refunded, and is asked again', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1', { error: 'the runner was lost', errorType: 'runner_disconnected' });
    w.jobsWrite.fails = true;
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('its end could not be saved');
    expect(net(w)).toBe(350_000);
    expect(ledgerLines(w)).toHaveLength(1);
    // the disk recovers: the same end is written and the refund given, once
    w.jobsWrite.fails = false;
    expect((await status(w, job)).text).toContain('given back');
    expect(net(w)).toBe(0);
  });

  test('a result that never reads is closed as counted after five failed reads, and never read again', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1', { result: 500 });
    for (let attempt = 1; attempt < 5; attempt++) {
      const open = await status(w, job);
      expect(open.text).not.toContain('Do NOT retry');
    }
    const closed = await status(w, job);
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain('made and paid for');
    expect(closed.text).toContain('could not be fetched');
    expect(closed.text).toContain('Do NOT retry');
    expect(net(w)).toBe(350_000);
    expect(jobLines(w).at(-1)).toMatchObject({ kind: 'finished', outcome: 'counted' });
    const reads = w.fake.to('queue.fal.run', 'GET').length;
    expect((await status(w, job)).text).toContain('Do NOT retry');
    expect(w.fake.to('queue.fal.run', 'GET')).toHaveLength(reads);
  });

  test('the failed reads are counted across a restart', async () => {
    const before = await world();
    const job = jobOf((await video(before)).text);
    before.fake.finish('req-1', { result: 500 });
    for (let attempt = 0; attempt < 4; attempt++) await status(before, job);
    const carried = {
      ledger: before.host.state('create').files.get('ledger.jsonl')!,
      jobs: before.host.state('create').files.get('jobs.jsonl')!,
    };
    const fake = new FakeFal();
    fake.queued.set('req-1', { endpoint: KLING, status: 'COMPLETED', result: 500, statusDrops: false });
    const after = await world({ carried, fake });
    expect((await status(after, job)).text).toContain('Do NOT retry');
    expect(net(after)).toBe(350_000);
  });

  test('a result that has expired, or that holds no video, may have been billed: it stays counted', async () => {
    const gone = await world();
    const job = jobOf((await video(gone)).text);
    gone.fake.finish('req-1', { result: 404 });
    const answer = await status(gone, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('still counts');
    expect(net(gone)).toBe(350_000);
    expect(jobLines(gone)[1]).toMatchObject({ outcome: 'counted' });
    // and a second ask does not read fal again
    const reads = gone.fake.to('queue.fal.run', 'GET').length;
    await status(gone, job);
    expect(gone.fake.to('queue.fal.run', 'GET')).toHaveLength(reads);

    const empty = await world();
    const job2 = jobOf((await video(empty)).text);
    empty.fake.finish('req-1', { result: 'no-video' });
    expect((await status(empty, job2)).isError).toBe(true);
    expect(net(empty)).toBe(350_000);
  });

  test('a job fal no longer knows (404 on status) stays counted', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.queued.get('req-1')!.status = 'NOT_FOUND';
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('expired');
    expect(net(w)).toBe(350_000);
  });

  test('a file on a host that is not fal’s storage is paid for and refused: counted, and told not to retry', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.videoUrl = 'https://evil.example/clip.mp4';
    w.fake.finish('req-1');
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Do NOT retry');
    expect(net(w)).toBe(350_000);
    expect(w.fake.seen.some(request => request.host === 'evil.example')).toBe(false);
    expect((await status(w, job)).text).toContain('Do NOT retry');
  });

  test('a storage that is down for a moment keeps the job open: asking again fetches it, with no second charge', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    w.fake.cdn = 'not-found';
    const down = await status(w, job);
    expect(down.isError).toBe(true);
    expect(down.text).toContain('Nothing more is charged');
    expect(jobLines(w).filter(line => line.kind === 'finished')).toHaveLength(0);
    w.fake.cdn = 'ok';
    expect((await status(w, job)).text).toContain('type: video');
    expect(net(w)).toBe(350_000);
    expect(ledgerLines(w)).toHaveLength(1);
  });

  test('a file that is gone from fal’s storage (404 after it expired) is closed as counted and not retried forever', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    w.fake.cdn = 'not-found';
    for (let attempt = 1; attempt < 5; attempt++) {
      const open = await status(w, job);
      expect(open.text).toContain('Nothing more is charged');
    }
    const closed = await status(w, job);
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain('Do NOT retry');
    expect(closed.text).toContain('paid for');
    expect(net(w)).toBe(350_000);
    expect(jobLines(w).at(-1)).toMatchObject({ kind: 'finished', outcome: 'counted' });
    // closed: asking again reads nothing and fetches nothing
    const fetched = w.fake.to('v3b.fal.media').length;
    expect((await status(w, job)).text).toContain('Do NOT retry');
    expect(w.fake.to('v3b.fal.media')).toHaveLength(fetched);
  });

  test('a file that is not a video is refused after it was paid for, and not retried', async () => {
    const w = await world();
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    w.fake.cdn = 'wrong-type';
    const answer = await status(w, job);
    expect(answer.text).toContain('Do NOT retry');
    expect(w.delivered).toHaveLength(0);
  });

  test('a clip that cannot be saved keeps the job open for another try', async () => {
    const w = await world({ deliver: 'nowhere' });
    const job = jobOf((await video(w)).text);
    w.fake.finish('req-1');
    const answer = await status(w, job);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('could not be saved');
    expect(jobLines(w)).toHaveLength(1);
    expect(net(w)).toBe(350_000);
  });
});

describe('a daemon restart loses no job and charges nothing twice', () => {
  test('the new daemon finishes the old one’s job from the file, with no second reservation', async () => {
    const before = await world();
    const job = jobOf((await video(before)).text);
    const carried = {
      ledger: before.host.state('create').files.get('ledger.jsonl')!,
      jobs: before.host.state('create').files.get('jobs.jsonl')!,
    };
    // the first daemon is gone; fal made the clip meanwhile; a fresh daemon holds only the files
    const fake = new FakeFal();
    fake.queued.set('req-1', { endpoint: KLING, status: 'COMPLETED', result: 'ok', statusDrops: false });
    const after = await world({ carried, fake });
    const answer = await status(after, job);
    expect(answer.text).toContain('type: video');
    expect(answer.text).toContain('$0.35');
    expect(after.fake.to('queue.fal.run', 'POST')).toHaveLength(0);
    expect(ledgerLines(after)).toHaveLength(1);
    expect(net(after)).toBe(350_000);
    // and the same words asked for after the restart find the job already finished, not open: a new clip is a new payment
    const more = await video(after);
    expect(more.isError).toBeUndefined();
    expect(net(after)).toBe(700_000);
  });

  test('a restart in the middle of the job: the same words find the open job, not a second payment', async () => {
    const before = await world();
    const job = jobOf((await video(before)).text);
    const carried = {
      ledger: before.host.state('create').files.get('ledger.jsonl')!,
      jobs: before.host.state('create').files.get('jobs.jsonl')!,
    };
    const after = await world({ carried });
    const again = await video(after);
    expect(again.text).toContain(job);
    expect(after.fake.to('queue.fal.run', 'POST')).toHaveLength(0);
    expect(net(after)).toBe(350_000);
  });

  test('a job refunded before the restart is not refunded again after it', async () => {
    const before = await world();
    const job = jobOf((await video(before)).text);
    before.fake.finish('req-1', { error: 'runner lost', errorType: 'runner_disconnected' });
    await status(before, job);
    const carried = {
      ledger: before.host.state('create').files.get('ledger.jsonl')!,
      jobs: before.host.state('create').files.get('jobs.jsonl')!,
    };
    const after = await world({ carried });
    expect((await status(after, job)).text).toContain('given back');
    expect(net(after)).toBe(0);
    expect(ledgerLines(after)).toHaveLength(2);
    expect(after.fake.seen).toHaveLength(0);
  });
});
