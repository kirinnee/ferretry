import { FsError, type HeldRoot, type PinOptions, type RootHandle } from '@ferretry/kernel/contract';
import type { PinnedRoot, SessionRootPinner } from '../../../lib/session/filesystem/ports.ts';

/**
 * The session root pinner, over the kernel's checked root operations (S47; today's `PosixSessionRootPinner` and
 * `ProcfsSessionRootPinner`, which the kernel now owns).
 *
 * A ferret's session root is its `work` root itself. The name is judged first, by the root's own lexical check
 * (`resolve`: the folder the registry holds for THAT ferret, outside the daemon's fence), and the
 * folder is then held OPEN by `RootHandle.pin`, which checks the object actually held once more. Nothing here opens a
 * path by its string: the walk that proves containment is the walk that serves the bytes, and a pin this root did not
 * mint is not one the kernel will spawn in.
 *
 * Every refusal the root raises is said in the viewer's own vocabulary ({@link FsError}). A refusal this adapter does
 * not know is raised as it is, never as a softer one: an unreadable root must close the surface, not open it.
 */

/** What of a root this pinner needs: the lexical check and the pin. */
export type PinnableRoot = Pick<RootHandle, 'resolve' | 'pin'>;

/** The kernel's refusal, read structurally: this plugin may not import the kernel's host. */
function refusalOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'RootError') return undefined;
  const refusal = (error as { readonly refusal?: unknown }).refusal;
  return typeof refusal === 'string' ? refusal : undefined;
}

const MISSING = new Set(['ENOENT', 'ELOOP']);

/** The viewer's refusal for one of the root's refusal words. */
function refusalError(refusal: string, cwd: string): FsError {
  switch (refusal) {
    case 'fenced':
      return new FsError('denied', 'session cwd is not served');
    case 'outside':
    case 'link_escape':
    case 'changed':
    case 'hard_link':
      return new FsError('escapes_root', `the session folder is not inside its own work folder: ${cwd}`);
    case 'unknown_ferret':
      return new FsError('not_found', `session cwd is not available: ${cwd}`);
    case 'device_file':
    case 'not_a_file':
      return new FsError('not_a_directory', 'session cwd is not a directory');
    default:
      // read_only, not_declared, no_descriptor_reach: this daemon cannot hold the folder, so the surface is closed.
      return new FsError('unsupported', `the session folder cannot be held open on this daemon (${refusal})`);
  }
}

/** The viewer's refusal for a root folder the kernel refused or could not reach; an unknown failure is returned as is. */
export function pinRefusal(error: unknown, cwd: string): unknown {
  if (error instanceof FsError) return error;
  const refusal = refusalOf(error);
  if (refusal !== undefined) return refusalError(refusal, cwd);
  const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined;
  if (typeof code === 'string' && MISSING.has(code))
    return new FsError('not_found', `session cwd is not available: ${cwd}`);
  if (code === 'ENOTDIR') return new FsError('not_a_directory', 'session cwd is not a directory');
  return error;
}

/**
 * The viewer's refusal for a walk beneath the held root that the kernel's fence refused (S47, today's `homeRefusal` and
 * `hardLinkRefusal`): a path inside the state home, or a file with another name that could be. `denied`, 403. Any other
 * failure of the walk is returned as it is.
 */
function walkRefusal(error: unknown): unknown {
  switch (refusalOf(error)) {
    case 'fenced':
      return new FsError(
        'denied',
        "that path is inside this daemon's state home, which holds this machine's credentials, so it is not read",
      );
    case 'hard_link':
      return new FsError(
        'denied',
        "that file has more than one name, and another of its names could be inside this daemon's state home, so it is not read",
      );
    default:
      return error;
  }
}

/** The held root, with the kernel's per-walk refusals said in the viewer's own vocabulary, and its name verdict. */
function sayingRefusals(held: HeldRoot): PinnedRoot {
  return {
    rootReal: held.rootReal,
    policyCwd: held.policyCwd,
    fenced: rels => held.fenced(rels),
    open: async (rel, openOptions) => {
      try {
        return await held.open(rel, openOptions);
      } catch (error) {
        throw walkRefusal(error);
      }
    },
    probe: () => held.probe(),
    close: () => held.close(),
  };
}

export class KernelSessionRootPinner implements SessionRootPinner {
  constructor(private readonly root: PinnableRoot) {}

  async pin(cwd: string, options?: PinOptions): Promise<PinnedRoot> {
    // The session root IS the ferret's `work` root: its base is the folder the registry holds for that ferret. The
    // string the caller read from the session document is never opened, and cannot name another folder.
    const checked = this.root.resolve('.');
    if (!checked.ok) throw refusalError(checked.error, cwd);
    try {
      return sayingRefusals(await this.root.pin(checked.value, options));
    } catch (error) {
      throw pinRefusal(error, cwd);
    }
  }
}
