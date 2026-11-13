import { COPY_VALUE_MAX_BYTES, type BrowserClipboardRead } from '../pages/copy-contracts.ts';
import { originOfUrl } from '../target/lib/fields.ts';

/**
 * THE WORKER'S OWN CLIPBOARD READER (docs/secure-copy.md, "Capturing").
 *
 * Reading what a page's Copy button put on the clipboard needs the `clipboard-read` permission, and NO agent page is ever
 * given it: a page the agent can script could then read it back. So the worker keeps one context of its own, which no tool
 * can name, lists or script, with that permission for one made-up origin only, and reads there. Headless Chrome and a
 * private display have one clipboard for the whole browser, so what a page wrote is what the helper page reads.
 *
 * The clipboard is EMPTIED right after it is read. Otherwise the value would sit in the browser, and a paste the agent
 * presses itself (Control+V into a field of its own) would carry it into a page it can read.
 */

/** What the worker's own page does: read the clipboard's text, and replace it with nothing. */
export interface ClipboardHelper {
  /** The clipboard's text, cut at `limit` characters; `''` when it holds no text. */
  read(limit: number): Promise<string>;
  clear(): Promise<void>;
}

/** The page the clipboard is read for: its address, to say whose value it was. */
export interface ClipboardPage {
  url(): string;
}

/**
 * The clipboard's text, filed under the page the agent named. A page that navigated while it was read answers `changed`
 * and nothing is held, and the clipboard is emptied either way: whoever it was for, the value does not stay there.
 */
export async function readClipboardOf(
  page: ClipboardPage,
  document: () => Promise<{ readonly navigationId: string }>,
  helper: ClipboardHelper,
): Promise<BrowserClipboardRead> {
  const { navigationId } = await document();
  const origin = originOfUrl(page.url());
  let text: string;
  try {
    text = await helper.read(COPY_VALUE_MAX_BYTES + 1);
  } finally {
    await helper.clear().catch(() => undefined);
  }
  if (text.trim() === '') return { ok: false, reason: 'empty' };
  if ((await document()).navigationId !== navigationId) return { ok: false, reason: 'changed' };
  return { ok: true, value: text, origin, frameOrigin: origin, navigationId };
}

/** The made-up origin the helper page lives at: a reserved name, never a real site. */
export const CLIPBOARD_HELPER_ORIGIN = 'https://clipboard.ferretry.invalid';

/** The slice of a Playwright context the helper uses. */
export interface HelperContext {
  grantPermissions(permissions: string[], options: { origin: string }): Promise<void>;
  route(
    url: string,
    handler: (route: { fulfill(options: { contentType: string; body: string }): Promise<void> }) => Promise<void>,
  ): Promise<void>;
  newPage(): Promise<HelperPage>;
  close(): Promise<void>;
}

export interface HelperPage {
  goto(url: string): Promise<unknown>;
  bringToFront(): Promise<void>;
  evaluate<R, A>(work: (argument: A) => R | Promise<R>, argument: A): Promise<R>;
  isClosed(): boolean;
}

/**
 * The helper over a context of the worker's own, made on first use and kept. The page is visible and focused for each read,
 * because a document that is not focused may not read the clipboard.
 */
export class ContextClipboardHelper implements ClipboardHelper {
  private page: Promise<HelperPage> | undefined;

  constructor(private readonly makeContext: () => Promise<HelperContext>) {}

  async read(limit: number): Promise<string> {
    const page = await this.ready();
    await page.bringToFront();
    return await page.evaluate(async (cap: number) => {
      const text = await (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText();
      return text.slice(0, cap);
    }, limit);
  }

  async clear(): Promise<void> {
    const page = await this.ready();
    await page.bringToFront();
    await page.evaluate(async () => {
      await (navigator as unknown as { clipboard: { writeText(text: string): Promise<void> } }).clipboard.writeText('');
    }, undefined);
  }

  private async ready(): Promise<HelperPage> {
    const existing = this.page === undefined ? undefined : await this.page.catch(() => undefined);
    if (existing !== undefined && !existing.isClosed()) return existing;
    const made = (async (): Promise<HelperPage> => {
      const context = await this.makeContext();
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: CLIPBOARD_HELPER_ORIGIN });
      await context.route(`${CLIPBOARD_HELPER_ORIGIN}/**`, async route => {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>.</title>' });
      });
      const page = await context.newPage();
      await page.goto(`${CLIPBOARD_HELPER_ORIGIN}/`);
      return page;
    })();
    this.page = made;
    return await made;
  }
}
