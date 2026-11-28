import { byRecordedHarness, type HarnessKey as HarnessKind } from '@ferretry/core-ferrets/contract';
import { type QueueAuthor } from '../../wire-send.ts';
import { readHandoffDocument } from '../../turn-handoff.ts';
import { type SessionHandoff, type SessionHandoffAttachment } from '../../protocol-names.ts';

// A contract imports no `node:path`; these are its POSIX forms, for the clean absolute paths a hand-off names.
// They are NOT `node:path`: `join` only drops trailing slashes from the folder and joins with one `/`; it does not
// resolve `.` or `..` or collapse inner `//`, so a caller hands it paths that are already clean (the session store's are).
const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);
const basename = (path: string): string => trimmed(path).slice(trimmed(path).lastIndexOf('/') + 1);
const join = (folder: string, name: string): string => `${trimmed(folder)}/${name}`;

/** Daemon delivery metadata, with the copy's path proved through the attachment scope before this projection. */
export interface TrustedHandoffAttachment {
  readonly path: string;
  readonly attachmentId: string;
  readonly filename: string;
  readonly mime: string;
}

/**
 * What the person sent in one hand-off, read back out of the document the agent was pointed at.
 *
 * A transcript records the POINTER ("Read the file …/turn-008.md now, …") as the user's message, so the
 * app asks for this to show the person's own words instead. The document's shapes are the protocol's
 * (`turn-handoff.ts`). Only daemon-recorded, scope-proved delivery metadata can supply an id; message
 * text can name a plain chip but never creates a fetchable attachment.
 */
export function handoffView(
  name: string,
  document: string,
  context: { readonly reminder: string; readonly attachments: readonly TrustedHandoffAttachment[] },
  by?: QueueAuthor,
): SessionHandoff {
  const { message, files } = readHandoffDocument(document, context.reminder);
  const attachments = files.map((file): SessionHandoffAttachment => {
    const delivered = context.attachments.find(attachment => attachment.path === file.path);
    return delivered === undefined
      ? { filename: basename(file.path), mime: file.mime }
      : { attachmentId: delivered.attachmentId, filename: delivered.filename, mime: delivered.mime };
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
