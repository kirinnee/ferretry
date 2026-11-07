/**
 * A HARNESS PERMISSION PROMPT, as the approval card reads it. The prompt, its answer route and its words are Claude
 * Code's (`plugins/claude-code`, which draws the same card on its own surfaces); this half takes none of them from that
 * plugin. The shapes here are the fields the card reads, structurally, so the prompt a host hands the card fits, and
 * the words are today's (`permission-requests.ts`) so the card reads the same wherever it is drawn.
 */

import { DaemonResponseError } from './agenda-call.ts';

type PermissionOptionKind = 'allow' | 'allow-always' | 'deny';

/** One choice the harness drew: its digit, its words, and what it does. */
export interface PermissionOption {
  readonly number: number;
  readonly label: string;
  readonly kind: PermissionOptionKind;
}

type PermissionAction = 'run' | 'read' | 'edit' | 'create' | 'fetch' | 'use' | 'exit-plan' | 'other';

/** The prompt on the ferret's pane. */
export interface PermissionRequest {
  readonly id: string;
  readonly harness: string;
  readonly tool: string;
  readonly action: PermissionAction;
  readonly what?: string;
  readonly detail?: string;
  readonly question: string;
  readonly options: readonly PermissionOption[];
  /** The `number` of the option the harness's cursor is on. */
  readonly selected: number;
}

/** A pick by its digit, or the harness's own Esc. */
export type PermissionAnswerRequest =
  | { readonly kind: 'choice'; readonly requestId: string; readonly number: number }
  | { readonly kind: 'deny'; readonly requestId: string };

/** `cleared` is the pane's own word, read after the keys landed. */
export interface PermissionAnswerResult {
  readonly requestId: string;
  readonly cleared: boolean;
}

/** The refusal code for a prompt the pane no longer shows. */
const PERMISSION_PROMPT_GONE = 'permission_prompt_gone';

/**
 * The prompt this answer was for is no longer on the agent's screen — answered at the machine, timed out, or replaced
 * by another. Nothing was typed; the page must re-read the session.
 */
export class PermissionPromptGone extends DaemonResponseError {
  constructor(message: string) {
    super(409, message, PERMISSION_PROMPT_GONE);
    this.name = 'PermissionPromptGone';
  }
}

/** What the action is, when the prompt names no command, path or URL. */
const NOUN: Readonly<Record<'run' | 'read' | 'edit' | 'create' | 'fetch', string>> = {
  run: 'a command',
  read: 'a file',
  edit: 'a file',
  create: 'a file',
  fetch: 'a web page',
};

/** The request as a verb phrase with no subject — `read /etc/hostname`, ``run `curl -s …` ``. */
const permissionPhrase = (request: PermissionRequest, what = request.what): string => {
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

/** The sentence's subject and verb, split where the command or path begins. */
export interface PermissionWords {
  readonly lead: string;
  readonly what?: string;
}

/** The request as a sentence about `agent`. */
export const permissionWords = (agent: string, request: PermissionRequest): PermissionWords => {
  if (request.action === 'other') return { lead: `${agent} needs permission to use ${request.tool}` };
  if (request.action === 'exit-plan' || request.what === undefined)
    return { lead: `${agent} wants to ${permissionPhrase(request)}` };
  return { lead: `${agent} wants to ${request.action}`, what: request.what };
};

/** One answer button: what it does in the app's words, and what the harness said, which is never hidden. */
export interface PermissionOptionWords {
  readonly label: 'Allow once' | 'Always allow' | 'Deny';
  readonly secondary?: string;
  readonly harness: string;
}

const OPTION_LABEL: Readonly<Record<PermissionOptionKind, PermissionOptionWords['label']>> = {
  allow: 'Allow once',
  'allow-always': 'Always allow',
  deny: 'Deny',
};

export const permissionOptionWords = (option: PermissionOption): PermissionOptionWords => ({
  label: OPTION_LABEL[option.kind],
  ...(option.kind === 'allow-always' ? { secondary: option.label } : {}),
  harness: option.label,
});

/** Gate's refusal codes are `grant_<refusal>`; this half does not consume Gate's app copy (Access carries it). */
const GRANT_CODE = /^grants?_[a-z_]+$/u;

/**
 * A grant refusal (a 403, or a 503 when the daemon cannot read its grants) as words, or `null` for any other failure:
 * one plain explanation, then the daemon's own sentence, which already names the command a person runs.
 */
export const grantRefusalNotice = (
  error: unknown,
): { readonly detail: string; readonly guidance: { readonly explanation: string } } | null => {
  if (error === null || typeof error !== 'object') return null;
  const failure = error as { readonly status?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (typeof failure.code !== 'string' || !GRANT_CODE.test(failure.code)) return null;
  if (failure.status !== 403 && failure.status !== 503) return null;
  const detail = typeof failure.message === 'string' ? failure.message : '';
  return { detail, guidance: { explanation: 'This device’s access to this machine does not allow that.' } };
};
