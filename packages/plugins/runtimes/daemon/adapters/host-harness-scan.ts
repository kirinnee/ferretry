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
import { hostCodexHome } from '../lib/account/credentials.ts';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import {
  type HostDocumentRead,
  type HostHarnessScan,
  type HostLogin,
  type HostSkill,
  scannedMcpServers,
} from '../lib/account/import.ts';
import { isHarnessOwnedSkillEntry } from '../lib/assets.ts';
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

// Logins and the harness contracts expose no sign-in filename list. These are the Claude/Codex
// filenames also named by account/credentials.ts; refuse them in every component, before any host call.
const SIGN_IN_FILES = new Set(['.credentials.json', 'auth.json']);

const LINK_REFUSED = 'symbolic links are not readable setup paths';

const DEFAULT_MAX_SKILL_FILES = 2_000;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class HostHarnessScanner {
  readonly #maxSkillFiles: number;

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
    const claudeJson = configured === undefined ? join(this.deps.userHome, '.claude.json') : join(home, '.claude.json');
    const [instructions, settings, mcp, skills] = await Promise.all([
      this.#read(home, join(home, 'CLAUDE.md')),
      this.#read(home, join(home, 'settings.json')),
      this.#read(configured === undefined ? undefined : home, claudeJson),
      this.#skills('claude', home, join(home, 'skills')),
    ]);
    const login = await this.#login('claude');
    return await this.#complete({
      harness: 'claude',
      login,
      instructions,
      settings,
      mcp,
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

  /** The located command and the MCP commands this machine lacks, added to what was read. */
  async #complete(scan: Omit<HostHarnessScan, 'command' | 'missingCommands'>): Promise<HostHarnessScan> {
    const command = await this.deps.commands.resolve(scan.harness);
    const partial: HostHarnessScan = { ...scan, missingCommands: [] };
    const missing = new Set<string>();
    for (const server of scannedMcpServers(partial)) {
      if (server.command !== undefined && !(await this.#commandExists(server.command))) missing.add(server.command);
    }
    return { ...partial, ...(command === undefined ? {} : { command }), missingCommands: [...missing] };
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
    const key = harness === 'claude' ? 'claude-code' : 'codex';
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
    if ([basename(home), ...components].some(name => SIGN_IN_FILES.has(name.toLowerCase()))) {
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
   * sign-in file); `undefined` for the ONE file beside a home (`~/.claude.json`), which the kernel serves alone.
   * The read goes through the same root handle that checked the path, which holds the file open and proves it is the
   * file the name reached (no path-based read can be redirected by a swapped file or ancestor).
   */
  async #read(home: string | undefined, path: string): Promise<HostDocumentRead> {
    try {
      const info = home === undefined ? await this.#inspectFile(path) : await this.#inspect(home, path);
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
   * The one file beside a home: never a link. Its name is the constant `.claude.json`, which no sign-in file is called, so
   * no name check is made here (a name check on a constant could never fire).
   */
  async #inspectFile(path: string): Promise<HostEntry | undefined> {
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

  /** A digest over every file's relative path and bytes, in a stable order; `undefined` when too many. */
  async #digest(home: string, root: string): Promise<string | undefined> {
    const all: string[] = [];
    const pending = [root];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const name of (await this.deps.files.list(next)) ?? []) {
        const path = join(next, name);
        const info = await this.#inspect(home, path).catch(() => ({ kind: 'link' as const, size: 0 }));
        if (info?.kind === 'directory') pending.push(path);
        else all.push(path);
        if (all.length > this.#maxSkillFiles) return undefined;
      }
    }
    const hasher = new Bun.CryptoHasher('sha256');
    for (const path of all.toSorted()) {
      hasher.update(`${relative(root, path)}\0`);
      const info = await this.#inspect(home, path).catch(() => ({ kind: 'link' as const, size: 0 }));
      // A link (or anything the guard refuses, a sign-in file included) counts as a link, never read.
      hasher.update(info?.kind === 'file' ? ((await this.deps.files.readBytes(path)) ?? new Uint8Array()) : 'link\0');
      hasher.update('\0');
    }
    return hasher.digest('hex');
  }
}
