import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { SPEND_LEDGER } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { dayOf } from '../../daemon/lib/spend.ts';

const KEY = 'fal-test-key-0123456789';
const PNG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const CDN = 'https://v3.fal.media/files/zebra/picture.jpg';

/** A fal that answers like the real two hosts and the CDN, and remembers every request that reached it. */
class FakeFal {
  readonly seen: { host: string; path: string; method: string; headers: Headers; body: string | undefined }[] = [];
  /** What the price endpoint answers; `undefined` = a 404. */
  price: { unit_price: number; unit: string } | undefined = { unit_price: 0.003, unit: 'megapixels' };
  priceStatus = 200;
  runStatus = 200;
  /** When set, the run itself never answers: the connection drops (a timeout or a network error to the kernel). */
  runDrops = false;
  /** The currency fal's price endpoint names. */
  currency = 'USD';
  picture: Uint8Array = PNG;
  pictureUrl = CDN;
  pictureType = 'image/jpeg';
  /** How fal's storage answers: a picture, a 404, a dropped connection, or a file that says it is huge. */
  cdn: 'ok' | 'not-found' | 'throws' | 'declares-huge' = 'ok';

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
      const endpoint = url.searchParams.get('endpoint_id');
      return Response.json({
        prices: this.price === undefined ? [] : [{ endpoint_id: endpoint, currency: this.currency, ...this.price }],
      });
    }
    if (url.host === 'fal.run') {
      if (this.runDrops) throw new Error('connection dropped');
      if (this.runStatus !== 200) return new Response('no', { status: this.runStatus });
      return Response.json({ images: [{ url: this.pictureUrl, content_type: this.pictureType }], seed: 1 });
    }
    if (url.host.endsWith('fal.media')) {
      // A plain reply object: the unit tier runs many files in one process, some of which replace the global
      // `Response` and `Blob`, and these bytes must reach the tool exactly as they are here.
      if (this.cdn === 'throws') throw new Error('connection reset');
      const bytes = this.picture;
      return {
        ok: this.cdn !== 'not-found',
        status: this.cdn === 'not-found' ? 404 : 200,
        headers: new Map<string, string>([
          ['content-type', this.pictureType],
          ...(this.cdn === 'declares-huge' ? ([['content-length', String(64 * 1024 * 1024)]] as const) : []),
        ]) as unknown as Headers,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    }
    throw new Error(`the fake fal was asked for ${url.host}`);
  };

  runs(): number {
    return this.seen.filter(request => request.host === 'fal.run').length;
  }
}

interface World {
  readonly fal: FakeFal;
  readonly asks: FakeAsks;
  readonly delivered: { ferret: string; name: string; bytes: number }[];
  readonly host: Awaited<ReturnType<typeof testHost>>;
  readonly standing: { current: CallStanding };
}

async function world(
  options: {
    key?: boolean;
    limits?: { dailyUsd?: number; askAboveUsd?: number };
    ledger?: readonly object[];
    deliver?: 'ok' | 'nowhere';
  } = {},
): Promise<World> {
  const standing: { current: CallStanding } = { current: ferretStanding(ferretId('test-ferret')) };
  const fal = new FakeFal();
  const asks = new FakeAsks();
  const delivered: World['delivered'] = [];
  const ferrets = {
    harness: async (ferret: string) =>
      options.deliver === 'nowhere'
        ? undefined
        : {
            deliverMedia: async (files: readonly { name: string; folder?: string; contents: Uint8Array }[]) =>
              files.map(file => {
                delivered.push({ ferret, name: file.name, bytes: file.contents.byteLength });
                return file.name;
              }),
          },
  };
  const config = {
    ...(options.key === false ? {} : { fal: { key: '${secret:FAL_KEY}' } }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => standing.current),
    fakes: { asks, ferrets },
    fetch: fal.fetch,
    vault: { FAL_KEY: KEY },
    config: { 'create.yaml': config },
  });
  if (options.ledger !== undefined)
    host
      .state('create')
      .plant(
        SPEND_LEDGER,
        options.ledger
          .map(line =>
            JSON.stringify({ format: 1, ...line, day: dayNamed(host.clock.nowMs(), (line as { day: string }).day) }),
          )
          .join('\n') + '\n',
      );
  return { fal, asks, delivered, host, standing };
}

const ask = (w: World, input: Record<string, unknown> = {}) =>
  w.host.tool('generate_image', { prompt: 'a fox in snow', ...input });

/** 'today' and 'yesterday' in the test clock's own day, so a planted line is on the day the tool will read. */
const dayNamed = (nowMs: number, which: string): string =>
  dayOf(new Date(nowMs - (which === 'yesterday' ? 86_400_000 : 0)), 'UTC');

const ledgerLines = (w: World): readonly Record<string, unknown>[] =>
  (w.host.state('create').files.get('ledger.jsonl') ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));

/** What the ledger adds up to: reservations less refunds. */
const net = (w: World): number =>
  ledgerLines(w).reduce((sum, line) => sum + (line.refund === true ? -1 : 1) * (line.microUsd as number), 0);

const spent = (microUsd: number, day: 'today' | 'yesterday' = 'today') => ({
  at: '2026-11-24T08:00:00.000Z',
  day,
  tool: 'generate_image',
  model: 'flux-pro',
  ferret: 'other',
  microUsd,
  priced: 'table',
  request: '0123456789abcdef',
});

describe('generate_image: a picture, priced first, recorded, and handed over', () => {
  test('makes one picture: the key is placed by the kernel, the price shown, the spend recorded', async () => {
    const w = await world();
    const answer = await ask(w);
    expect(answer.isError).toBeUndefined();
    // the price came from fal's own endpoint, then the run, then the picture from the CDN with NO key
    expect(w.fal.seen.map(request => request.host)).toEqual(['api.fal.ai', 'fal.run', 'v3.fal.media']);
    expect(w.fal.seen[0]!.headers.get('authorization')).toBe(`Key ${KEY}`);
    expect(w.fal.seen[1]!.headers.get('authorization')).toBe(`Key ${KEY}`);
    expect(w.fal.seen[2]!.headers.get('authorization')).toBeNull();
    expect(JSON.parse(w.fal.seen[1]!.body!)).toMatchObject({
      prompt: 'a fox in snow',
      num_images: 1,
      output_format: 'jpeg',
    });
    // 1024 × 768 = 0.786 MP at $0.003
    expect(answer.text).toContain('flux-schnell for $0.0024');
    expect(answer.text).toContain('fal’s price');
    // ONE piece to paste: the cost line, then the block that names the picture in the media folder. No ferret step.
    expect(answer.text).toContain(
      'Put these lines in your reply:\nflux-schnell · $0.0024 · $0.0024 of $5.00 today\n```fy-render\ntype: image\nalt: a fox in snow\nsrc: media:create-flux-schnell-',
    );
    expect(answer.text).not.toContain('cp ');
    expect(answer.text).not.toContain('FY_MEDIA_DIR');
    expect(w.delivered).toHaveLength(1);
    expect(ledgerLines(w)).toMatchObject([
      { tool: 'generate_image', model: 'flux-schnell', ferret: 'test-ferret', microUsd: 2360, priced: 'fal' },
    ]);
    // nothing a ferret reads, and nothing the ledger keeps, holds the key or the prompt
    expect(answer.text).not.toContain(KEY);
    expect(JSON.stringify([...w.host.state('create').files.values()])).not.toContain(KEY);
    expect(JSON.stringify([...w.host.state('create').files.values()])).not.toContain('a fox in snow');
    expect(w.host.logs.map(log => `${log.message} ${JSON.stringify(log.fields ?? {})}`).join('\n')).not.toContain(KEY);
  });

  test('with no fal key named in create.yaml nothing leaves the machine and the answer says how to add one', async () => {
    const w = await world({ key: false });
    const answer = await ask(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('fy secret set FAL_KEY');
    expect(w.fal.seen).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(0);
  });

  test('only a ferret may spend: the owner’s own call is refused', async () => {
    const w = await world();
    w.standing.current = ownerStanding();
    const answer = await w.host.tool('generate_image', { prompt: 'x' });
    expect(answer.isError).toBe(true);
    expect(w.fal.seen).toHaveLength(0);
  });

  test('an invalid request spends nothing', async () => {
    const w = await world();
    for (const input of [
      { prompt: '' },
      { prompt: 'x', model: 'dall-e' },
      { prompt: 'x', size: 'huge' },
      { prompt: 'x', extra: 1 },
    ]) {
      const answer = await w.host.tool('generate_image', input);
      expect(answer.isError).toBe(true);
    }
    expect(w.fal.seen).toHaveLength(0);
  });

  test('the table prices the call when fal’s price endpoint cannot be reached', async () => {
    const w = await world();
    w.fal.priceStatus = 500;
    const answer = await ask(w, { model: 'flux-dev', size: 'square' });
    expect(answer.text).toContain('the listed price');
    // 512 × 512 = 0.262 MP at $0.025
    expect(ledgerLines(w)).toMatchObject([
      { model: 'flux-dev', priced: 'table', microUsd: Math.ceil(25_000 * 0.262144) },
    ]);
  });

  test('a price in a unit that cannot be read is refused: nothing is sent', async () => {
    const w = await world();
    w.fal.price = { unit_price: 1, unit: 'second' };
    const answer = await ask(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Create cannot price');
    expect(w.fal.runs()).toBe(0);
  });

  test('a key fal refuses is said, and nothing is run or recorded', async () => {
    const w = await world();
    w.fal.priceStatus = 401;
    const answer = await ask(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('fal refused the key');
    expect(w.fal.runs()).toBe(0);
  });

  test('the spend is reserved BEFORE the run, and only a definite no-charge gives it back', async () => {
    // fal refused it (401, 403, 429 or another 4xx): nothing was billed, so the day's sum is back to zero
    for (const status of [401, 403, 422, 429]) {
      const w = await world();
      w.fal.runStatus = status;
      const answer = await ask(w);
      expect(answer.isError).toBe(true);
      expect(ledgerLines(w)).toMatchObject([{ microUsd: 2360 }, { microUsd: 2360, refund: true }]);
      expect(net(w)).toBe(0);
    }
    // a 5xx, a connection that drops, or a timeout may have been billed: it stays counted
    for (const arrange of [(fal: FakeFal) => (fal.runStatus = 502), (fal: FakeFal) => (fal.runDrops = true)]) {
      const w = await world();
      arrange(w.fal);
      const answer = await ask(w);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('still counts toward today');
      expect(ledgerLines(w)).toHaveLength(1);
      expect(net(w)).toBe(2360);
    }
  });

  test('a run that timed out counts toward the cap: the next call is refused', async () => {
    const w = await world({ limits: { dailyUsd: 0.004 } });
    w.fal.runDrops = true;
    expect((await ask(w)).isError).toBe(true);
    w.fal.runDrops = false;
    const next = await ask(w, { prompt: 'a bear' });
    expect(next.isError).toBe(true);
    expect(next.text).toContain('daily limit');
    expect(w.fal.runs()).toBe(1);
  });

  test('a price fal gives in another currency is refused: nothing is sent', async () => {
    const w = await world();
    w.fal.currency = 'EUR';
    const answer = await ask(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('currency other than USD');
    expect(w.fal.runs()).toBe(0);
    expect(ledgerLines(w)).toHaveLength(0);
  });

  test('money spent is recorded even when the picture cannot be fetched or saved', async () => {
    const w = await world();
    w.fal.pictureUrl = 'https://evil.example/x.jpg';
    const answer = await ask(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('made and paid for');
    expect(w.fal.seen.map(request => request.host)).not.toContain('evil.example');
    expect(ledgerLines(w)).toHaveLength(1);

    const nowhere = await world({ deliver: 'nowhere' });
    const lost = await ask(nowhere);
    expect(lost.isError).toBe(true);
    expect(ledgerLines(nowhere)).toHaveLength(1);
  });

  test('what fal’s storage may answer wrongly never becomes a picture, and the spend is still recorded', async () => {
    const wrong: readonly [string, (fal: FakeFal) => void][] = [
      ['answered 404', fal => (fal.cdn = 'not-found')],
      ['could not be fetched', fal => (fal.cdn = 'throws')],
      ['larger than Create will fetch', fal => (fal.cdn = 'declares-huge')],
      ['not a picture', fal => (fal.pictureType = 'text/html')],
    ];
    for (const [sentence, arrange] of wrong) {
      const w = await world();
      arrange(w.fal);
      const answer = await ask(w);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(sentence);
      expect(w.delivered).toHaveLength(0);
      expect(ledgerLines(w)).toHaveLength(1);
    }
  });

  test('a png or webp picture keeps its own extension', async () => {
    const w = await world();
    w.fal.pictureType = 'image/webp';
    expect((await ask(w)).text).toContain('.webp');
  });

  test('an empty file from fal’s storage is not handed over as a picture (the spend is still recorded)', async () => {
    const w = await world();
    w.fal.picture = new Uint8Array(0);
    const answer = await ask(w);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('empty file');
    expect(w.delivered).toHaveLength(0);
    expect(ledgerLines(w)).toHaveLength(1);
  });

  test('a picture over the chat’s 1 MB is handed over with no block to show', async () => {
    const w = await world();
    w.fal.picture = new Uint8Array(1024 * 1024 + 1);
    const answer = await ask(w);
    expect(answer.text).toContain('over the 1 MB the chat shows');
    expect(answer.text).toContain('flux-schnell · $0.0024');
    expect(answer.text).not.toContain('fy-render');
    expect(w.delivered).toHaveLength(1);
  });
});

describe('the daily cap', () => {
  test('a call that would pass $5 for the day is refused and nothing is sent', async () => {
    const w = await world({ ledger: [spent(4_999_000)] });
    w.fal.price = { unit_price: 0.04, unit: 'megapixels' };
    const answer = await ask(w, { model: 'flux-pro', size: 'square_hd' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('daily limit of $5.00');
    expect(w.fal.runs()).toBe(0);
  });

  test('yesterday’s spend does not count toward today', async () => {
    const w = await world({ ledger: [spent(4_999_000, 'yesterday')] });
    const answer = await ask(w);
    expect(answer.isError).toBeUndefined();
    expect(w.fal.runs()).toBe(1);
  });

  test('two ferrets asking together cannot both pass the same cap', async () => {
    const w = await world({ limits: { dailyUsd: 0.004 } });
    const [a, b] = await Promise.all([ask(w), ask(w, { prompt: 'a bear' })]);
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    expect(w.fal.runs()).toBe(1);
    expect(ledgerLines(w)).toHaveLength(1);
  });
});

describe('a call over the one-call limit asks the owner first, through Asks', () => {
  const dear = { model: 'flux-pro', size: 'square_hd' } as const; // ≈ $0.04, over a 1 cent limit

  test('asks and sends nothing; approve lets the one call through; the same request asks again', async () => {
    const w = await world({ limits: { askAboveUsd: 0.01 } });
    w.fal.price = { unit_price: 0.04, unit: 'megapixels' };

    const waiting = await ask(w, dear);
    expect(waiting.isError).toBeUndefined();
    expect(waiting.text).toContain('Not sent yet');
    expect(waiting.text).toContain('$0.05');
    expect(w.fal.runs()).toBe(0);
    const [open] = await w.asks.open({});
    expect(open).toMatchObject({ source: 'create-spend', kind: 'permission', ferret: 'test-ferret', blocking: true });
    // asking again before the owner answers raises no second ask
    await ask(w, dear);
    expect(await w.asks.open({})).toHaveLength(1);

    w.asks.answerAs({ ferret: 'test-ferret', id: open!.id }, 'approve');
    const made = await ask(w, dear);
    expect(made.isError).toBeUndefined();
    expect(made.text).toContain('Made one picture with flux-pro');
    expect(w.fal.runs()).toBe(1);

    // the approval was spent by that one call: the same request asks again
    const again = await ask(w, dear);
    expect(again.text).toContain('Not sent yet');
    expect(w.fal.runs()).toBe(1);
    expect(await w.asks.open({})).toHaveLength(1);
  });

  test('an approval holds for the price it was asked at: a dearer call asks again, a cheaper one goes', async () => {
    const w = await world({ limits: { askAboveUsd: 0.01 } });
    w.fal.price = { unit_price: 0.04, unit: 'megapixels' };
    await ask(w, dear);
    const [first] = await w.asks.open({});
    w.asks.answerAs({ ferret: 'test-ferret', id: first!.id }, 'approve');
    // fal's live price has since gone UP: the approval was for the old price, so the owner is asked again
    w.fal.price = { unit_price: 0.08, unit: 'megapixels' };
    const dearer = await ask(w, dear);
    expect(dearer.text).toContain('Not sent yet');
    expect(w.fal.runs()).toBe(0);
    // a NEW ask, for the new price (the approved one is answered, so it is no longer open)
    expect(await w.asks.open({})).toHaveLength(1);
    // back at the approved price (or below it) the first approval still lets the call through
    w.fal.price = { unit_price: 0.04, unit: 'megapixels' };
    const made = await ask(w, dear);
    expect(made.text).toContain('Made one picture');
    expect(w.fal.runs()).toBe(1);
  });

  test('a rejection refuses, spends nothing, and says what to do instead', async () => {
    const w = await world({ limits: { askAboveUsd: 0.01 } });
    w.fal.price = { unit_price: 0.04, unit: 'megapixels' };
    await ask(w, dear);
    const [open] = await w.asks.open({});
    w.asks.answerAs({ ferret: 'test-ferret', id: open!.id }, 'reject');
    const answer = await ask(w, dear);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('declined');
    expect(w.fal.runs()).toBe(0);
  });

  test('an agenda that cannot take the ask sends nothing', async () => {
    const w = await world({ limits: { askAboveUsd: 0.01 } });
    w.fal.price = { unit_price: 0.04, unit: 'megapixels' };
    (w.asks as unknown as { raise: () => Promise<never> }).raise = async () => {
      throw new Error('full');
    };
    const answer = await ask(w, dear);
    expect(answer.isError).toBe(true);
    expect(w.fal.runs()).toBe(0);
  });

  test('a call under the limit never asks', async () => {
    const w = await world();
    await ask(w);
    expect(await w.asks.open({})).toHaveLength(0);
  });
});
