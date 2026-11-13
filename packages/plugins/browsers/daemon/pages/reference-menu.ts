import type { KernelPorts } from '@ferretry/kernel/contract';
import {
  type ReferenceCatalogEntry,
  type ReferenceCatalogInput,
  type ReferenceCatalogProvider,
  referenceCatalogLimit,
} from '@ferretry/plugin-conversation/contract';
import { USE } from '../../contract/index.ts';
import type { BrowserPageSummary } from '../../contract/wire/browser.ts';
import { type BrowserSubsystem, BrowserSessionError } from './service.ts';
import { maskedRefusal, refusalOf } from './routes.ts';

/** How a row says who opened the page (the terminal menu's words: ownership is what a reader checks before driving a page). */
const ownershipText = (opener: BrowserPageSummary['openedBy']): string => {
  if (opener === undefined) return 'owner unrecorded';
  if (opener.by === 'agent') return 'opened by an agent';
  if (opener.by === 'human') return 'opened from a paired device';
  return 'opened on the daemon host';
};

/** How a reference addresses a page: its name when it has one, else its id (`%browser:app`). */
const keyOf = (page: BrowserPageSummary): string => page.name ?? page.id;

/** The entry schema's own bounds: a page sets its own title (and an address can be long), so it is cut rather than failing the menu. */
const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

/** The page's own tab copy: its title, else "New tab" or the address's host (today's `remotePageLabel`). */
const labelOf = (page: BrowserPageSummary): string => {
  const title = page.title.trim();
  if (title !== '') return title;
  if (page.url === '' || page.url === 'about:blank') return 'New tab';
  try {
    return new URL(page.url).hostname || page.url;
  } catch {
    return page.url;
  }
};

/**
 * THE `%browser` MENU OF A FERRET'S COMPOSER (reference.catalog, lead decision Q6): the pages this ferret's browser
 * holds, in the order Browsers lists them. The token is the page's name (else its id), the label the page's own tab
 * copy (title, else "New tab" or the host), and the detail says whether it is incognito and WHO OPENED IT; a page
 * with no recorded opener reads "owner unrecorded", never a guess. A query narrows by the key or the label, case ignored.
 *
 * Only open pages are listed (a stopped browser holds none), so no entry is `closed`.
 *
 * DEMAND: `browser` use — exactly what `GET /v1/sessions/:sessionId/browser` declares, so a caller who could not read
 * the page list through that route is refused before `entries` runs. Titles and hosts are read inside ONE
 * `Redaction.read` like that route's (S16). Only keys, labels and an opener CLASS leave (a label is the address only when
 * the page has neither a title nor a host, as today's tab label): never a device id,
 * a session id, a page's text, a token or a digest.
 */
export class BrowsersReferenceMenu implements ReferenceCatalogProvider {
  readonly demand = USE.browser;

  constructor(
    private readonly browser: Pick<BrowserSubsystem, 'status'>,
    private readonly redaction: KernelPorts['redaction'],
  ) {}

  async entries(input: ReferenceCatalogInput): Promise<readonly ReferenceCatalogEntry[]> {
    const status = await this.browser.status(input.ferret).catch(async (error: unknown) => {
      // A ferret this half does not know holds no pages; every other failure is the route's own refusal.
      if (error instanceof BrowserSessionError && error.code === 'not_found') return undefined;
      throw await maskedRefusal(this.redaction, refusalOf(error));
    });
    if (status === undefined) return [];
    const wanted = input.query?.trim().toLowerCase() ?? '';
    return await this.redaction.read(scope =>
      status.pages
        .map(page => ({ key: keyOf(page), label: scope.text(labelOf(page)), page }))
        .filter(({ key, label }) => wanted === '' || `${key} ${label}`.toLowerCase().includes(wanted))
        .slice(0, referenceCatalogLimit('%browser'))
        .map(({ key, label, page }) => ({
          token: clip(key, 512),
          label: clip(label, 256),
          detail: [...(page.incognito === true ? ['incognito'] : []), ownershipText(page.openedBy)].join(' · '),
        })),
    );
  }
}
