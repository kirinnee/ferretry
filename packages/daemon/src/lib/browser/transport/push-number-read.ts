import type { BrowserElementTarget } from '@ferretry/protocol';
import type { BrowserPushNumberRead } from './input-contracts.ts';
import { originOfUrl } from './input-fields.ts';
import { browserSelectorOf } from './page-acts.ts';
import { type PointedNumberRead, type PushNumberScan, readPointedNumber, scanPushNumber } from './push-number.ts';

/** The slice of an element handle a push-number read uses: its frame, one look inside the page, and letting it go. */
export interface PushNumberHandle {
  ownerFrame(): Promise<{ url(): string } | null>;
  evaluate<R, A>(read: (element: unknown, argument: A) => R, argument: A): Promise<R>;
  dispose(): Promise<void>;
}

export interface PushNumberLocator {
  first(): PushNumberLocator;
  count(): Promise<number>;
  elementHandle(options: { readonly timeout: number }): Promise<PushNumberHandle | null>;
}

/** The page a push number is read from: Playwright's view of it. `evaluate` runs in its main frame. */
export interface PushNumberPage {
  evaluate<R, A>(read: (argument: A) => R, argument: A): Promise<R>;
  locator(selector: string): PushNumberLocator;
  url(): string;
}

/** How long the pointed element may take to be found before the read says there is none. */
const POINTED_PROBE_TIMEOUT_MS = 1_000;

/**
 * One look for a push approval's number (docs/input-requests.md, "Approve on your phone"). The provider's own view is
 * scanned first, in the main frame (`scanPushNumber`); only when it shows no number is `element`, the one a ferret
 * pointed at, read (`readPointedNumber`), and only in the main frame or a frame of the page's own origin. The document
 * is read before and after: a page that moved on in between answers `changed` and no number, so a number is never
 * filed under a document it was not read from. Never throws for an element that is not there.
 */
export async function readPushNumber(
  page: PushNumberPage,
  document: () => Promise<{ readonly navigationId: string }>,
  element?: BrowserElementTarget,
): Promise<BrowserPushNumberRead> {
  const { navigationId } = await document();
  const origin = originOfUrl(page.url());
  const scan: PushNumberScan = await page
    .evaluate(scanPushNumber, {})
    .catch((): PushNumberScan => ({ missing: 'none-found' }));
  const provider = scan.provider === undefined ? {} : { provider: scan.provider };
  let number: BrowserPushNumberRead['number'];
  let missing: BrowserPushNumberRead['missing'] = 'none-found';
  if (scan.number !== undefined) number = { value: scan.number.value, from: scan.number.from, frameOrigin: origin };
  else if (element !== undefined) {
    const pointed = await readPointed(page, origin, element);
    if (pointed.value !== undefined) number = { value: pointed.value, from: 'pointed', frameOrigin: origin };
    else if (pointed.missing === 'editable') missing = 'editable';
  }
  if ((await document()).navigationId !== navigationId)
    return { origin, navigationId, ...provider, missing: 'changed' };
  return number === undefined
    ? { origin, navigationId, ...provider, missing }
    : { origin, navigationId, ...provider, number };
}

/** The pointed element's number, when it is on the page in the page's own origin; else why not. */
async function readPointed(
  page: PushNumberPage,
  origin: string,
  element: BrowserElementTarget,
): Promise<PointedNumberRead> {
  let handle: PushNumberHandle | null;
  try {
    const found = page.locator(browserSelectorOf(element)).first();
    if ((await found.count().catch(() => 0)) === 0) return { missing: 'none-found' };
    handle = await found.elementHandle({ timeout: POINTED_PROBE_TIMEOUT_MS });
  } catch {
    return { missing: 'none-found' };
  }
  if (handle === null) return { missing: 'none-found' };
  try {
    const frame = await handle.ownerFrame();
    // A frame from another site is not this page's to vouch for: its number is none of the page's business.
    if (frame === null || originOfUrl(frame.url()) !== origin) return { missing: 'none-found' };
    return await handle.evaluate(readPointedNumber, {});
  } catch {
    return { missing: 'none-found' };
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}
