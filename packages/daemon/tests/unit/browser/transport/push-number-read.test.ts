import { describe, it } from 'bun:test';
import should from 'should';
import { parsePushNumberRead } from '../../../../src/adapters/browser/transport/worker-client.ts';
import type { PushNumberScan } from '../../../../src/lib/browser/transport/push-number.ts';
import { type PushNumberPage, readPushNumber } from '../../../../src/lib/browser/transport/push-number-read.ts';

const ORIGIN = 'https://login.example.test';

/** A page whose in-page scan of the main frame answers what the test says. */
function page(options: { readonly scan?: PushNumberScan | Error; readonly url?: string } = {}) {
  const subject: PushNumberPage = {
    evaluate: async <R>() => {
      if (options.scan instanceof Error) throw options.scan;
      return (options.scan ?? { missing: 'none-found' }) as R;
    },
    url: () => options.url ?? `${ORIGIN}/login?step=push`,
  };
  return { subject };
}

const DOCUMENT = async () => ({ navigationId: 'loader-7' });

describe("reading a push approval's number from a page", () => {
  it("should answer a provider's number with the page's origin and document", async () => {
    const read = await readPushNumber(
      page({ scan: { provider: 'okta', number: { value: '42', from: 'okta' } } }).subject,
      DOCUMENT,
    );

    should(read).eql({
      origin: ORIGIN,
      navigationId: 'loader-7',
      provider: 'okta',
      number: { value: '42', from: 'okta', frameOrigin: ORIGIN },
    });
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
    for (const missing of ['none-found', 'changed'])
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
      // A ferret-pointed element is no source of a number at all (secrev-1244 H1), and nothing reads as one.
      { ...base, missing: 'editable' },
      { ...base, number: { ...number, from: 'pointed' } },
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
