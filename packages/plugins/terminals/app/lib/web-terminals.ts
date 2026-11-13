import { DaemonCallError, FY_REQUEST_ID_HEADER } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type CloseTerminalResponse,
  CloseTerminalResponseSchema,
  type CreateTerminalRequest,
  CreateTerminalRequestSchema,
  RenameTerminalRequestSchema,
  TerminalIdSchema,
  type TerminalListView,
  TerminalListViewSchema,
  type TerminalView,
  TerminalViewSchema,
} from '../../contract/index.ts';
import { assertScopeDaemon, type DaemonConnection, type DaemonSessionScope } from '../shell.ts';
import { type InputQuarantineList, InputQuarantineListSchema } from './protocol/holds.ts';
import {
  SESSION_CONSOLE_INPUT_MAX,
  SessionConsoleInputRequestSchema,
  SessionConsoleInputResultSchema,
} from './protocol/session-processes.ts';

/** What every terminal call needs of the shell's per-daemon client: a route by its manifest key. */
export type TerminalCalls = Pick<PluginClient, 'call'>;

/** The routes the deck calls, by manifest key. The quarantine pair is Vault's (the holds it keeps on a pane). */
export const TERMINAL_ROUTES = {
  holders: 'GET /v1/terminals',
  closeFinished: 'POST /v1/terminals/close-finished',
  list: 'GET /v1/ferrets/:ferretId/terminals',
  create: 'POST /v1/ferrets/:ferretId/terminals',
  rename: 'PATCH /v1/ferrets/:ferretId/terminals/:terminalId',
  close: 'DELETE /v1/ferrets/:ferretId/terminals/:terminalId',
  stream: 'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream',
  consoleInput: 'POST /v1/ferrets/:ferretId/console/input',
  quarantines: 'GET /v1/ferrets/:ferretId/input-quarantines',
  endQuarantine: 'POST /v1/ferrets/:ferretId/input-quarantines/:key/end',
} as const;

/** A mutation carries its own idempotency id, as every mutation here always has. */
const mutation = (): { readonly headers: { readonly 'x-fy-request-id': string } } => ({
  headers: { [FY_REQUEST_ID_HEADER]: crypto.randomUUID() } as { readonly 'x-fy-request-id': string },
});

const mismatch = (message: string): DaemonCallError => new DaemonCallError(502, 'daemon_mismatch', message);

/**
 * Terminal identity is daemon-issued and lands in a URL path, so it is parsed
 * before use rather than trusted from whichever view supplied it.
 */
const terminalParams = (scope: DaemonSessionScope, terminalId: string): Record<string, string> => ({
  ferretId: scope.sessionId,
  terminalId: TerminalIdSchema.parse(terminalId),
});

const parseTerminal = (scope: DaemonSessionScope, body: unknown): TerminalView => {
  const view = TerminalViewSchema.parse(body);
  if (view.sessionId !== scope.sessionId) throw mismatch('daemon returned another session');
  return view;
};

/*
 * Every terminal call is addressed to exactly one paired daemon: the client is already that daemon's, and a scope
 * that names another one is refused before anything is sent. A session ID reused across two daemons must never
 * resolve to whichever daemon happens to be current.
 */

/** Lists the terminals the paired daemon owns for one of its sessions. */
export const listSessionTerminals = async (
  client: TerminalCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
): Promise<TerminalListView> => {
  assertScopeDaemon(daemon, scope);
  const list = TerminalListViewSchema.parse(
    await client.call(TERMINAL_ROUTES.list, { params: { ferretId: scope.sessionId } }),
  );
  if (list.sessionId !== scope.sessionId) throw mismatch('daemon listed another session');
  return list;
};

/** Opens a terminal, letting the daemon choose any size the caller omits. */
export const createSessionTerminal = async (
  client: TerminalCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  request: CreateTerminalRequest = {},
): Promise<TerminalView> => {
  assertScopeDaemon(daemon, scope);
  return parseTerminal(
    scope,
    await client.call(TERMINAL_ROUTES.create, {
      params: { ferretId: scope.sessionId },
      body: CreateTerminalRequestSchema.parse(request),
      ...mutation(),
    }),
  );
};

/** Retitles one terminal on the daemon that owns it. */
export const renameSessionTerminal = async (
  client: TerminalCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  title: string,
): Promise<TerminalView> => {
  assertScopeDaemon(daemon, scope);
  return parseTerminal(
    scope,
    await client.call(TERMINAL_ROUTES.rename, {
      params: terminalParams(scope, terminalId),
      body: RenameTerminalRequestSchema.parse({ title }),
      ...mutation(),
    }),
  );
};

/** Closes one terminal, confirming the daemon closed the one that was asked for. */
export const closeSessionTerminal = async (
  client: TerminalCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
): Promise<CloseTerminalResponse> => {
  assertScopeDaemon(daemon, scope);
  const closed = CloseTerminalResponseSchema.parse(
    await client.call(TERMINAL_ROUTES.close, { params: terminalParams(scope, terminalId), ...mutation() }),
  );
  if (closed.id !== terminalId) throw mismatch('daemon closed another terminal');
  return closed;
};

/** Lists the terminals of a session that were just handed a secret and are hidden from the agent. */
export const listSessionQuarantines = async (
  client: TerminalCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
): Promise<InputQuarantineList> => {
  assertScopeDaemon(daemon, scope);
  return InputQuarantineListSchema.parse(
    await client.call(TERMINAL_ROUTES.quarantines, { params: { ferretId: scope.sessionId } }),
  );
};

/** Ends one quarantine early, by the terminal's key or id; the daemon audits who ended it. */
export const endSessionQuarantine = async (
  client: TerminalCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  key: string,
): Promise<void> => {
  assertScopeDaemon(daemon, scope);
  const body = await client.call<{ ended?: unknown } | null>(TERMINAL_ROUTES.endQuarantine, {
    params: { ferretId: scope.sessionId, key },
    ...mutation(),
  });
  if (body?.ended !== true) throw mismatch('daemon did not end the quarantine');
};

/**
 * Splits input into writes the daemon accepts, never between the two halves of a surrogate pair — a
 * paste of emoji cut there would type two replacement characters into the agent's pane.
 */
export const consoleInputChunks = (data: string, max = SESSION_CONSOLE_INPUT_MAX): readonly string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const character of data) {
    if (current.length + character.length > max) {
      chunks.push(current);
      current = '';
    }
    current += character;
  }
  if (current !== '') chunks.push(current);
  return chunks;
};

/**
 * Types into the session's OWN pane — the Console — on the daemon that owns it.
 *
 * Governed as a terminal is (`terminal.use`): a paired device needs the grant and its unlock, and a
 * refusal comes back as the same grant error a terminal open would raise. A long paste is sent as
 * ordered writes, each one awaited, so the pane receives it in the order it was typed.
 */
export const typeIntoSessionConsole = async (
  client: TerminalCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  data: string,
): Promise<number> => {
  assertScopeDaemon(daemon, scope);
  let written = 0;
  for (const chunk of consoleInputChunks(data)) {
    const body = await client.call(TERMINAL_ROUTES.consoleInput, {
      params: { ferretId: scope.sessionId },
      body: SessionConsoleInputRequestSchema.parse({ data: chunk }),
      ...mutation(),
    });
    written += SessionConsoleInputResultSchema.parse(body).written;
  }
  return written;
};

/* ---------- one terminal stream, whichever carrier reaches the daemon ------- */

/**
 * The live half of a terminal, as the four things a viewer does with one.
 *
 * A PORT RATHER THAN A `WebSocket`, and the reason is not testability. A terminal is a §14 stream
 * SESSION on whichever carrier reaches the daemon — its own address or a rendezvous — so there is no
 * bare socket to hand back. The deck asks for these four operations and nothing above this line knows
 * which carrier carries them.
 */
export interface TerminalStream {
  /** Raw keystrokes and pastes, split at the record budget. */
  write(bytes: Uint8Array): void;
  /** One complete control frame — a resize. Never split, because half a message is corruption. */
  control(text: string): void;
  /** Leave deliberately, carrying the taxonomy a direct close frame would. */
  close(code: number, reason: string): void;
}

/**
 * What a viewer is told about its stream, in the vocabulary BOTH carriers can speak.
 *
 * `closed` CARRIES THE STREAM'S OWN CODE AND NEVER THE SESSION'S. On a relay the meaningful code
 * arrives in the sealed `stream-close` record and a `4440` follows it as expected teardown; handing
 * that `4440` up would be handing the deck a number `shouldReopenTerminalStream` reads as "retry",
 * against a stream the daemon deliberately ended. `refused` is separate for the same class of reason:
 * §14 gives `stream-refused` a status so "it is gone" can be told from "the daemon broke", and a
 * viewer that retried a `403` would ask a permanent refusal the same question forever.
 */
export interface TerminalStreamHandlers {
  onOpen(): void;
  onBytes(bytes: Uint8Array): void;
  onClosed(code: number, reason: string): void;
  onRefused(status: number, body: string): void;
}

/** `reveal` asks the daemon to show THIS viewer a quarantined terminal. It is per connection and audited. */
export interface TerminalAttachOptions {
  readonly reveal?: boolean;
}

/** Marks an attach the daemon refused, so the deck reports it instead of retrying it forever. */
export class TerminalStreamRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`the daemon refused this terminal stream: ${status}`);
    this.name = 'TerminalStreamRefused';
  }
}

/**
 * The original wording is preserved verbatim: "this box" is the daemon serving
 * the list, which is now one of several a reader may have paired.
 */
export const terminalLimitLabel = (list: TerminalListView): string =>
  `${list.terminals.length}/${list.limits.perSession} in this session · ${list.limits.runningGlobal}/${list.limits.global} on this box`;
