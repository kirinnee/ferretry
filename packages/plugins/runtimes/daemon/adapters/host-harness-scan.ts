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
 * Nothing is launched. Setup contents remain unreadable until the host supplies descriptor-checked reads;
 * path-based metadata checks alone cannot make reading a document or traversing a skill safe.
 *
 * The reads go through {@link HostFiles}; GAP(kernel): the host's harness homes have no root the plugin may declare.
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
import type { HarnessKind } from '../lib/manifest.ts';
import type { HostEntry, HostFiles } from './ports.ts';

/** Resolving a bare command name on this machine's `PATH`. The daemon's one harness locator. */
interface HostCommandResolver {
  resolve(name: string): string | undefined;
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

// The state-home-guard's checked-folder rule: metadata and reads must use the SAME descriptor.
// GAP(kernel): HostFiles exposes only path calls, with no checked open or descriptor identity.
// An lstat pass alone cannot protect a subsequent read/list from a swapped file or ancestor.
const CHECKED_READ_UNAVAILABLE =
  'checked host reads are unavailable: the host cannot check and read through the same descriptor';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class HostHarnessScanner {
  constructor(private readonly deps: HostHarnessScanDeps) {}

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
      this.#read(configured === undefined ? this.deps.userHome : home, claudeJson),
      this.#skills(home, join(home, 'skills')),
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
      this.#skills(home, join(home, 'skills')),
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
    const command = this.deps.commands.resolve(scan.harness);
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
    return this.deps.commands.resolve(command) !== undefined;
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
    if ([basename(home), ...components].some(name => SIGN_IN_FILES.has(name))) {
      throw new Error('sign-in files are not readable setup documents');
    }
    let current = home;
    for (let index = 0; index <= components.length; index += 1) {
      const info = await this.deps.files.lstat(current);
      if (info === undefined) return undefined;
      if (info.kind === 'link') throw new Error('symbolic links are not readable setup paths');
      if (index === components.length) return info;
      if (info.kind !== 'directory') throw new Error('a setup path ancestor is not a directory');
      const component = components[index];
      if (component === undefined) throw new Error('a setup path component is missing');
      current = join(current, component);
    }
    return undefined;
  }

  async #read(home: string, path: string): Promise<HostDocumentRead> {
    try {
      const info = await this.#inspect(home, path);
      if (info === undefined) return { kind: 'absent', source: path };
      if (info.kind !== 'file') return { kind: 'unreadable', source: path, reason: 'it is not a file' };
      if (info.size > this.deps.maxDocumentBytes) return { kind: 'too-large', source: path, bytes: info.size };
      // Never fall back to readText(path): the checked entry could have been replaced since lstat.
      return { kind: 'unreadable', source: path, reason: CHECKED_READ_UNAVAILABLE };
    } catch (error) {
      return { kind: 'unreadable', source: path, reason: errorText(error) };
    }
  }

  /** Skill traversal also needs a held folder; a path-based list can follow a replaced ancestor. */
  async #skills(home: string, directory: string): Promise<{ found: HostSkill[]; problems: string[] }> {
    try {
      const info = await this.#inspect(home, directory);
      if (info === undefined) return { found: [], problems: [] };
      // A file where the folder would be is no skills, as it always was: nothing is opened, so nothing is at risk.
      if (info.kind !== 'directory') return { found: [], problems: [] };
      // No list/readBytes fallback: even an ordinary skill folder can hide a sign-in file or alias.
      throw new Error(CHECKED_READ_UNAVAILABLE);
    } catch (error) {
      return { found: [], problems: [`Your skills folder ${directory} could not be read (${errorText(error)}).`] };
    }
  }
}
