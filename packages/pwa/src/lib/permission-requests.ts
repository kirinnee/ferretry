/**
 * A HARNESS PERMISSION PROMPT, in the browser: the one call that answers it, and the plain words every
 * surface uses for it.
 *
 * The daemon reads the prompt off the agent's own pane (`SessionState.permissionRequest`) and answers it
 * only while the pane still shows that very request. Everything a person is shown about it — the
 * approval card, the session list, the top bar and the notification — is built from the helpers below,
 * so the four surfaces cannot describe one request four ways.
 */

import {
  FY_REQUEST_ID_HEADER,
  type PermissionAnswerRequest,
  PermissionAnswerRequestSchema,
  type PermissionAnswerResult,
  PermissionAnswerResultSchema,
  type PermissionOption,
  type PermissionRequest,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** The refusal code for a prompt the pane no longer shows. */
export const PERMISSION_PROMPT_GONE = 'permission_prompt_gone';

/**
 * The prompt this answer was for is no longer on the agent's screen — answered at the machine, timed
 * out, or replaced by another. Nothing was typed; the page must re-read the session.
 */
export class PermissionPromptGone extends DaemonResponseError {
  constructor(message: string) {
    super(409, message, PERMISSION_PROMPT_GONE);
    this.name = 'PermissionPromptGone';
  }
}

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
  if (response.status === 409 && body.code === PERMISSION_PROMPT_GONE) return new PermissionPromptGone(message);
  return new DaemonResponseError(response.status, message, typeof body.code === 'string' ? body.code : undefined);
};

/**
 * Answers the permission prompt on the session's pane, on the daemon that owns it.
 *
 * Governed as the Console is (`terminal.use`), so a refusal comes back as the same grant error a
 * Console write raises. `cleared: false` means the keys landed and the same prompt is still up: the
 * caller says so and never sends them again by itself.
 */
export const answerPermissionRequest = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  answer: PermissionAnswerRequest,
  fetcher: DaemonFetch = browserFetch,
): Promise<PermissionAnswerResult> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('permission scope must belong to the requested daemon');
  const request = daemonRequest(daemon, `/v1/sessions/${encodeURIComponent(scope.sessionId)}/permission`, {
    method: 'POST',
    body: JSON.stringify(PermissionAnswerRequestSchema.parse(answer)),
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  const result = PermissionAnswerResultSchema.parse(await response.json());
  if (result.requestId !== answer.requestId) throw new DaemonResponseError(502, 'daemon answered another prompt');
  return result;
};

/* ---------- plain words ---------------------------------------------------- */

/** How long a `what` may be in a notification or a status line before it is shortened. */
export const PERMISSION_WHAT_SHORT = 48;

const isPathAction = (request: PermissionRequest): boolean =>
  request.action === 'read' || request.action === 'edit' || request.action === 'create';

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * A path a glance can read: the head it starts from and the file it names, the middle elided —
 * `~/…/turn-008.md`. A path short enough to show whole is shown whole.
 */
export const shortPath = (path: string, max = PERMISSION_WHAT_SHORT): string => {
  if (path.length <= max) return path;
  const segments = path.split('/');
  const base = segments.at(-1) ?? '';
  const head = segments[0] === '' ? `/${segments[1] ?? ''}` : (segments[0] ?? '');
  if (segments.length < 4 || base === '') return truncate(path, max);
  return truncate(`${head}/…/${base}`, max);
};

/** The command, path or URL, short enough for a notification: one line, the middle of a path elided. */
export const shortPermissionWhat = (request: PermissionRequest, max = PERMISSION_WHAT_SHORT): string | undefined => {
  if (request.what === undefined) return undefined;
  const line = request.what.replace(/\s+/gu, ' ').trim();
  return isPathAction(request) ? shortPath(line, max) : truncate(line, max);
};

/** What the action is, when the prompt names no command, path or URL. */
const NOUN: Readonly<Record<'run' | 'read' | 'edit' | 'create' | 'fetch', string>> = {
  run: 'a command',
  read: 'a file',
  edit: 'a file',
  create: 'a file',
  fetch: 'a web page',
};

/**
 * The request as a verb phrase with no subject — `read /etc/hostname`, ``run `curl -s …` ``, `exit plan
 * mode and start`. `what` is the form to show: the whole one, or {@link shortPermissionWhat}'s.
 */
export const permissionPhrase = (request: PermissionRequest, what = request.what): string => {
  switch (request.action) {
    case 'run':
      return what === undefined ? `run ${NOUN.run}` : `run \`${what}\``;
    case 'read':
    case 'edit':
    case 'create':
    case 'fetch':
      return `${request.action} ${what ?? NOUN[request.action]}`;
    case 'use':
      return `use ${what ?? request.tool}`;
    case 'exit-plan':
      return 'exit plan mode and start';
    case 'other':
      return `use ${request.tool}`;
  }
};

/**
 * The sentence's subject and verb, so a surface can draw the command or path after it in its own face:
 * `Hadi wants to read` + `/etc/hostname`. `what` is absent when the phrase already says everything.
 */
export interface PermissionWords {
  readonly lead: string;
  readonly what?: string;
}

/** The request as a sentence about `agent`, split where the command or path begins. */
export const permissionWords = (agent: string, request: PermissionRequest): PermissionWords => {
  if (request.action === 'other') return { lead: `${agent} needs permission to use ${request.tool}` };
  if (request.action === 'exit-plan' || request.what === undefined)
    return { lead: `${agent} wants to ${permissionPhrase(request)}` };
  return { lead: `${agent} wants to ${request.action}`, what: request.what };
};

/** The whole sentence as text: "Hadi wants to read /etc/hostname", "… needs permission to use Foo". */
export const permissionSentence = (agent: string, request: PermissionRequest, what = request.what): string =>
  request.action === 'other'
    ? `${agent} needs permission to use ${request.tool}`
    : `${agent} wants to ${permissionPhrase(request, what)}`;

/** One answer button: what it does in the app's words, and what the harness said, which is never hidden. */
export interface PermissionOptionWords {
  readonly label: 'Allow once' | 'Always allow' | 'Deny';
  /** The harness's own words for an always-allow, because they say WHAT will be allowed from now on. */
  readonly secondary?: string;
  /** The harness's exact label, for `title` and the accessible name. */
  readonly harness: string;
}

const OPTION_LABEL: Readonly<Record<PermissionOption['kind'], PermissionOptionWords['label']>> = {
  allow: 'Allow once',
  'allow-always': 'Always allow',
  deny: 'Deny',
};

export const permissionOptionWords = (option: PermissionOption): PermissionOptionWords => ({
  label: OPTION_LABEL[option.kind],
  ...(option.kind === 'allow-always' ? { secondary: option.label } : {}),
  harness: option.label,
});
