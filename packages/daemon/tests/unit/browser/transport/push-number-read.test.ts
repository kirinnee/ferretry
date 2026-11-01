import { describe, it } from 'bun:test';
import should from 'should';
import { parsePushNumberRead } from '../../../../src/adapters/browser/transport/worker-client.ts';
import type { PointedNumberRead, PushNumberScan } from '../../../../src/lib/browser/transport/push-number.ts';
import {
  type PushNumberHandle,
  type PushNumberLocator,
  type PushNumberPage,
  readPushNumber,
} from '../../../../src/lib/browser/transport/push-number-read.ts';

const ORIGIN = 'https://login.example.test';

/**
 * A page whose in-page looks answer what the test says: `scan` for the provider scan of the main frame, `pointed` for
 * the read of the element the ferret pointed at. Records what was asked and whether each handle was let go.
 */
function page(
  options: {
    readonly scan?: PushNumberScan | Error;
    readonly pointed?: PointedNumberRead | Error;
    readonly frame?: string | null;
    readonly count?: number | Error;
    readonly handle?: 'none' | Error;
    readonly url?: string;
    readonly disposeFails?: boolean;
  } = {},
) {
  const asked: string[] = [];
  const disposed: boolean[] = [];
  const handle: PushNumberHandle = {
    ownerFrame: async () => (options.frame === null ? null : { url: () => options.frame ?? `${ORIGIN}/login` }),
    evaluate: async <R>() => {
      if (options.pointed instanceof Error) throw options.pointed;
      return (options.pointed ?? { value: '17' }) as R;
    },
    dispose: async () => {
      disposed.push(true);
      if (options.disposeFails === true) throw new Error('target closed');
    },
  };
  const locator: PushNumberLocator = {
    first: () => locator,
    count: async () => {
      if (options.count instanceof Error) throw options.count;
      return options.count ?? 1;
    },
    elementHandle: async () => {
      if (options.handle instanceof Error) throw options.handle;
      return options.handle === 'none' ? null : handle;
    },
  };
  const subject: PushNumberPage = {
    evaluate: async <R>() => {
      if (options.scan instanceof Error) throw options.scan;
      return (options.scan ?? { missing: 'none-found' }) as R;
    },
    locator: selector => {
      asked.push(selector);
      return locator;
    },
    url: () => options.url ?? `${ORIGIN}/login?step=push`,
  };
  return { subject, asked, disposed };
}

const DOCUMENT = async () => ({ navigationId: 'loader-7' });
const REF = { kind: 'ref', ref: 'e12' } as const;

describe("reading a push approval's number from a page", () => {
  it("should answer a provider's number with the page's origin and document, without looking at a pointed element", async () => {
    const { subject, asked } = page({ scan: { provider: 'okta', number: { value: '42', from: 'okta' } } });

    const read = await readPushNumber(subject, DOCUMENT, REF);

    should(read).eql({
      origin: ORIGIN,
      navigationId: 'loader-7',
      provider: 'okta',
      number: { value: '42', from: 'okta', frameOrigin: ORIGIN },
    });
    should(asked).eql([]);
  });

  it('should say whose challenge it is with no number, and none when the scan itself fails', async () => {
    should(
      await readPushNumber(page({ scan: { provider: 'microsoft', missing: 'none-found' } }).subject, DOCUMENT),
    ).eql({
      origin: ORIGIN,
      navigationId: 'loader-7',
      provider: 'microsoft',
      missing: 'none-found',
    });
    should(await readPushNumber(page({ scan: new Error('Execution context was destroyed') }).subject, DOCUMENT)).eql({
      origin: ORIGIN,
      navigationId: 'loader-7',
      missing: 'none-found',
    });
  });

  it('should read the pointed element only when the provider shows none, marked as pointed, and let the handle go', async () => {
    const { subject, asked, disposed } = page();

    const read = await readPushNumber(subject, DOCUMENT, REF);

    should(read).eql({
      origin: ORIGIN,
      navigationId: 'loader-7',
      number: { value: '17', from: 'pointed', frameOrigin: ORIGIN },
    });
    should(asked).eql(['aria-ref=e12']);
    should(disposed).eql([true]);
  });

  it('should keep the number when letting the handle go fails', async () => {
    const { subject, disposed } = page({ disposeFails: true });

    should(await readPushNumber(subject, DOCUMENT, REF)).match({ number: { value: '17', from: 'pointed' } });
    should(disposed).eql([true]);
  });

  it('should answer editable for a pointed element anyone can type into', async () => {
    should(await readPushNumber(page({ pointed: { missing: 'editable' } }).subject, DOCUMENT, REF)).eql({
      origin: ORIGIN,
      navigationId: 'loader-7',
      missing: 'editable',
    });
  });

  it('should find none for a pointed element in a frame of another origin, or with no frame', async () => {
    for (const frame of ['https://evil.example/frame', null]) {
      const { subject, disposed } = page({ frame });
      should(await readPushNumber(subject, DOCUMENT, REF)).eql({
        origin: ORIGIN,
        navigationId: 'loader-7',
        missing: 'none-found',
      });
      should(disposed).eql([true]);
    }
  });

  it('should find none, never throw, for a pointed element that is missing or cannot be read', async () => {
    for (const options of [
      { count: 0 },
      { count: new Error('stale ref') },
      { handle: 'none' as const },
      { handle: new Error('timeout') },
      { pointed: new Error('detached') },
      { pointed: { missing: 'none-found' as const } },
    ])
      should(await readPushNumber(page(options).subject, DOCUMENT, REF)).eql({
        origin: ORIGIN,
        navigationId: 'loader-7',
        missing: 'none-found',
      });
  });

  it('should answer changed, and no number, when the page showed another document after the look', async () => {
    const documents = ['loader-7', 'loader-8'];
    const moving = async () => ({ navigationId: documents.shift() ?? 'loader-9' });

    const read = await readPushNumber(
      page({ scan: { provider: 'microsoft', number: { value: '58', from: 'microsoft' } } }).subject,
      moving,
    );

    should(read).eql({ origin: ORIGIN, navigationId: 'loader-7', provider: 'microsoft', missing: 'changed' });
  });
});

describe("believing the worker's push-number answer", () => {
  const base = { origin: ORIGIN, navigationId: 'loader-1' };

  it('should believe a number or a reason in exactly the shape the contract names', () => {
    should(
      parsePushNumberRead({ ...base, provider: 'duo', number: { value: '123456', from: 'duo', frameOrigin: ORIGIN } }),
    ).eql({ ...base, provider: 'duo', number: { value: '123456', from: 'duo', frameOrigin: ORIGIN } });
    should(parsePushNumberRead({ ...base, number: { value: '7', from: 'pointed', frameOrigin: ORIGIN } })).match({
      number: { from: 'pointed' },
    });
    for (const missing of ['none-found', 'editable', 'changed'])
      should(parsePushNumberRead({ ...base, missing })).eql({ ...base, missing });
  });

  it('should refuse anything else, in words that quote none of it', () => {
    const number = { value: '42', from: 'okta', frameOrigin: ORIGIN };
    for (const raw of [
      undefined,
      [],
      'fake-42',
      { ...base },
      { ...base, number, missing: 'none-found' },
      { ...base, number, said: 'fake-42' },
      { ...base, missing: 'fake-gone' },
      { ...base, provider: 'fake-idp', missing: 'none-found' },
      { ...base, origin: '', missing: 'none-found' },
      { ...base, origin: `https://${'x'.repeat(300)}`, missing: 'none-found' },
      { ...base, navigationId: 7, missing: 'none-found' },
      { ...base, number: 'fake-42' },
      { ...base, number: { ...number, said: 'fake-42' } },
      { ...base, number: { ...number, value: '4242424' } },
      { ...base, number: { ...number, value: ' 42' } },
      { ...base, number: { ...number, value: 42 } },
      { ...base, number: { ...number, from: 'ferret' } },
      { ...base, number: { ...number, frameOrigin: '' } },
    ]) {
      const refused = (() => {
        try {
          parsePushNumberRead(raw);
          return undefined;
        } catch (error) {
          return error as { code?: string; message: string };
        }
      })();
      should(refused?.code).equal('upstream_failed', JSON.stringify(raw)?.slice(0, 80));
      should(refused?.message).not.containEql('42');
      should(refused?.message).not.containEql('fake-');
    }
  });
});
