import { isPlaceholderSessionName, type SessionConfig } from '@ferretry/protocol';
import { formatSessionTitle } from './policy.ts';

/** The longest a title taken from an owner's message gets before it is cut with an ellipsis. */
export const MESSAGE_TITLE_LENGTH = 40;

/** What an auto-title is taken from. A card's title outranks a message: it names the work, the message only began it. */
export type AutoTitleSource = 'card' | 'message';

type Titled = Pick<SessionConfig, 'name' | 'nameSource'>;

/**
 * Whether the daemon may retitle this session: it titled it itself, or it still wears the placeholder.
 * A session older than `nameSource` with a real name keeps it — someone chose it.
 */
export const isAutoTitled = (config: Titled): boolean =>
  config.nameSource === 'auto' || (config.nameSource === undefined && isPlaceholderSessionName(config.name));

/** A title from an owner's message: its first line, tidied and cut to {@link MESSAGE_TITLE_LENGTH}. `undefined` when it has no words. */
export const titleFromMessage = (message: string): string | undefined => {
  const firstLine = message.split('\n').find(line => line.trim() !== '') ?? '';
  const title = formatSessionTitle(firstLine);
  if (title === '' || title.startsWith('/')) return undefined;
  return title.length <= MESSAGE_TITLE_LENGTH ? title : `${title.slice(0, MESSAGE_TITLE_LENGTH - 1).trimEnd()}…`;
};

/**
 * The name this session should now carry, or `undefined` to leave it alone.
 *
 * An owner-chosen name is never touched, so a rename wins. A card title replaces any auto name; a message
 * only fills the placeholder, so the first message titles a session and a later one does not retitle it.
 */
export const nextAutoTitle = (config: Titled, source: AutoTitleSource, candidate: string): string | undefined => {
  if (!isAutoTitled(config)) return undefined;
  const title = source === 'card' ? formatSessionTitle(candidate) : titleFromMessage(candidate);
  if (title === undefined || title === '' || title === config.name) return undefined;
  if (source === 'message' && !isPlaceholderSessionName(config.name)) return undefined;
  return title;
};

/**
 * A configuration document with the auto-title applied, or the same document when nothing changes.
 * Works on the raw document because storage hands the config over as JSON; `nameSource` is stamped `auto`
 * so a title the daemon wrote stays the daemon's to change, and a rename (`owner`) stays out of its reach.
 */
export const withAutoTitle = (
  document: Readonly<Record<string, unknown>>,
  source: AutoTitleSource,
  candidate: string,
): Readonly<Record<string, unknown>> => {
  const name = typeof document.name === 'string' ? document.name : '';
  const nameSource =
    document.nameSource === 'auto' || document.nameSource === 'owner' ? document.nameSource : undefined;
  const next = nextAutoTitle({ name, nameSource }, source, candidate);
  return next === undefined ? document : { ...document, name: next, nameSource: 'auto' };
};
