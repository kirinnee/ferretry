/**
 * A CLAUDE CODE PERMISSION PROMPT, in the browser: the one call that answers it, and the plain words every
 * surface uses for it.
 *
 * The daemon reads the prompt off the ferret's own pane and answers it only while the pane still shows that very
 * request. Everything a person is shown about it is built from the helpers below, so the surfaces cannot describe
 * one request several ways.
 */

import {
  type PermissionAnswerRequest,
  PermissionAnswerRequestSchema,
  type PermissionAnswerResult,
  PermissionAnswerResultSchema,
  type PermissionOption,
  type PermissionRequest,
} from '../../contract/index.ts';
import { AnswerRefusal, type ClaudeCodeClient, refusedWith } from './client.ts';

/** The refusal code for a prompt the pane no longer shows. */
export const PERMISSION_PROMPT_GONE = 'permission_prompt_gone';

/**
 * The prompt this answer was for is no longer on the ferret's screen: answered at the machine, timed out, or
 * replaced by another. Nothing was typed; the page must re-read the ferret.
 */
export class PermissionPromptGone extends AnswerRefusal {
  constructor(message: string) {
    super(409, message, PERMISSION_PROMPT_GONE);
    this.name = 'PermissionPromptGone';
  }
}

/**
 * Answers the permission prompt on the ferret's pane. Governed as the Console is (`terminal.use`), so a refusal
 * comes back as the same grant error a Console write raises. `cleared: false` means the keys landed and the same
 * prompt is still up: the caller says so and never sends them again by itself.
 */
export const answerPermissionRequest = async (
  client: ClaudeCodeClient,
  ferret: string,
  answer: PermissionAnswerRequest,
): Promise<PermissionAnswerResult> => {
  let raw: unknown;
  try {
    raw = await client.call('POST /v1/ferrets/:ferretId/permission', {
      params: { ferretId: ferret },
      body: PermissionAnswerRequestSchema.parse(answer),
    });
  } catch (error) {
    if (refusedWith(error, 409, PERMISSION_PROMPT_GONE)) throw new PermissionPromptGone(error.message);
    throw error;
  }
  const result = PermissionAnswerResultSchema.parse(raw);
  if (result.requestId !== answer.requestId) throw new AnswerRefusal(502, 'daemon answered another prompt');
  return result;
};

/* ---------- plain words ---------------------------------------------------- */

/** How long a `what` may be in a notification or a status line before it is shortened. */
const PERMISSION_WHAT_SHORT = 48;

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
