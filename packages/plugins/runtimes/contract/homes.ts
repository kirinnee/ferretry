/**
 * The harness homes Runtimes published (`fleet/manifest.json`, one folder per home under `fleet/homes/`) and the bounded
 * reader of one. MCP and Skills read a runtime's user-scope servers and skills through this; they never hold a path
 * they may open, because `home` and `wrapper` below are display text and the reader serves a FIXED list of names.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { RuntimeId } from './index.ts';

/** One harness home the fleet catalogue published: the runtimes that launch into it. */
export interface RuntimeHome {
  /**
   * The folder under `fleet/homes/`, a plain name; for a home the fleet placed elsewhere (an operator's own folder,
   * served read-only), the id of its account.
   */
  readonly id: string;
  readonly harness: HarnessKey;
  /** Wrapper names that launch into it, deduped, in manifest order. */
  readonly runtimes: readonly RuntimeId[];
  /** Absolute, for display and for an inventory row's `source`. A consumer never opens it: only the reader reads a home. */
  readonly home: string;
  /** The absolute wrapper path, display only. */
  readonly wrapper: string;
}

/** The only files of a home the reader can serve, by name. */
export const RUNTIME_HOME_DOCUMENTS = ['.claude.json', 'settings.json', 'config.toml'] as const;
export type RuntimeHomeDocument = (typeof RUNTIME_HOME_DOCUMENTS)[number];

export interface RuntimeHomeSkillEntry {
  /** The folder name under `<home>/skills`. */
  readonly name: string;
  /** Absolute `<home>/skills/<name>/SKILL.md`, as listed (the link path). */
  readonly manifest: string;
  /** The entry is a link into the fleet's asset tree: a Ferretry-managed skill. */
  readonly managed: boolean;
}

/** What a walk of one skill folder lists (Catalogs' publish walk shape). */
export interface RuntimeHomeSkillTree {
  readonly entries: readonly {
    readonly path: string;
    readonly type: 'file' | 'symlink' | 'hardlink' | 'other' | 'deep';
    readonly size: number;
  }[];
  readonly truncated: boolean;
}

export type RuntimeHomeFileRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_big' | 'unreadable' };

/**
 * A document or home that cannot be served: a link, not a regular file, over the bound, no longer published, or a
 * manifest that cannot be read (the message then names the manifest's path). The message names no value.
 */
export class RuntimeHomeUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeHomeUnreadable';
  }
}

/**
 * A reader of ONE published home. It holds no handle: every method opens the `fleet` root scoped to that home and checks
 * the home is still published, so a home that disappears is refused.
 */
export interface RuntimeHomeReader {
  /** `null`: absent. Bounded; a link or a hard-linked file is refused ({@link RuntimeHomeUnreadable}). */
  document(file: RuntimeHomeDocument, limitBytes: number): Promise<string | null>;
  /** Folders directly in `<home>/skills`, at most `limit + 1`, dot-entries skipped, a link whose target leaves `fleet/` skipped. */
  skills(limit: number): Promise<readonly RuntimeHomeSkillEntry[]>;
  /** The text of `<home>/skills/<name>/SKILL.md`, or `undefined` (not listed, absent, too large, not a regular file). */
  skillManifest(name: string, maxBytes: number): Promise<string | undefined>;
  /** Catalogs' publish walk of one LISTED home skill folder, no link followed; `undefined` for a folder that is not listed. */
  skillTree(
    name: string,
    limits: { readonly entries: number; readonly depth: number },
  ): Promise<RuntimeHomeSkillTree | undefined>;
  /** One file of a LISTED skill folder; a link on the way, a `..` segment or a hard link is `unreadable`. */
  skillFile(name: string, relativePath: string, maxBytes: number): Promise<RuntimeHomeFileRead>;
}

/** The homes half of `RuntimesApi`. */
export interface RuntimeHomesApi {
  homes(): Promise<readonly RuntimeHome[]>;
  /**
   * `undefined` for an id `homes()` does not answer. Call `homes()` first: this answers from the last read of the
   * manifest in this daemon, so it is `undefined` until `homes()` has been read. Every reader call re-checks that.
   */
  home(id: string): RuntimeHomeReader | undefined;
}

/** The read models this half adds to `RUNTIMES_READ_MODELS`. */
export const RUNTIME_HOME_READ_MODELS = ['homes'] as const;
