/**
 * What was edited on this machine since an install wrote it, as the installer sees it (docs/catalogs.md § Keep my
 * edits or replace them). Only things THIS install wrote and recorded a hash for can be "edited": a file with no
 * hash recorded, or anything another install holds, is a conflict and never gets here.
 *
 * `files` are paths inside the skill folder, each with the hash it has NOW. A Replace saves exactly these hashes
 * with the preview; the apply refuses unless every one of them is still what the person reviewed.
 */
import type { CatalogInstallEdited } from '@ferretry/protocol';

export interface EditedHashes {
  readonly files: ReadonlyMap<string, string>;
  /** The stored component's hash now (a runtime install), when it is not the one recorded. */
  readonly component?: string;
  /** The `.mcp.json` entry's hash now (a project server), when it is not the one recorded. */
  readonly entry?: string;
}

export const NO_EDITS: EditedHashes = { files: new Map() };

export const hasEdits = (edited: EditedHashes): boolean =>
  edited.files.size > 0 || edited.component !== undefined || edited.entry !== undefined;

/** Where the edits are, as the wire names them: the recorded path of each file, and which of the others. */
export function editedView(edited: EditedHashes, prefix: string, serverName: string): CatalogInstallEdited {
  return {
    paths: [...edited.files.keys()].toSorted().map(path => `${prefix}${path}`),
    ...(edited.component === undefined ? {} : { component: true }),
    ...(edited.entry === undefined ? {} : { entry: serverName }),
  };
}

/** The same edits as plain words for a refusal or a warning. */
export function editedWords(view: CatalogInstallEdited): string {
  const parts = [
    ...view.paths,
    ...(view.component === true ? ['the stored setup'] : []),
    ...(view.entry === undefined ? [] : [`the server ${view.entry} in .mcp.json`]),
  ];
  return parts.join(', ');
}

/** Whether every edit found now is exactly one the person saw. An edit nobody reviewed, or one that moved, is not. */
export function sameEdits(now: EditedHashes, saved: EditedHashes | undefined): boolean {
  if (!hasEdits(now)) return true;
  if (saved === undefined) return false;
  if (now.component !== saved.component || now.entry !== saved.entry) return false;
  for (const [path, hash] of now.files) if (saved.files.get(path) !== hash) return false;
  return true;
}
