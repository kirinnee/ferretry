import type { BrowserActionResult, BrowserStatus } from '@ferretry/protocol';

/** The page-level fields only the running-with-a-page member of `BrowserStatus` carries. */
interface PageDetail {
  readonly activePageId?: string;
  readonly pageState?: string;
  readonly pageError?: string;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
}

const pageDetail = (status: BrowserStatus): PageDetail => ('activePageId' in status ? status : {});

export function renderBrowserStatus(status: BrowserStatus): string {
  const capacity = `viewers ${status.viewers}/${status.capacity.maximum}`;
  const size = `${status.viewport.width}x${status.viewport.height}`;
  const lines = [
    `${status.sessionId}  browser ${status.state}  ${size}  ${capacity}`,
    `profile persistent · idle timeout ${status.idleTimeoutSeconds}s${status.idleDeadline ? ` · idle deadline ${status.idleDeadline}` : ''}`,
  ];
  if (status.lastActor) {
    lines.push(`last ${status.lastActor.kind}: ${status.lastActor.action} at ${status.lastActor.at}`);
  }
  if (status.agentPage) {
    lines.push(`agent page ${status.agentPage.pageId}: ${status.agentPage.action} at ${status.agentPage.at}`);
  }

  const detail = pageDetail(status);
  for (const page of status.pages) {
    const marker = page.id === detail.activePageId ? '*' : ' ';
    lines.push(`${marker} ${page.id}  ${page.title || '(untitled)'}  ${page.url}`);
  }
  if (detail.pageState) {
    const back = detail.canGoBack ? 'yes' : 'no';
    const forward = detail.canGoForward ? 'yes' : 'no';
    lines.push(`page ${detail.pageState} · back ${back} · forward ${forward}`);
  }
  if (detail.pageError) lines.push(`page error: ${detail.pageError}`);
  if ('error' in status) lines.push(`error: ${status.error}`);
  return lines.join('\n');
}

/**
 * What an action reports back. A `read` prints only the text it fetched; anything that moved the
 * page prints the page it landed on; everything else prints the whole status.
 */
export function renderBrowserAction(result: BrowserActionResult, textOnly: boolean): string {
  if (!('result' in result)) return renderBrowserStatus(result.status);
  if (textOnly) return 'text' in result.result ? result.result.text : '';
  return `${result.result.title ? `${result.result.title}\n` : ''}${result.result.url}`;
}

/** The base64 payload of an explicit screenshot; the caller chooses and writes the output path. */
export function screenshotPayload(result: BrowserActionResult): string {
  if ('result' in result && 'screenshotBase64' in result.result) return result.result.screenshotBase64;
  throw new Error('the daemon returned no screenshot bytes');
}
