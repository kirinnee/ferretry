import type { BrowserActionResult, BrowserStatus } from '../../contract/wire/browser.ts';

/**
 * What a FERRET may be shown of its session's browser: its own pages, and nothing of a person's. A session's browser also
 * holds the pages its person opened; their ids, titles and addresses are the person's, exactly as `browser.list` keeps
 * them from an agent's listing. Pure: `owned` is the set of page ids the ferret owns, decided elsewhere by the one rule.
 */

/**
 * The session status limited to the ferret's own pages. When the page in view is a person's, the ferret is shown its own
 * latest page in its place (its address and title as the page list holds them), never the person's; a ferret with no page
 * of its own is shown none.
 */
export function ferretStatus(status: BrowserStatus, owned: ReadonlySet<string>): BrowserStatus {
  if (status.state !== 'running' || !('activePageId' in status)) {
    return { ...status, pages: status.pages.filter(page => owned.has(page.id)) } as BrowserStatus;
  }
  const mine = status.pages.filter(page => owned.has(page.id));
  if (owned.has(status.activePageId)) return { ...status, pages: mine } as BrowserStatus;
  const {
    url: _url,
    title: _title,
    activePageId: _active,
    pageState: _state,
    pageError: _error,
    canGoBack: _back,
    canGoForward: _forward,
    pages: _pages,
    ...session
  } = status;
  const latest = mine.at(-1);
  if (latest === undefined) return { ...session, state: 'running', pages: [] } as BrowserStatus;
  return {
    ...session,
    state: 'running',
    url: latest.url,
    title: latest.title,
    activePageId: latest.id,
    pageState: 'ready',
    canGoBack: false,
    canGoForward: false,
    pages: mine,
  } as BrowserStatus;
}

/** An act's answer with its status and its page list limited the same way; the acted page's own words are the ferret's. */
export function ferretAnswer(answer: BrowserActionResult, owned: ReadonlySet<string>): BrowserActionResult {
  const status = ferretStatus(answer.status, owned);
  if (!('result' in answer)) return { status } as BrowserActionResult;
  return {
    ...answer,
    status,
    result: { ...answer.result, pages: answer.result.pages.filter(page => owned.has(page.id)) },
  } as BrowserActionResult;
}
