import type { BrowserPushNumberRead } from './input-contracts.ts';
import { originOfUrl } from './input-fields.ts';
import { type PushNumberScan, scanPushNumber } from './push-number.ts';

/** The page a push number is read from: Playwright's view of it. `evaluate` runs in its main frame. */
export interface PushNumberPage {
  evaluate<R, A>(read: (argument: A) => R, argument: A): Promise<R>;
  url(): string;
}

/**
 * One look for a push approval's number (docs/input-requests.md, "Approve on your phone"): the provider's own challenge
 * view, scanned in the main frame (`scanPushNumber`). NOTHING A FERRET POINTS AT IS READ: a page may echo back text the
 * ferret typed (Okta shows the username it was given), so an element the ferret chose could show any number it likes
 * (secrev-1244 H1). The document is read before and after: a page that moved on in between answers `changed` and no
 * number, so a number is never filed under a document it was not read from.
 */
export async function readPushNumber(
  page: PushNumberPage,
  document: () => Promise<{ readonly navigationId: string }>,
): Promise<BrowserPushNumberRead> {
  const { navigationId } = await document();
  const origin = originOfUrl(page.url());
  const scan: PushNumberScan = await page
    .evaluate(scanPushNumber, {})
    .catch((): PushNumberScan => ({ missing: 'none-found' }));
  const provider = scan.provider === undefined ? {} : { provider: scan.provider };
  if ((await document()).navigationId !== navigationId)
    return { origin, navigationId, ...provider, missing: 'changed' };
  return scan.number === undefined
    ? { origin, navigationId, ...provider, missing: 'none-found' }
    : {
        origin,
        navigationId,
        ...provider,
        number: { value: scan.number.value, from: scan.number.from, frameOrigin: origin },
      };
}
