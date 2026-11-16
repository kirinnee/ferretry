import type { Result } from '@ferretry/std';
import type { ChildEnvironment } from '../bound.ts';

export interface PathsPort {
  /** The owner's home directory as the OS reports it (Accounts orders sign-ins by work folders under it, I184). */
  home(): string;
  /**
   * Read-only: whether an owner-named ABSOLUTE path is a directory, and its real path (links and platform aliases
   * resolved). Never creates anything. A relative path, a path that does not exist and a path that is not a directory
   * are refused with a sentence the owner can read.
   */
  checkDirectory(absolutePath: string): Promise<Result<CheckedDirectory, DirectoryRefusal>>;
  /**
   * {@link checkDirectory}, and the answer remembered: the folder's canonical path, its device and inode, and whether the
   * state-home fence holds it. {@link BoundDirectory.verify} then re-judges all three right before the process is started,
   * which closes every swap made BEFORE that look (a folder renamed away and replaced by a link into the state home after
   * the start-time check). It does NOT close the instant between that look and the child's `chdir`: the runner still
   * reaches the folder by path (declared GAP, `docs/secrets.md`). Fails closed: a fence that cannot be computed refuses
   * the bind (`unresolved`). Read-only, like `checkDirectory`, and gated by the same `permissions.checkDirectory`.
   */
  bindDirectory(absolutePath: string): Promise<Result<BoundDirectory, BoundDirectoryRefusal>>;
  /**
   * The state home `absolutePath` is in — the configured home's name — judged as every owner root judges: as named,
   * on every link hop, by real path and by IDENTITY up to `/` (§7.7, S40–S47). `undefined` when it is outside the
   * fence or not there. THROWS when the fence cannot be built (the caller refuses). Only for
   * `permissions.checkDirectory`: it answers "is this inside the fence" for an absolute path, no wider than
   * `checkDirectory`, which already answers whether any absolute path is a directory.
   */
  stateHomeHolding(absolutePath: string): Promise<string | undefined>;
  /**
   * A bare executable NAME (`npx`, `claude`) resolved to the path a shell would run, under the kernel's control: only
   * for a manifest with `permissions.which`. The caller's `directories` (absolute; a harness's configured search
   * folders) are searched first, then the daemon's inherited `PATH`; an empty, relative or odd entry is never searched,
   * at most 64 folders are, and the first regular file (links followed) this process may execute wins. A name that is
   * a path, or not one plain command name, is not looked up. NOTHING is executed and no shell is involved; the answer is
   * that path or `undefined`, never the `PATH` itself.
   */
  which(name: string, options?: { readonly directories?: readonly string[] }): Promise<string | undefined>;
  /**
   * Today's harness-paths rule for ONE command: the operator's override variable (`FY_CLOUDFLARED`), else
   * {@link which}. Only for a manifest with `permissions.which` AND `override` listed, exactly, in
   * `permissions.whichOverrides` (`^FY_[A-Z0-9_]{1,60}$`); any other variable is refused naming the plugin, and no
   * other variable is ever read. A set override must be ABSOLUTE, a regular file (links followed) this process may
   * execute, and its basename must be `name` itself: otherwise it is `override_unusable` and the PATH is NOT searched
   * (the operator named a binary; running a different one would leave them believing the opposite). An unset or blank
   * override searches as `which` does. NOTHING is executed.
   */
  locate(
    name: string,
    options: { readonly override: string; readonly directories?: readonly string[] },
  ): Promise<CommandLocation>;
  /**
   * Where ONE command resolves on the `PATH` a Vault {@link ChildEnvironment} handle WILL set, without spending the
   * handle (today's launch guard searched a launch's own PATH). Only for a manifest with `permissions.which`, and only
   * for a handle minted for this plugin or for a plugin that offers a hook this plugin takes (the edge a launch is
   * handed on). The same name grammar, 64-folder bound and regular-file/`X_OK` rule as {@link which}; the daemon's
   * own `PATH` is NOT searched. The answer is a path, `absent`, or `unprovable` — a handle this plugin may not read, a
   * forged or spent one, one that sets no PATH, or one whose PATH was built from a `${secret:…}` reference — so a
   * caller that must prove a negative fails closed. Never the PATH itself, never another variable.
   */
  whichFor(name: string, env: ChildEnvironment): Promise<HandleCommandLookup>;
}

/** {@link PathsPort.locate}'s answer. `override_unusable` names the variable and the path it holds: NO fallback. */
export type CommandLocation =
  | { readonly kind: 'found'; readonly path: string; readonly via: 'override' | 'path' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'override_unusable'; readonly variable: string; readonly path: string };

/**
 * {@link PathsPort.whichFor}'s answer. `unprovable` says only that the handle's PATH could not be searched, never why
 * (a foreign handle and a secret-derived PATH answer alike).
 */
export type HandleCommandLookup =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unprovable' };

/** {@link PathsPort.checkDirectory} accepted: the canonical path. */
export interface CheckedDirectory {
  readonly realPath: string;
}

/** {@link PathsPort.checkDirectory} refused: why, and the sentence for the person who named the path. */
export interface DirectoryRefusal {
  readonly reason: 'not_absolute' | 'not_a_directory';
  readonly message: string;
}

/** {@link PathsPort.bindDirectory} refused, or a {@link BoundDirectory.verify} that held: why, and the sentence for the person. */
export interface BoundDirectoryRefusal {
  /**
   * `not_absolute` / `not_a_directory`: as {@link DirectoryRefusal}. `unresolved`: the kernel could not tell (the state
   * home cannot be identified, or a look failed), so it proves nothing. `changed` (verify only): what the folder reaches
   * is no longer what was checked.
   */
  readonly reason: 'not_absolute' | 'not_a_directory' | 'unresolved' | 'changed';
  readonly message: string;
}

/**
 * A launch folder as it was when it was checked ({@link PathsPort.bindDirectory}): its canonical path, the device and
 * inode of the directory that path resolved to, and the state-home fence's answer. {@link verify} looks at the folder
 * again and answers whether it is still exactly that, so a folder renamed away and replaced by a link (or another
 * directory) after the check is held instead of launched into.
 */
export interface BoundDirectory {
  /** The canonical path, as {@link PathsPort.checkDirectory} answers it. */
  readonly realPath: string;
  /**
   * The fence's answer when it was bound: the folder is the daemon's state home, lies inside it (by name and by identity,
   * wherever it is reached from) or is reached through a link that lives there. The caller decides who may start in such a
   * folder (an agent never may); binding refuses nothing for it.
   */
  readonly insideStateHome: boolean;
  /**
   * Resolves the folder again, immediately: the same canonical path, the same directory (device and inode) and the same
   * fence answer, else `changed`. Anything the kernel cannot read is `unresolved`: it fails closed, never passes on
   * doubt, never throws. Ask it as late as possible — right before the process is started.
   */
  verify(): Promise<Result<void, BoundDirectoryRefusal>>;
}
