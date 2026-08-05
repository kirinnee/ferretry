/**
 * What a remote caller may name and write inside the fleet's asset tree.
 *
 * Instructions and skills are ordinary text files that apply copies into each account home, so
 * editing them from a browser means giving a paired client a file API — and a file API is exactly
 * the thing that turns one compromised token into arbitrary host writes. Everything here exists to
 * keep that API as small as the feature needs and no larger: relative paths only, beneath one
 * declared directory, regular text files, bounded in every dimension a caller controls.
 *
 * Pure: no filesystem, no clock. The adapter half checks what only the filesystem can answer — that
 * no component is a link, and that the final entry is a regular file.
 */
import { fleetAssetRefProblem } from '@ferretry/protocol';

/** One text file a proposal will write into the asset tree. */
export interface FleetAssetEdit {
  /** Relative to the fleet's asset directory, always with `/` separators. */
  readonly path: string;
  readonly content: string;
}

/** The sentinel revision for an asset a proposal intends to create. */
export const ABSENT_ASSET_REVISION = 'absent';

/** What an edited asset looked like when the change was reviewed. */
export interface FleetAssetRevision {
  readonly path: string;
  /** Digest of the bytes on disk at review time, or the absent sentinel. */
  readonly revision: string;
}

/** A file the asset reader found but will not return the content of, and why. */
export interface FleetAssetListing {
  readonly path: string;
  readonly bytes: number;
  readonly readable: boolean;
  readonly reason?: string;
}

export const MAX_ASSET_FILE_BYTES = 64 * 1024;
export const MAX_ASSET_EDIT_COUNT = 32;
const MAX_ASSET_TOTAL_BYTES = 256 * 1024;

/**
 * A refusal a caller can fix, as opposed to a defect in the daemon.
 *
 * `missing` is carried separately from the message because one caller has to act on it: staleness
 * checking treats "nothing is there" as a state a proposal may legitimately expect, and every other
 * refusal — a link, a binary, an over-limit file — as damage. Collapsing them would let a proposal
 * that expected an absent file overwrite a real one it simply could not read.
 */
export class FleetAssetRefusal extends Error {
  constructor(
    message: string,
    readonly missing = false,
  ) {
    super(message);
    this.name = 'FleetAssetRefusal';
  }
}

const CONTROL_CHARACTER_LIMIT = 0x20;

/** Text a person edits. Tabs and newlines are text; every other control character is not. */
export function isEditableText(content: string): boolean {
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < CONTROL_CHARACTER_LIMIT || code === 0x7f) return false;
  }
  return true;
}

/**
 * Check one relative asset path and return it, which is already its canonical form: the grammar
 * refuses every spelling a normalisation would have rewritten rather than rewriting it.
 *
 * The grammar itself is the shared one, stated once beside the wire contract that also enforces it
 * on the fields of an overlay. Restating it here — an API bound and a schema bound describing the
 * same thing in two places — is how the one a caller actually reaches quietly becomes the laxer of
 * the two. This side keeps the refusal, because a path arrives here from a query parameter as well
 * as from a parsed body, and a refusal naming the offending path is what a person can act on.
 */
export function parseAssetPath(candidate: string): string {
  const problem = fleetAssetRefProblem(candidate);
  if (problem !== undefined) throw new FleetAssetRefusal(`asset path "${candidate}" ${problem}`);
  return candidate;
}

/** Check one edit's content, and return the byte length it will occupy. */
export function measureAssetEdit(edit: FleetAssetEdit): number {
  const bytes = new TextEncoder().encode(edit.content).length;
  if (bytes > MAX_ASSET_FILE_BYTES) {
    throw new FleetAssetRefusal(
      `asset "${edit.path}" is ${bytes} bytes, over the ${MAX_ASSET_FILE_BYTES}-byte limit for a single file`,
    );
  }
  if (!isEditableText(edit.content)) {
    throw new FleetAssetRefusal(`asset "${edit.path}" is not editable text`);
  }
  return bytes;
}

/**
 * Check a whole edit set: every path valid and distinct, and the set within its collective bounds.
 * Bounded as a set as well as per file, because thirty-two files just under the per-file limit is
 * still an amount of memory a paired client should not be able to make a daemon hold.
 *
 * **Distinct means distinct on the host that will hold the files, not in this string comparison.**
 * A macOS default volume — and this tool ships a cask for one — holds one file for `CLAUDE.md` and
 * `claude.md`, so a set carrying both is two records of one file: the staleness check reads that
 * file twice and the second write silently replaces the first, having reported both as applied.
 * They are refused as the duplicate they will be, in the spelling the caller sent.
 */
export function parseAssetEdits(edits: readonly FleetAssetEdit[]): readonly FleetAssetEdit[] {
  if (edits.length > MAX_ASSET_EDIT_COUNT) {
    throw new FleetAssetRefusal(`a proposal may carry at most ${MAX_ASSET_EDIT_COUNT} asset edits`);
  }

  const seen = new Map<string, string>();
  let total = 0;
  const parsed = edits.map(edit => {
    const path = parseAssetPath(edit.path);
    const earlier = seen.get(path.toLowerCase());
    if (earlier === path) throw new FleetAssetRefusal(`asset "${path}" is edited more than once in one proposal`);
    if (earlier !== undefined) {
      throw new FleetAssetRefusal(
        `asset "${path}" differs from "${earlier}" only in case; a case-insensitive filesystem holds one file for both`,
      );
    }
    seen.set(path.toLowerCase(), path);
    total += measureAssetEdit({ ...edit, path });
    return { path, content: edit.content };
  });

  if (total > MAX_ASSET_TOTAL_BYTES) {
    throw new FleetAssetRefusal(
      `asset edits total ${total} bytes, over the ${MAX_ASSET_TOTAL_BYTES}-byte limit for one proposal`,
    );
  }
  return parsed;
}
