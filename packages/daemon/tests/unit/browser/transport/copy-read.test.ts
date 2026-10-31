import { describe, it } from 'bun:test';
import { COPY_VALUE_MAX_BYTES } from '@ferretry/protocol';
import should from 'should';
import {
  type CopyablePage,
  type CopyHandle,
  type CopyLocator,
  readCopyElement,
} from '../../../../src/lib/browser/transport/copy-read.ts';

const TOKEN = 'ghp_PAGE-COPY-NEVER-LOGGED-91c2';

/** An element as the page would answer a read of it. */
interface FakeElement {
  readonly innerText?: string;
  readonly textContent?: string | null;
  readonly value?: unknown;
  readonly attributes?: Readonly<Record<string, string>>;
}

/** A page with at most one element: what it was asked, and whether each handle was let go. */
function page(
  options: {
    readonly element?: FakeElement;
    readonly frame?: string | null;
    readonly url?: string;
    readonly count?: number | Error;
    readonly handle?: 'none' | Error;
  } = {},
) {
  const asked: string[] = [];
  const disposed: boolean[] = [];
  const element = options.element ?? { innerText: `  ${TOKEN}\n` };
  const node = {
    ...element,
    getAttribute: (name: string) => element.attributes?.[name] ?? null,
  };
  const handle: CopyHandle = {
    ownerFrame: async () =>
      options.frame === null ? null : { url: () => options.frame ?? 'https://github.com/settings' },
    evaluate: async (read, argument) => read(node, argument),
    dispose: async () => void disposed.push(true),
  };
  const locator: CopyLocator = {
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
  const subject: CopyablePage = {
    locator: selector => {
      asked.push(selector);
      return locator;
    },
    url: () => options.url ?? 'https://github.com/settings/tokens/new',
  };
  return { subject, asked, disposed };
}

const DOCUMENT = async () => ({ navigationId: 'loader-7' });
const REF = { kind: 'ref', ref: 'e12' } as const;

describe('reading a page element for a secure copy', () => {
  it("should answer an element's text with the page's and the frame's origin and the document, and let the handle go", async () => {
    const { subject, asked, disposed } = page();

    const read = await readCopyElement(subject, DOCUMENT, REF, 'text');

    should(read).eql({
      ok: true,
      value: `  ${TOKEN}\n`,
      origin: 'https://github.com',
      frameOrigin: 'https://github.com',
      navigationId: 'loader-7',
    });
    should(asked).eql(['aria-ref=e12']);
    should(disposed).eql([true]);
  });

  it("should read a field's value or one attribute, and fall back to textContent for text", async () => {
    const field = page({ element: { value: TOKEN } });
    const attribute = page({ element: { attributes: { 'data-token': TOKEN } } });
    const bare = page({ element: { textContent: TOKEN } });

    const reads = [
      await readCopyElement(field.subject, DOCUMENT, REF, 'value'),
      await readCopyElement(
        attribute.subject,
        DOCUMENT,
        { kind: 'selector', selector: '#t' },
        'attribute',
        'data-token',
      ),
      await readCopyElement(bare.subject, DOCUMENT, REF, 'text'),
    ];

    should(reads.map(read => (read.ok ? read.value : read.reason))).eql([TOKEN, TOKEN, TOKEN]);
    should(attribute.asked).eql(['#t']);
  });

  it('should name the origin of a frame from another site the element sits in', async () => {
    const { subject } = page({ frame: 'https://auth.example/frame' });

    const read = await readCopyElement(subject, DOCUMENT, REF, 'text');

    should(read).match({ ok: true, origin: 'https://github.com', frameOrigin: 'https://auth.example' });
  });

  it('should say missing for an element that is not there, a handle it cannot hold, or no frame', async () => {
    const cases = [
      page({ count: 0 }),
      page({ count: new Error('detached') }),
      page({ handle: 'none' }),
      page({ handle: new Error('stale ref') }),
      page({ frame: null }),
    ];

    const reads = await Promise.all(
      cases.map(async each => await readCopyElement(each.subject, DOCUMENT, REF, 'text')),
    );

    should(reads).eql(cases.map(() => ({ ok: false, reason: 'missing' })));
  });

  it('should say empty for an element with nothing in the part asked for', async () => {
    const cases = [
      page({ element: { innerText: '' } }),
      page({ element: { textContent: null } }),
      page({ element: { value: 7 } }),
      page({ element: { attributes: {} } }),
    ];
    const parts = ['text', 'text', 'value', 'attribute'] as const;

    const reads = await Promise.all(
      cases.map(async (each, index) => await readCopyElement(each.subject, DOCUMENT, REF, parts[index] ?? 'text', 'x')),
    );

    should(reads).eql(cases.map(() => ({ ok: false, reason: 'empty' })));
  });

  it('should cut a huge value one character over the cap, so the daemon refuses it without carrying it all', async () => {
    const { subject } = page({ element: { innerText: 'x'.repeat(COPY_VALUE_MAX_BYTES * 4) } });

    const read = await readCopyElement(subject, DOCUMENT, REF, 'text');

    should(read.ok && read.value.length).equal(COPY_VALUE_MAX_BYTES + 1);
  });
});
