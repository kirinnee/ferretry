import type {
  BrowserActionResult,
  BrowserLoginStatus,
  BrowserProxyTestResult,
  BrowserStatus,
  SurfaceControlView,
} from '../../contract/index.ts';
import type { ToolAnswer } from './client.ts';

/**
 * Every browser verb's words on screen, as pure functions of what the daemon answered (v4's `renderToolResult`,
 * `renderControlView`, `renderBrowserStatus`, `renderBrowserAction`, `renderLoginStatus`, `renderProxyTest`).
 */

/** A tool's answer as lines: its sentence, then the pages it lists (the sentence already carries what it read). */
export function renderToolAnswer(answer: ToolAnswer): string {
  const lines = [answer.text];
  for (const surface of answer.surfaces)
    lines.push(
      `  ${surface.name ?? surface.id}  ${surface.title ?? ''}${surface.url === undefined ? '' : `  ${surface.url}`}${surface.openerId === undefined ? '' : `  (popup of ${surface.openerId})`}${surface.available === false ? '  [not yours]' : ''}`.trimEnd(),
    );
  return lines.join('\n');
}

const reference = (id: string, name: string | undefined): string => `%browser:${name ?? id}`;
const by = (who: { readonly by: string; readonly deviceId?: string }): string =>
  who.by === 'human' ? `device ${who.deviceId ?? 'unknown'}` : 'this computer';

/** Who is driving which page, and what a person holds. Terminals are the Terminals verbs' to show. */
export function renderControlView(view: SurfaceControlView): string {
  const lines: string[] = [];
  for (const driving of view.driving.filter(entry => entry.surface === 'browser'))
    lines.push(
      `${reference(driving.id, driving.name)}  driven by ${driving.agentName ?? driving.agentSessionId} until ${driving.until}`,
    );
  for (const takeover of view.takeovers.filter(entry => entry.surface === 'browser'))
    lines.push(`${reference(takeover.id, takeover.name)}  taken over by ${by(takeover.by)} since ${takeover.since}`);
  for (const handed of view.handed.filter(entry => entry.surface === 'browser'))
    lines.push(`${reference(handed.id, handed.name)}  handed to the ferret by ${by(handed.by)}`);
  return lines.length === 0
    ? `no ferret is driving a browser page in ${view.sessionId}, and none is taken over`
    : lines.join('\n');
}

function renderBrowserStatus(status: BrowserStatus): string {
  const size = `${String(status.viewport.width)}x${String(status.viewport.height)}`;
  const lines = [
    `${status.sessionId}  browser ${status.state}  ${size}  viewers ${String(status.viewers)}/${String(status.capacity.maximum)}`,
    `profile persistent · idle timeout ${String(status.idleTimeoutSeconds)}s${status.idleDeadline === undefined ? '' : ` · idle deadline ${status.idleDeadline}`}`,
  ];
  if (status.lastActor !== undefined)
    lines.push(`last ${status.lastActor.kind}: ${status.lastActor.action} at ${status.lastActor.at}`);
  if (status.agentPage !== undefined)
    lines.push(`agent page ${status.agentPage.pageId}: ${status.agentPage.action} at ${status.agentPage.at}`);
  const active = 'activePageId' in status ? status.activePageId : undefined;
  for (const page of status.pages)
    lines.push(
      `${page.id === active ? '*' : ' '} ${page.id}  ${page.title === '' ? '(untitled)' : page.title}  ${page.url}`,
    );
  if ('pageState' in status)
    lines.push(
      `page ${status.pageState} · back ${status.canGoBack ? 'yes' : 'no'} · forward ${status.canGoForward ? 'yes' : 'no'}`,
    );
  if ('pageError' in status && status.pageError !== undefined) lines.push(`page error: ${status.pageError}`);
  if ('error' in status) lines.push(`error: ${status.error}`);
  return lines.join('\n');
}

/**
 * What a per-ferret action reports. A `read` prints only the text it fetched; anything that moved the page prints the
 * page it landed on; everything else prints the whole status.
 */
export function renderBrowserAction(result: BrowserActionResult, textOnly: boolean): string {
  if (!('result' in result)) return renderBrowserStatus(result.status);
  if (textOnly) return 'text' in result.result ? result.result.text : '';
  return `${result.result.title === '' ? '' : `${result.result.title}\n`}${result.result.url}`;
}

/** The base64 payload of an explicit screenshot. */
export function screenshotPayload(result: BrowserActionResult): string {
  if ('result' in result && 'screenshotBase64' in result.result) return result.result.screenshotBase64;
  throw new Error('the daemon returned no screenshot bytes');
}

export function renderLoginStatus(status: BrowserLoginStatus): string {
  const lines = [`browser login window: ${status.state}`];
  if (status.state === 'open' || status.state === 'closing') {
    lines.push(`opened ${status.openedAt}`, `closes ${status.expiresAt}`);
  }
  lines.push(`profile primed: ${status.profilePrimed ? 'yes' : 'no'}`);
  if (status.state === 'open') {
    // The daemon substitutes the real port and a one-shot password; nobody assembles this by hand.
    lines.push(`tunnel: ${status.connection.sshTunnel}`);
    lines.push(`then point a VNC viewer at ${status.connection.host}:${String(status.connection.port)}`);
    lines.push(`password: ${status.connection.password}`);
  }
  if (status.state === 'error' && status.error !== undefined) lines.push(`error: ${status.error}`);
  return lines.join('\n');
}

/**
 * One line for a proxy test. It carries what the daemon's result carries and nothing more: no proxy address, header or
 * credential ever reaches this function.
 */
export function renderProxyTest(result: BrowserProxyTestResult): string {
  const which = result.tested === 'saved' ? 'saved proxy' : 'unsaved proxy';
  if (result.reachable)
    return `Proxy reachable via ${which} in ${String(result.roundTripMs)} ms; egress IP ${result.egressIp}. ${result.message}`;
  const took = result.roundTripMs === undefined ? '' : ` after ${String(result.roundTripMs)} ms`;
  return `Proxy test failed (${result.errorClass}): ${result.message} [${which}${took}]`;
}
