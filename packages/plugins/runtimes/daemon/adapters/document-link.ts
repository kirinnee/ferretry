/**
 * A harness document (`settings.json`, `.claude.json`, `config.toml`) of an account home outside the fleet that is a LINK
 * the home-scoped handle did not follow (it leads outside the home, nowhere, round to a folder above, or to a sign-in
 * file). The three documents, and only they, are followed here, as the MCP document reader of today did
 * (`harness-documents.ts`: `open` by path), so a home-manager home keeps its MCP servers and approvals.
 *
 * WHAT MAKES THE FOLLOW SAFE, each a sentence and each tested:
 *
 *  - the target is judged by its REAL path: a sign-in file's name (any case) is refused, and a target in the daemon's home
 *    or any private place is refused by the kernel's fence (this root is an owner's root, so the fence applies);
 *  - the target must be a REGULAR FILE (never a folder, a pipe, a socket or a device) with a single name, and no larger than
 *    the caller's bound or the 16 MiB cap below, whichever is smaller;
 *  - the bytes are read through the kernel's held descriptor on a root scoped to the target's own folder, and kept only when
 *    the real path's name still reaches the very file that was opened (a swap of the TARGET itself after the judge is
 *    discarded; a swap of a FOLDER ABOVE it is the residual below);
 *  - the text must PARSE as what the file is (a JSON object, or TOML), so a link named `settings.json` to some other kind of
 *    file (a private key, a log) is refused and its text is never handed on;
 *  - a refusal names the LINK NAME only: never the target's path, never a byte of the target, never the parser's complaint;
 *  - a link to nothing answers ABSENT, as a document that is not there does.
 *
 * Declared residual: a link to a valid JSON or TOML file anywhere the owner's own user can read (outside the daemon's
 * private places) is read and returned as that document, as the reader of today did; the caller reads it as settings.
 * Inside that window a folder ABOVE the target swapped for a link to another folder after the judge can make the read
 * return a same-named file there: a regular file of one name that parses, outside the daemon's private places, never a
 * sign-in file's name. A link to a name that does not exist inside the daemon's home answers absent like any link to
 * nothing, so whoever owns the link can tell whether that name exists there (never a byte of it; the reader of today
 * answered the same).
 */
import { basename, dirname } from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import { parse as parseToml } from 'smol-toml';
import { isSignInName } from '../lib/account/credentials.ts';

/** The most of a followed document that is read (the reader of today bounded it at 16 MiB). */
const DOCUMENT_CAP = 16 * 1024 * 1024;

/** What following a document link came to: the text, an absent document, a file over the bound, or a content-free refusal. */
export type LinkedDocument =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'too_big'; readonly bound: number }
  | { readonly kind: 'refused' };

const refused: LinkedDocument = { kind: 'refused' };

/** Whether `text` is what `file` is: a JSON object (`*.json`), or TOML (`config.toml`). The parser's complaint is dropped. */
function parses(file: string, text: string): boolean {
  try {
    if (file.endsWith('.toml')) {
      parseToml(text);
      return true;
    }
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** The document `file` of the home `home` (an absolute path), which is a link the home-scoped handle did not follow. */
export async function readLinkedDocument(
  roots: Pick<RootsPort, 'root'>,
  home: string,
  file: string,
  limitBytes: number,
): Promise<LinkedDocument> {
  // Only to name the link's real path: nothing is read through this root.
  const wide = roots.root('harness-home', { subfolder: '/' });
  const link = wide.resolve(`${home}/${file}`);
  if (!link.ok) return refused;
  let target: string;
  try {
    target = await wide.realPath(link.value);
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT' ? { kind: 'absent' } : refused;
  }
  if (isSignInName(basename(target))) return refused;
  try {
    // The folder the target is in is the whole of what the read can reach: a swap to a link that leaves it is refused.
    const reach = roots.root('harness-home', { subfolder: dirname(target) });
    const placed = reach.resolve(target);
    if (!placed.ok) return refused;
    const found = await reach.lstat(placed.value);
    if (found?.kind !== 'file' || found.links > 1) return refused;
    const bound = Math.min(limitBytes, DOCUMENT_CAP);
    if (found.size > bound) return { kind: 'too_big', bound };
    const bytes = await reach.readDurable(placed.value, bound, async held =>
      (await held.stillNames()) ? held.bytes : undefined,
    );
    if (bytes === undefined) return refused;
    const text = new TextDecoder().decode(bytes);
    return parses(file, text) ? { kind: 'text', text } : refused;
  } catch {
    return refused;
  }
}
