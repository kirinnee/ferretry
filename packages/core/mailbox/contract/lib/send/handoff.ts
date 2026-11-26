import { byRecordedHarness, type HarnessKey as HarnessKind } from '@ferretry/core-ferrets/contract';
import { type QueueAuthor } from '../../wire-send.ts';
import { readHandoffDocument } from '../../turn-handoff.ts';
import { type SessionHandoff, type SessionHandoffAttachment } from '../../protocol-names.ts';

// A contract imports no `node:path`; these are its POSIX forms, for the clean absolute paths a hand-off names.
// They are NOT `node:path`: `join` only drops trailing slashes from the folder and joins with one `/`; it does not
// resolve `.` or `..` or collapse inner `//`, so a caller hands it paths that are already clean (the session store's are).
const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);
const basename = (path: string): string => trimmed(path).slice(trimmed(path).lastIndexOf('/') + 1);
const dirname = (path: string): string => {
  const at = trimmed(path).lastIndexOf('/');
  return at < 0 ? '.' : at === 0 ? '/' : trimmed(path).slice(0, at);
};
const join = (folder: string, name: string): string => `${trimmed(folder)}/${name}`;

/**
 * What the person sent in one hand-off, read back out of the document the agent was pointed at.
 *
 * A transcript records the POINTER ("Read the file …/turn-008.md now, …") as the user's message, so the
 * app asks for this to show the person's own words instead. The document's shapes are the protocol's
 * (`turn-handoff.ts`); this only decides which named files are this session's stored attachments.
 *
 * A delivered copy sits at `<attachment root>/<attachment id>/<file name>`. A listed path anywhere else
 * keeps its name and type but gets no id, so the app shows it as a plain chip and never asks the
 * attachment store for a file that is not this session's.
 */
export function handoffView(
  name: string,
  document: string,
  context: { readonly reminder: string; readonly attachmentRoot: string },
  by?: QueueAuthor,
): SessionHandoff {
  const { message, files } = readHandoffDocument(document, context.reminder);
  const attachments = files.map((file): SessionHandoffAttachment => {
    const folder = dirname(file.path);
    const owned = dirname(folder) === context.attachmentRoot;
    return { ...(owned ? { attachmentId: basename(folder) } : {}), filename: basename(file.path), mime: file.mime };
  });
  return { name, message, attachments, ...(by === undefined ? {} : { by }) };
}

/**
 * Every folder an agent is pointed into to read what it was sent: the session's turn documents, its
 * queued messages, the attachments it was started with, and the copies a send delivers.
 */
export function handoffFolders(sessionDirectory: string, attachmentRoot: string): readonly string[] {
  return [
    join(sessionDirectory, 'turns'),
    join(sessionDirectory, 'channel'),
    join(sessionDirectory, 'attachments'),
    attachmentRoot,
  ];
}

/**
 * What lets an agent open those folders WITHOUT ASKING, and lets it do nothing else there.
 *
 * Every one of them is outside the agent's working folder, so Claude Code asks before reading a turn
 * document or an attached image (in `default` and `acceptEdits`; `auto` hands it to its classifier) —
 * which stops an agent mid-message to ask permission to read the message. A `Read(…)` allow rule
 * answers read checks only: Claude never derives a write from it, unlike `--add-dir`, whose folder
 * `acceptEdits` treats as writable. The `//` prefix is Claude's spelling of an absolute path (a single
 * `/` is relative to the settings file), and the `=` form keeps the variadic flag from swallowing the
 * arguments after it.
 *
 * Codex needs nothing: its sandbox reads anywhere in every mode Ferretry runs it in, and limits only
 * writes.
 */
export function handoffReadArguments(harness: HarnessKind, folders: readonly string[]): readonly string[] {
  return byRecordedHarness(harness, {
    claude: () => folders.map(folder => `--allowedTools=Read(/${folder}/**)`),
    codex: () => [],
  });
}
