/**
 * Reading this machine's own Claude Code and Codex setup for the first-run import
 * (docs/design/account-model.md §4.3, §7 `/v1/fleet/setup/scan`).
 *
 * This is the half of the import that touches the host: it locates each harness's instructions,
 * settings, MCP servers, hooks and skills, reads safe sign-in facts, and looks each MCP command up on this machine. Everything it reads is handed to
 * `../lib/account/import.ts`, which decides what becomes a component. Nothing here writes.
 *
 * WHERE EACH HARNESS KEEPS ITS SETUP, as the harness resolves it:
 *
 * | | Claude Code | Codex |
 * | --- | --- | --- |
 * | home | `CLAUDE_CONFIG_DIR`, else `~/.claude` | `CODEX_HOME`, else `~/.codex` |
 * | instructions | `<home>/CLAUDE.md` | `<home>/AGENTS.md` |
 * | settings | `<home>/settings.json` | `<home>/config.toml` (MCP servers inside it) |
 * | MCP servers | `~/.claude.json` (`<home>/.claude.json` with `CLAUDE_CONFIG_DIR`) | `config.toml` |
 * | hooks | the `hooks` block of `settings.json` | `<home>/hooks.json` |
 * | skills | `<home>/skills/<item>/` | `<home>/skills/<item>/`, never `.system` |
 *
 * The login is an opaque host pointer. Only Logins contract status and email facts are consumed.
 * Missing host discovery facts are reported as unknown. No sign-in file is opened.
 *
 * Nothing is launched. Every read goes through {@link HostFiles} over the kernel roots (`root-host-files.ts`):
 * a `harness-home` root scoped to the harness home, and the one declared file beside it (`~/.claude.json`).
 *
 * A home the person moved with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is reachable only if the caller names it (GAP(kernel): the person's shell variables are not readable by a plugin).
 */
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { hostCodexHome, isSignInName } from '../lib/account/credentials.ts';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import {
  type HostDocumentRead,
  type HostHarnessScan,
  type HostLogin,
  type HostSkill,
  claudeProjectFolders,
  type ProjectInstructionHint,
  scannedMcpServers,
} from '../lib/account/import.ts';
import { isHarnessOwnedSkillEntry } from '../lib/assets.ts';
import { harnessKeyOfKind } from '../lib/harness-kind.ts';
import type { HarnessKind } from '../lib/manifest.ts';
import type { HostEntry, HostFiles } from './ports.ts';

/** Resolving a bare command name on this machine's `PATH`. The daemon's one harness locator. */
interface HostCommandResolver {
  resolve(name: string): string | undefined | Promise<string | undefined>;
}

export interface HostHarnessScanDeps {
  /** The host's files, read only. */
  readonly files: HostFiles;
  /** The home root provided by the permitted host adapter. */
  readonly userHome: string;
  /** `CLAUDE_CONFIG_DIR` as the person's shell has it, if at all. */
  readonly claudeConfigDir?: string;
  /** `CODEX_HOME` as the person's shell has it, if at all. */
  readonly codexHome?: string;
  readonly commands: HostCommandResolver;
  /** Safe sign-in facts only; no credential material is reachable through this port. */
  readonly logins: Pick<LoginsApi, 'list'>;
  /** Largest document read; anything larger is reported, never truncated. */
  readonly maxDocumentBytes: number;
  /** Limit for skill hashing once checked host traversal is available. */
  readonly maxSkillFiles?: number;
}

const LINK_REFUSED = 'symbolic links are not readable setup paths';

const DEFAULT_MAX_SKILL_FILES = 2_000;

/** The largest skill file a scan or an import reads whole; a larger one is told apart by a marker and skipped by the import. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** The most bytes one skill's digest reads in all; the files after it are hashed by name only. */
export const MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;

/** How many skill files are read at once while one skill is hashed (each read is a guarded kernel walk). */
const DIGEST_READS_AT_ONCE = 16;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class HostHarnessScanner {
  readonly #maxSkillFiles: number;
  /** Each skill folder's last digest, held with the listing marks it was taken under (see {@link #digest}). */
  readonly #digests = new Map<string, { readonly fingerprint: string; readonly digest: Promise<string> }>();

  constructor(private readonly deps: HostHarnessScanDeps) {
    this.#maxSkillFiles = deps.maxSkillFiles ?? DEFAULT_MAX_SKILL_FILES;
  }

  /** Both harnesses, installed or not, in a stable order. */
  async scan(): Promise<readonly HostHarnessScan[]> {
    return await Promise.all([this.#claude(), this.#codex()]);
  }

  async #claude(): Promise<HostHarnessScan> {
    const named = this.deps.claudeConfigDir?.trim() ?? '';
    const configured = named !== '' && isAbsolute(named) ? named : undefined;
    const home = configured ?? join(this.deps.userHome, '.claude');
    const [instructions, settings, mcp, skills] = await Promise.all([
      this.#read(home, join(home, 'CLAUDE.md')),
      this.#read(home, join(home, 'settings.json')),
      configured === undefined ? this.#readUserClaudeJson() : this.#read(home, join(home, '.claude.json')),
      this.#skills('claude', home, join(home, 'skills')),
    ]);
    const login = await this.#login('claude');
    const projectInstructions = await this.#projectInstructions({ harness: 'claude', mcp } as HostHarnessScan);
    return await this.#complete({
      harness: 'claude',
      login,
      instructions,
      settings,
      mcp,
      projectInstructions,
      skills: skills.found,
      problems: [
        ...(named !== '' && configured === undefined
          ? [`CLAUDE_CONFIG_DIR is the relative path "${named}", so ${home} was read instead.`]
          : []),
        ...skills.problems,
      ],
    });
  }

  async #codex(): Promise<HostHarnessScan> {
    const home = hostCodexHome(this.deps.codexHome, this.deps.userHome);
    if (home === undefined) {
      const reason = 'CODEX_HOME is set to a relative path, so your Codex setup could not be found';
      const source = this.deps.codexHome ?? '';
      return await this.#complete({
        harness: 'codex',
        login: { state: 'not-shareable', reason },
        instructions: { kind: 'unreadable', source, reason },
        settings: { kind: 'unreadable', source, reason },
        hooks: { kind: 'absent', source },
        skills: [],
        problems: [],
      });
    }
    const [instructions, settings, hooks, skills] = await Promise.all([
      this.#read(home, join(home, 'AGENTS.md')),
      this.#read(home, join(home, 'config.toml')),
      this.#read(home, join(home, 'hooks.json')),
      this.#skills('codex', home, join(home, 'skills')),
    ]);
    const login = await this.#login('codex');
    return await this.#complete({
      harness: 'codex',
      login,
      instructions,
      settings,
      hooks,
      skills: skills.found,
      problems: skills.problems,
    });
  }

  /**
   * The project folders Claude keeps state for, each with the instructions file it would read there. The folder is
   * never opened beyond one `lstat` of that file, and where the kernel does not serve it the hint is kept unverified.
   */
  async #projectInstructions(scan: HostHarnessScan): Promise<ProjectInstructionHint[]> {
    const file = 'CLAUDE.md';
    const hints: ProjectInstructionHint[] = [];
    for (const path of claudeProjectFolders(scan)) {
      try {
        const info = await this.deps.files.lstat(join(path, file));
        if (info === undefined) continue;
        if (info.kind === 'file') hints.push({ path, file, verified: true });
      } catch {
        hints.push({ path, file, verified: false });
      }
    }
    return hints;
  }

  /**
   * The located command and the MCP commands this machine lacks, added to what was read. A command whose place the
   * scan may not look at (an absolute path outside the folders Runtimes may read) is neither found nor missing: it
   * is named as unchecked in the harness's problems, and the scan goes on.
   */
  async #complete(scan: Omit<HostHarnessScan, 'command' | 'missingCommands'>): Promise<HostHarnessScan> {
    const command = await this.deps.commands.resolve(scan.harness);
    const partial: HostHarnessScan = { ...scan, missingCommands: [] };
    const missing = new Set<string>();
    const unchecked = new Set<string>();
    for (const server of scannedMcpServers(partial)) {
      if (server.command === undefined) continue;
      try {
        if (!(await this.#commandExists(server.command))) missing.add(server.command);
      } catch {
        unchecked.add(server.command);
      }
    }
    return {
      ...partial,
      ...(command === undefined ? {} : { command }),
      missingCommands: [...missing],
      problems: [
        ...partial.problems,
        ...[...unchecked].map(
          name =>
            `Could not check whether the MCP command ${name} exists, because it is outside the folders Ferretry may read.`,
        ),
      ],
    };
  }

  async #commandExists(command: string): Promise<boolean> {
    if (command.includes('/')) {
      // A path is checked where it points, never looked up on PATH.
      return isAbsolute(command) && ((await this.deps.files.stat(command))?.size ?? 0) > 0;
    }
    return (await this.deps.commands.resolve(command)) !== undefined;
  }

  /** Host links are opaque. Unknown facts stay unknown; never inspect a harness sign-in file. */
  async #login(harness: HarnessKind): Promise<HostLogin> {
    const key = harnessKeyOfKind(harness);
    const unknown: HostLogin = {
      state: 'unknown',
      reason: 'Logins has no unambiguous host sign-in fact for this harness',
    };
    try {
      const rows = (await this.deps.logins.list()).logins.filter(
        login => login.store === 'host' && login.harnesses.includes(key),
      );
      if (rows.length !== 1) return unknown;
      const row = rows[0];
      if (row === undefined) return unknown;
      const email = row.email === undefined ? {} : { email: row.email };
      if (row.status.lastCheckInconclusive) return { ...unknown, ...email };
      switch (row.status.word) {
        case 'ready':
          return { state: 'signed-in', ...email };
        case 'refresh_due':
          return { state: 'refresh-due', ...email };
        case 'needs_sign_in':
          return { state: 'not-signed-in', ...email };
        default:
          return { ...unknown, ...email };
      }
    } catch {
      return unknown;
    }
  }

  /** Metadata only: reject links at the home and every component beneath it, never stat through one. */
  async #inspect(home: string, path: string): Promise<HostEntry | undefined> {
    const inside = relative(home, path);
    if (!isAbsolute(home) || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
      throw new Error('the path is outside its harness home');
    }
    const components = inside === '' ? [] : inside.split(sep);
    if ([basename(home), ...components].some(isSignInName)) {
      throw new Error('sign-in files are not readable setup documents');
    }
    let current = home;
    for (const component of components) {
      const info = await this.deps.files.lstat(current);
      if (info === undefined) return undefined;
      if (info.kind === 'link') throw new Error(LINK_REFUSED);
      if (info.kind !== 'directory') throw new Error('a setup path ancestor is not a directory');
      current = join(current, component);
    }
    const info = await this.deps.files.lstat(current);
    if (info?.kind === 'link') throw new Error(LINK_REFUSED);
    return info;
  }

  /**
   * One setup document. `home` is the harness home it must lie in (every component is checked, none a link, none a
   * sign-in file). The read goes through the same root handle that checked the path, which holds the file open and
   * proves it is the file the name reached (no path-based read can be redirected by a swapped file or ancestor).
   */
  async #read(home: string, path: string): Promise<HostDocumentRead> {
    return await this.#document(path, () => this.#inspect(home, path));
  }

  /** The ONE file beside a home, `~/.claude.json`, which the kernel serves alone. Its path is built here, never passed in. */
  async #readUserClaudeJson(): Promise<HostDocumentRead> {
    return await this.#document(this.#userClaudeJson(), () => this.#inspectUserClaudeJson());
  }

  #userClaudeJson(): string {
    return join(this.deps.userHome, '.claude.json');
  }

  async #document(path: string, inspect: () => Promise<HostEntry | undefined>): Promise<HostDocumentRead> {
    try {
      const info = await inspect();
      if (info === undefined) return { kind: 'absent', source: path };
      if (info.kind !== 'file') return { kind: 'unreadable', source: path, reason: 'it is not a file' };
      if (info.size > this.deps.maxDocumentBytes) return { kind: 'too-large', source: path, bytes: info.size };
      const text = await this.deps.files.readText(path);
      // Gone between the check and the read: absent, as if the check had run a moment later.
      if (text === undefined) return { kind: 'absent', source: path };
      return { kind: 'text', source: path, text, bytes: new TextEncoder().encode(text).byteLength };
    } catch (error) {
      return { kind: 'unreadable', source: path, reason: errorText(error) };
    }
  }

  /**
   * The one file beside a home: never a link. It takes no path: the file is `~/.claude.json`, built by
   * `#userClaudeJson`, so the sign-in name check below holds by construction (BG-033 keeps it as the guard).
   */
  async #inspectUserClaudeJson(): Promise<HostEntry | undefined> {
    const path = this.#userClaudeJson();
    if (isSignInName(basename(path))) throw new Error('sign-in files are not readable setup documents');
    const info = await this.deps.files.lstat(path);
    if (info?.kind === 'link') throw new Error(LINK_REFUSED);
    return info;
  }

  /** Every skill folder: one per item, each with a digest of its whole content. */
  async #skills(
    harness: HarnessKind,
    home: string,
    directory: string,
  ): Promise<{ found: HostSkill[]; problems: string[] }> {
    try {
      const info = await this.#inspect(home, directory);
      // A file where the folder would be is no skills, as it always was.
      if (info?.kind !== 'directory') return { found: [], problems: [] };
      const found: HostSkill[] = [];
      const problems: string[] = [];
      for (const item of [...((await this.deps.files.list(directory)) ?? [])].toSorted()) {
        if (item.startsWith('.') || isHarnessOwnedSkillEntry(harness, item)) continue;
        const source = join(directory, item);
        try {
          if ((await this.#inspect(home, source))?.kind !== 'directory') continue;
          const digest = await this.#digest(home, source);
          if (digest === undefined) {
            problems.push(
              `Skill "${item}" has more than ${String(this.#maxSkillFiles)} files, so it was not imported.`,
            );
            continue;
          }
          found.push({ item, source, digest });
        } catch (error) {
          problems.push(`Skill "${item}" at ${source} could not be read (${errorText(error)}).`);
        }
      }
      return { found, problems };
    } catch (error) {
      return { found: [], problems: [`Your skills folder ${directory} could not be read (${errorText(error)}).`] };
    }
  }

  /**
   * A digest over every file's relative path and bytes, in a stable order; `undefined` when too many.
   *
   * ONE LOOK PER FOLDER, NOT PER ANCESTOR (O8-4). Every host look is a kernel-guarded walk of the whole path, and this used
   * to re-check every ANCESTOR of every file, twice: ~23 guarded looks per file, so one 692-file skill held the setup scan
   * (and every onboarding page waiting on it) for 46 s. The walk now descends only into what a folder's own listing calls
   * a directory (never a link: the listing never follows one), which is the same "no link on the way" the ancestor walk
   * proved, and the kernel still refuses a link escape on every call. Each file is looked at once more, by itself, right
   * before it is read, so a file swapped for a link after the listing is hashed as a link, never followed — as before.
   * Reads run a few at a time and are hashed in sorted order, so the digest is the same as the one-at-a-time one.
   *
   * HELD WHILE NOTHING CHANGED. A skill folder whose listing says the same name, kind, size and modified time for every
   * file as when it was last hashed answers that digest without reading a byte (a repeat scan of an unchanged home: 2.3 s cold, 1.1 s held). It is the rule `make` and `rsync` use: a same-size rewrite that keeps the modified
   * time to the millisecond is not seen until anything else in the folder changes. A host whose listing has no times
   * holds nothing and hashes every time.
   */
  async #digest(home: string, root: string): Promise<string | undefined> {
    const all: { path: string; kind: HostEntry['kind']; mark: string | undefined }[] = [];
    const pending = [root];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const entry of await this.#entries(home, next)) {
        const path = join(next, entry.name);
        if (entry.kind === 'directory') pending.push(path);
        else all.push({ path, kind: entry.kind, mark: entry.mark });
        if (all.length > this.#maxSkillFiles) return undefined;
      }
    }
    const sorted = all.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // What the listing says of every file: the same marks mean the same bytes were hashed last time (see the class note).
    const marks = sorted.map(file =>
      file.mark === undefined ? undefined : `${relative(root, file.path)}\0${file.mark}`,
    );
    const fingerprint = marks.includes(undefined) ? undefined : marks.join('\n');
    const held = this.#digests.get(root);
    if (fingerprint !== undefined && held?.fingerprint === fingerprint) return await held.digest;
    const digest = this.#hash(root, sorted);
    if (fingerprint === undefined) return await digest;
    this.#digests.set(root, { fingerprint, digest });
    // A read that failed is never held: the next scan reads again.
    void digest.catch(() => {
      if (this.#digests.get(root)?.digest === digest) this.#digests.delete(root);
    });
    return await digest;
  }

  /** The digest itself: each file's relative path and bytes in sorted order, a few reads at a time. */
  async #hash(
    root: string,
    sorted: readonly { readonly path: string; readonly kind: HostEntry['kind'] }[],
  ): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256');
    let read = 0;
    for (let start = 0; start < sorted.length; start += DIGEST_READS_AT_ONCE) {
      const batch = sorted.slice(start, start + DIGEST_READS_AT_ONCE);
      // Only what the listing called a plain file is looked at again and read: a link, a sign-in name or anything else is
      // hashed as a link and never opened. Past the total budget a file is hashed by name only, never read.
      const budgeted = read < MAX_SKILL_TOTAL_BYTES;
      const contents = await Promise.all(
        batch.map(async file => (file.kind === 'file' ? await this.#leafBytes(file.path, budgeted) : undefined)),
      );
      batch.forEach(({ path }, index) => {
        const bytes = contents[index];
        read += bytes === undefined || typeof bytes === 'string' ? 0 : bytes.length;
        hasher.update(`${relative(root, path)}\0`);
        hasher.update(bytes ?? 'link\0');
        hasher.update('\0');
      });
    }
    return hasher.digest('hex');
  }

  /**
   * A folder's names with each one's own kind; a sign-in name is listed as a link, so it is never entered or read. `mark`
   * is the leaf's kind, size and modified time when the host's listing says them (nothing otherwise, so nothing is held).
   */
  async #entries(
    home: string,
    folder: string,
  ): Promise<readonly { name: string; kind: HostEntry['kind']; mark: string | undefined }[]> {
    const { files } = this.deps;
    const inside = relative(home, folder).split(sep);
    const signInNamed = (name: string): boolean => [...inside, name].some(isSignInName);
    const listed: readonly (HostEntry & { readonly name: string; readonly modified?: string })[] =
      files.entries === undefined
        ? await Promise.all(
            ((await files.list(folder)) ?? []).map(async name => ({
              name,
              // A sign-in name is never looked at, not even its kind; a look the host refuses counts as a link.
              ...((signInNamed(name) ? undefined : await files.lstat(join(folder, name)).catch(() => undefined)) ?? {
                kind: 'link' as const,
                size: 0,
              }),
            })),
          )
        : ((await files.entries(folder)) ?? []);
    return listed.map(entry =>
      // A sign-in name keeps no fact of its own, not even in the mark: it is a link by name, whatever is there.
      signInNamed(entry.name)
        ? { name: entry.name, kind: 'link' as const, mark: 'link' }
        : {
            name: entry.name,
            kind: entry.kind,
            mark: entry.modified === undefined ? undefined : `${entry.kind}\0${String(entry.size)}\0${entry.modified}`,
          },
    );
  }

  /**
   * A file's bytes, looked at by itself first: anything that is no longer a plain file (or is refused) is `undefined`.
   * At most {@link MAX_SKILL_FILE_BYTES} + 1 bytes are read whatever the file has grown to; a longer file is hashed as the
   * marker `large`, and a file past the total budget (`budgeted` false) as `unread`, so no read is unbounded.
   */
  async #leafBytes(path: string, budgeted: boolean): Promise<Uint8Array | string | undefined> {
    const info = await this.deps.files.lstat(path).catch(() => undefined);
    if (info?.kind !== 'file') return undefined;
    if (!budgeted) return 'unread';
    const bytes = (await this.deps.files.readBytes(path, MAX_SKILL_FILE_BYTES + 1)) ?? new Uint8Array();
    return bytes.length > MAX_SKILL_FILE_BYTES ? 'large' : bytes;
  }
}
