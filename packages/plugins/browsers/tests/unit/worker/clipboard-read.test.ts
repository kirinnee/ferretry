import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLIPBOARD_HELPER_ORIGIN,
  ContextClipboardHelper,
  type ClipboardHelper,
  type HelperContext,
  type HelperPage,
  readClipboardOf,
} from '../../../daemon/worker/clipboard-read.ts';
import { COPY_VALUE_MAX_BYTES } from '../../../daemon/pages/copy-contracts.ts';

/** Never a real credential. */
const SENTINEL = 'FAKE-SC-7f3a91';

class Helper implements ClipboardHelper {
  cleared = 0;
  limits: number[] = [];
  constructor(
    private text: string,
    private readonly fails = false,
  ) {}
  async read(limit: number): Promise<string> {
    this.limits.push(limit);
    if (this.fails) throw new Error('NotAllowedError');
    return this.text.slice(0, limit);
  }
  async clear(): Promise<void> {
    this.cleared += 1;
    this.text = '';
  }
}

const page = (url = 'https://keys.example.test/new?x=1') => ({ url: () => url });
const document = (...ids: string[]) => {
  let at = 0;
  return async () => ({ navigationId: ids[Math.min(at++, ids.length - 1)] ?? 'loader-1' });
};

describe('reading the clipboard in the worker’s own context', () => {
  it('should answer the text under the page’s origin and document, and empty the clipboard', async () => {
    const helper = new Helper(SENTINEL);

    const read = await readClipboardOf(page(), document('loader-1'), helper);

    should(read).eql({
      ok: true,
      value: SENTINEL,
      origin: 'https://keys.example.test',
      frameOrigin: 'https://keys.example.test',
      navigationId: 'loader-1',
    });
    should(helper.cleared).equal(1);
  });

  it('should read at most one character over the cap, so a huge clipboard is refused without being carried whole', async () => {
    const helper = new Helper('x'.repeat(COPY_VALUE_MAX_BYTES * 3));

    const read = await readClipboardOf(page(), document('loader-1'), helper);

    should(helper.limits).eql([COPY_VALUE_MAX_BYTES + 1]);
    should(read.ok && read.value.length).equal(COPY_VALUE_MAX_BYTES + 1);
  });

  it('should say empty for a clipboard that holds nothing or only white space, and still empty it', async () => {
    for (const text of ['', '  \n']) {
      const helper = new Helper(text);

      should(await readClipboardOf(page(), document('loader-1'), helper)).eql({ ok: false, reason: 'empty' });
      should(helper.cleared).equal(1);
    }
  });

  it('should answer changed, and hold nothing, when the page moved to another document while it was read, still emptying the clipboard', async () => {
    const helper = new Helper(SENTINEL);

    const read = await readClipboardOf(page(), document('loader-1', 'loader-2'), helper);

    should(read).eql({ ok: false, reason: 'changed' });
    should(helper.cleared).equal(1);
  });

  it('should empty the clipboard even when reading it failed, and let the failure through', async () => {
    const helper = new Helper(SENTINEL, true);

    const failure = await readClipboardOf(page(), document('loader-1'), helper).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    should(failure?.message).equal('NotAllowedError');
    should(helper.cleared).equal(1);
  });

  // FINDING 2 (secure-clip-2 fix round 1): a clipboard that could not be emptied still holds the value, so the answer SAYS so
  // (`kept`) instead of reporting an ordinary success; the caller keeps the protection on until a clear is confirmed.
  it('should say the clipboard was KEPT when it could not be emptied, though the read worked', async () => {
    const helper = new Helper(SENTINEL);
    helper.clear = async () => {
      throw new Error('gone');
    };

    const read = await readClipboardOf(page(), document('loader-1'), helper);

    should(read.ok).equal(true);
    should(read.kept).equal(true);
  });

  it('should say KEPT for every outcome that left the clipboard unemptied: empty, changed and a failed read', async () => {
    const stuck = (helper: Helper): Helper => {
      helper.clear = async () => {
        throw new Error('gone');
      };
      return helper;
    };

    const empty = await readClipboardOf(page(), document('loader-1'), stuck(new Helper('')));
    const changed = await readClipboardOf(page(), document('loader-1', 'loader-2'), stuck(new Helper(SENTINEL)));
    const failed = await readClipboardOf(page(), document('loader-1'), stuck(new Helper(SENTINEL, true)));

    should(empty).eql({ ok: false, reason: 'empty', kept: true });
    should(changed).eql({ ok: false, reason: 'changed', kept: true });
    // A read that threw AND a clear that failed: the value may still be there, so it is not an error the caller can drop.
    should(failed).eql({ ok: false, reason: 'empty', kept: true });
  });

  it('should not say KEPT when the clear was confirmed', async () => {
    const read = await readClipboardOf(page(), document('loader-1'), new Helper(SENTINEL));

    should('kept' in read).equal(false);
  });
});

/** A Playwright context as the helper uses it, recording what it was asked. */
function fakeContext(options: { readonly stuck?: boolean } = {}) {
  const calls: string[] = [];
  let clipboard = SENTINEL;
  const helperPage: HelperPage = {
    goto: async url => void calls.push(`goto ${String(url)}`),
    bringToFront: async () => void calls.push('front'),
    isClosed: () => false,
    evaluate: async (work: (argument: never) => unknown, argument: never) => {
      const source = String(work);
      if (source.includes('readText') && !source.includes('writeText')) {
        calls.push('read');
        return clipboard.slice(0, argument as number) as never;
      }
      calls.push('clear');
      // A write that resolved but left text behind (`stuck`) is read back by the helper, and is a FAILED clear.
      if (options.stuck !== true) clipboard = '';
      return clipboard.length as never;
    },
  };
  const context: HelperContext = {
    grantPermissions: async (permissions, options) =>
      void calls.push(`grant ${permissions.join(',')} ${options.origin}`),
    route: async url => void calls.push(`route ${url}`),
    newPage: async () => helperPage,
    close: async () => undefined,
  };
  return { context, calls };
}

describe('the worker’s own helper page', () => {
  it('should CONFIRM a clear by reading the clipboard back, and fail when text is left', async () => {
    const stuck = fakeContext({ stuck: true });
    const helper = new ContextClipboardHelper(async () => stuck.context);

    const failure = await helper.clear().then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    should(failure?.message).containEql('still holds text');
  });

  it('should be made once, granted the clipboard for one made-up origin only, and reused', async () => {
    const { context, calls } = fakeContext();
    let made = 0;
    const helper = new ContextClipboardHelper(async () => {
      made += 1;
      return context;
    });

    const first = await helper.read(100);
    await helper.clear();
    const second = await helper.read(100);

    should(first).equal(SENTINEL);
    should(second).equal('');
    should(made).equal(1);
    should(calls.filter(call => call.startsWith('grant'))).eql([
      `grant clipboard-read,clipboard-write ${CLIPBOARD_HELPER_ORIGIN}`,
    ]);
    should(calls).containEql(`goto ${CLIPBOARD_HELPER_ORIGIN}/`);
    should(CLIPBOARD_HELPER_ORIGIN.endsWith('.invalid')).equal(true);
  });
});
