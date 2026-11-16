/**
 * The two files of a ferret's own session folder the pane is handed by name: where Claude Code's question hook records
 * the question it asks, and the folder the agent puts media it made to show the person in. Moved here from the session
 * files module and the service, which no longer know either (U6c); the store reads and the file browser's media scope
 * stay where they are, over the same names below.
 */
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { FerretId } from '../../../../contract/index.ts';
import type { SessionStore } from '../launch-steps.ts';

/** Where Claude Code's question hook records the question it asks (today's `QUESTION_ASKED_FILE_ENV`). */
export const QUESTION_FILE_VARIABLE = 'FY_QUESTION_FILE';
/** Where the agent puts media it made to show the person (today's `SESSION_MEDIA_VARIABLE`, docs/hypermedia.md). */
export const MEDIA_FOLDER_VARIABLE = 'FY_MEDIA_DIR';

/** The file Claude Code's question hook writes in a ferret's session folder (today's `SessionPaths.questionAsked`). */
export const QUESTION_ASKED_FILE = 'question-asked.json';
/** The folder of a ferret's own session folder its agent puts media in (`FY_MEDIA_DIR`; today's `SessionPaths.media`). */
export const MEDIA_FOLDER = 'media';

/** What the two stores need of the session files: a ferret's folder, and making it and its media folder private. */
export interface PaneFileFolders {
  /** The ferret's own `sessions` handle (one minted folder, internal, private). */
  readonly root: (ferret: FerretId) => Pick<RootHandle, 'resolve'>;
  /** Makes the ferret's session folder and its `media/` folder, `0700`; idempotent. Rejects when it cannot. */
  readonly ensureMediaFolder: (ferret: FerretId) => Promise<void>;
}

/**
 * The question file (U4) then the media folder (F-0327), in the order the launch has always set them. A name that cannot
 * be resolved throws (the launch sets nothing and goes on), like a folder that cannot be made.
 */
export function paneFileStores(folders: PaneFileFolders): readonly SessionStore[] {
  const named = (ferret: FerretId, name: string, what: string): FencedPath => {
    const resolved = folders.root(ferret).resolve(name);
    if (!resolved.ok) throw new Error(`the ${what} of this ferret could not be named`);
    return resolved.value;
  };
  return [
    {
      // Claude Code's question hook records the question it asks here, inside the ferret's own folder on the sessions
      // root, never in its work tree. Its folder exists (`prepare` ran first).
      id: 'question-file',
      variable: QUESTION_FILE_VARIABLE,
      locate: async ferret => named(ferret, QUESTION_ASKED_FILE, 'question file'),
    },
    {
      // The agent's "show this" folder: `media/` in the ferret's own session folder, made `0700`.
      id: 'media-folder',
      variable: MEDIA_FOLDER_VARIABLE,
      locate: async ferret => {
        const path = named(ferret, MEDIA_FOLDER, 'media folder');
        await folders.ensureMediaFolder(ferret);
        return path;
      },
    },
  ];
}
