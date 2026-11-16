/**
 * FERRETRY'S OWN CHANNEL, AS CLAUDE CODE RECORDS IT.
 *
 * A message pushed through Ferretry's MCP channel is written by Claude Code inside a tag naming the server that sent it:
 * `<channel source="ferretry" send_id="…">\nTEXT\n</channel>`. TEXT is exactly what would have been typed (the sender's banner
 * line included), so once the wrapper is taken off the existing banner parse attributes it like any typed peer message.
 *
 * ONLY OUR SERVER'S WRAPPER COMES OFF. A channel from any other MCP server keeps its wrapper and stays what Claude says it is
 * (a message from outside, shown as the harness's own). The record's `origin` must also say `channel` and name this server
 * wherever a record carries one, so a person typing the tag into a prompt does not pass for the daemon.
 */

/** The MCP server name Ferretry registers its tools (and its channel) under: `FERRETRY_MCP_SERVER` in the runtimes' fixed layer. */
export const FERRETRY_CHANNEL_SERVER = 'ferretry';

/** `<channel` + attributes (quoted values only; a value may hold `>`) + `>`, the text, `</channel>`. */
const CHANNEL_WRAPPER = /^\s*<channel((?:\s+[^\s=>]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/channel>\s*$/u;
const ATTRIBUTE = /([^\s=>]+)="([^"]*)"/gu;

/** The first attribute called `name`, read attribute by attribute (a value that merely looks like one is not one). */
function firstAttribute(attributes: string, name: string): string | undefined {
  for (const found of attributes.matchAll(ATTRIBUTE)) if (found[1] === name) return found[2] ?? '';
  return undefined;
}

/** What a Ferretry channel wrapper held: the words inside it, and the send they belong to when the tag names one. */
export interface FerretryChannelMessage {
  readonly text: string;
  readonly sendId?: string;
}

/**
 * The words inside a Ferretry channel wrapper and its `send_id` attribute, or `undefined` when `text` is not one (no
 * wrapper, or another server's). The FIRST `source` attribute names the server: Claude writes its own before the meta's,
 * so a meta key called `source` (which it would duplicate) cannot steal the name.
 */
export function parseFerretryChannel(text: string): FerretryChannelMessage | undefined {
  const found = CHANNEL_WRAPPER.exec(text);
  if (found === null) return undefined;
  const attributes = found[1] ?? '';
  if (firstAttribute(attributes, 'source') !== FERRETRY_CHANNEL_SERVER) return undefined;
  const sendId = firstAttribute(attributes, 'send_id');
  return { text: found[2] ?? '', ...(sendId === undefined || sendId === '' ? {} : { sendId }) };
}

/** The text inside a Ferretry channel wrapper, or `undefined` when `text` is not one. */
export function unwrapFerretryChannel(text: string): string | undefined {
  return parseFerretryChannel(text)?.text;
}

/** Whether a record's `origin` says it came through Ferretry's channel: `{ kind: 'channel', server: 'ferretry' }`. */
export function isFerretryChannelOrigin(origin: unknown): boolean {
  if (typeof origin !== 'object' || origin === null) return false;
  const { kind, server } = origin as { readonly kind?: unknown; readonly server?: unknown };
  return kind === 'channel' && server === FERRETRY_CHANNEL_SERVER;
}
