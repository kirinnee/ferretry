import { type BrowserElementTarget, COPY_VALUE_MAX_BYTES, type CopyElementPart } from '@ferretry/protocol';
import type { BrowserCopyRead } from './copy-contracts.ts';
import { originOfUrl } from './input-fields.ts';
import { browserSelectorOf } from './page-acts.ts';

/** The slice of an element handle a copy read uses: its frame, one read inside the page, and letting it go. */
export interface CopyHandle {
  ownerFrame(): Promise<{ url(): string } | null>;
  evaluate<R, A>(read: (element: unknown, argument: A) => R, argument: A): Promise<R>;
  dispose(): Promise<void>;
}

export interface CopyLocator {
  first(): CopyLocator;
  count(): Promise<number>;
  elementHandle(options: { readonly timeout: number }): Promise<CopyHandle | null>;
}

/** The page a copy is read from: Playwright's view of it. */
export interface CopyablePage {
  locator(selector: string): CopyLocator;
  url(): string;
}

/** How long the element may take to be found before the read says it is missing. */
const COPY_PROBE_TIMEOUT_MS = 1_000;

/**
 * Reads one element's text, a field's value or one attribute, for a secure copy (copy-contracts.ts). Where it
 * was read is the browser's own answer: the page's and the frame's origin and `navigationId` (from `document`,
 * the same loader id the input bridge holds a page by), read BEFORE the value so a navigation in between is a
 * different document, not this one. A value is cut at one character over the cap: enough for the daemon to
 * refuse it as too long, never the whole of a huge one.
 */
export async function readCopyElement(
  page: CopyablePage,
  document: () => Promise<{ readonly navigationId: string }>,
  target: BrowserElementTarget,
  part: CopyElementPart,
  attribute?: string,
): Promise<BrowserCopyRead> {
  const { navigationId } = await document();
  const origin = originOfUrl(page.url());
  let handle: CopyHandle | null;
  try {
    const element = page.locator(browserSelectorOf(target)).first();
    if ((await element.count().catch(() => 0)) === 0) return { ok: false, reason: 'missing' };
    handle = await element.elementHandle({ timeout: COPY_PROBE_TIMEOUT_MS });
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (handle === null) return { ok: false, reason: 'missing' };
  try {
    const frame = await handle.ownerFrame();
    if (frame === null) return { ok: false, reason: 'missing' };
    const frameOrigin = originOfUrl(frame.url());
    const value = await handle.evaluate(readPart, {
      part,
      attribute: attribute ?? '',
      limit: COPY_VALUE_MAX_BYTES + 1,
    });
    if (typeof value !== 'string' || value === '') return { ok: false, reason: 'empty' };
    return { ok: true, value, origin, frameOrigin, navigationId };
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/** Runs IN the page: the part asked for, as text, cut at `limit` characters; nothing when there is none. */
function readPart(
  element: unknown,
  { part, attribute, limit }: { readonly part: CopyElementPart; readonly attribute: string; readonly limit: number },
): string | null {
  const node = element as {
    innerText?: string;
    textContent?: string | null;
    value?: unknown;
    getAttribute?: (name: string) => string | null;
  };
  const text =
    part === 'attribute'
      ? (node.getAttribute?.(attribute) ?? null)
      : part === 'value'
        ? typeof node.value === 'string'
          ? node.value
          : null
        : (node.innerText ?? node.textContent ?? null);
  return text === null ? null : text.slice(0, limit);
}
