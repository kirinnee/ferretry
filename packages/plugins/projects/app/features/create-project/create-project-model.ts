/**
 * THE PURE HALF OF "CREATE A PROJECT": the draft, and the one wire request it becomes.
 *
 * The flow is five steps: Folder, Name, GitHub accounts, Push and signing keys, Done. A folder is picked in the explorer
 * (which also makes new folders), or a repository is cloned into a folder picked there. Every route ends in a request
 * `RegisterProjectRequestSchema` accepts; the schema is the last word, so the clone address is judged by the contract's
 * own rule and not a second opinion written here.
 */
import { cloneFolderName, type RegisterProjectRequest, RegisterProjectRequestSchema } from '../../../contract/index.ts';
import { baseName } from '../../lib/folders.ts';

export const CREATE_STEPS = ['folder', 'name', 'accounts', 'keys', 'done'] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];

const STEP_LABELS: Readonly<Record<CreateStep, string>> = {
  folder: 'Folder',
  name: 'Name',
  accounts: 'GitHub accounts',
  keys: 'Push and signing',
  done: 'Done',
};

export interface CreateDraft {
  /** `folder`: this folder is the project. `clone`: clone `url` INTO this folder, as a new folder named after it. */
  readonly source: 'folder' | 'clone';
  /** The folder chosen in the explorer (absolute); `null` until one is. */
  readonly folder: string | null;
  readonly url: string;
  /** Blank means "the folder's own name", never an empty name. */
  readonly name: string;
}

export const emptyCreateDraft: CreateDraft = Object.freeze({
  source: 'folder' as const,
  folder: null,
  url: '',
  name: '',
});

/** The folder the project will be (the chosen one, or the clone's destination inside it). */
export const projectFolder = (draft: CreateDraft): string | null => {
  if (draft.folder === null) return null;
  if (draft.source === 'folder') return draft.folder;
  const leaf = cloneFolderName(draft.url);
  return leaf === null ? null : `${draft.folder === '/' ? '' : draft.folder}/${leaf}`;
};

/** What the name field says before anything is typed: the folder's own name. */
export const defaultProjectName = (draft: CreateDraft): string => {
  const folder = projectFolder(draft);
  return folder === null ? '' : baseName(folder);
};

export interface CreateVerdict {
  readonly request: RegisterProjectRequest | null;
  /** Why not, in a sentence; `null` for a draft that is merely unfinished. */
  readonly problem: string | null;
}

/** Whether the draft is ready to be sent, and the sentence for why not. One answer drives the button and the line. */
export const createVerdict = (draft: CreateDraft): CreateVerdict => {
  const folder = projectFolder(draft);
  if (draft.source === 'clone' && draft.url.trim() !== '' && folder === null && draft.folder !== null) {
    return { request: null, problem: 'That address does not name a repository to clone.' };
  }
  if (folder === null) return { request: null, problem: null };
  const name = draft.name.trim();
  const parsed = RegisterProjectRequestSchema.safeParse(
    draft.source === 'clone'
      ? { kind: 'clone', url: draft.url.trim(), path: folder, ...(name === '' ? {} : { name }) }
      : { kind: 'existing-folder', path: folder, ...(name === '' ? {} : { name }) },
  );
  return parsed.success
    ? { request: parsed.data, problem: null }
    : { request: null, problem: parsed.error.issues[0]?.message ?? 'That cannot be registered.' };
};

/** The stepper's progress bar: the five steps are the segments, and the page is `n` of 5 (no step is ever skipped). */
export const createProgress = (step: CreateStep, steps: readonly CreateStep[]) => ({
  segments: steps.map(each => ({ id: each, label: STEP_LABELS[each] })),
  current: step,
  step: steps.indexOf(step) + 1,
  of: steps.length,
});
