/**
 * Reading this machine's own Claude Code and Codex setup for the first-run import
 * (docs/design/account-model.md §4.3, §7 `/v1/fleet/setup/scan`).
 *
 * This is the half of the import that touches the host: it finds each harness's instructions,
 * settings, MCP servers, hooks and skills where the harness itself keeps them, reads safe sign-in facts, and looks each MCP command up on this machine. Everything it reads is handed to
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
 * Nothing is launched: a `PATH` lookup and file reads, so it is safe to run on a page open.
 *
 * The reads go through {@link HostFiles}; GAP(kernel): the host's harness homes have no root the plugin may declare.
 */
import { isAbsolute, join, relative } from 'node:path';
import { isHarnessOwnedSkillEntry } from '../lib/assets.ts';
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
import type { HostFiles } from './ports.ts';

/** Resolving a bare command name on this machine's `PATH`. The daemon's one harness locator. */
export interface HostCommandResolver {
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
  /** Most files hashed in one skill folder before the folder is reported as too large. */
  readonly maxSkillFiles?: number;
}

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
      this.#read(join(home, 'CLAUDE.md')),
      this.#read(join(home, 'settings.json')),
      this.#read(claudeJson),
      this.#skills('claude', join(home, 'skills')),
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
      this.#read(join(home, 'AGENTS.md')),
      this.#read(join(home, 'config.toml')),
      this.#read(join(home, 'hooks.json')),
      this.#skills('codex', join(home, 'skills')),
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

  async #read(path: string): Promise<HostDocumentRead> {
    try {
      const info = await this.deps.files.stat(path);
      if (info === undefined) return { kind: 'absent', source: path };
      if (info.kind !== 'file') return { kind: 'unreadable', source: path, reason: 'it is not a file' };
      if (info.size > this.deps.maxDocumentBytes) return { kind: 'too-large', source: path, bytes: info.size };
      const text = await this.deps.files.readText(path);
      if (text === undefined) return { kind: 'absent', source: path };
      return { kind: 'text', source: path, text, bytes: Buffer.byteLength(text) };
    } catch (error) {
      return { kind: 'unreadable', source: path, reason: errorText(error) };
    }
  }

  /** Every skill folder: one per item, each with a digest of its whole content. */
  async #skills(harness: HarnessKind, directory: string): Promise<{ found: HostSkill[]; problems: string[] }> {
    let entries: string[];
    try {
      const names = await this.deps.files.list(directory);
      if (names === undefined) return { found: [], problems: [] };
      entries = [...names].sort();
    } catch (error) {
      return { found: [], problems: [`Your skills folder ${directory} could not be read (${errorText(error)}).`] };
    }
    const found: HostSkill[] = [];
    const problems: string[] = [];
    for (const item of entries) {
      if (item.startsWith('.') || isHarnessOwnedSkillEntry(harness, item)) continue;
      const source = join(directory, item);
      try {
        const entry = await this.deps.files.stat(source);
        if (entry === undefined) throw new Error('it is gone');
        if (entry.kind !== 'directory') continue;
        const digest = await this.#digest(source);
        if (digest === undefined) {
          problems.push(`Skill "${item}" has more than ${String(this.#maxSkillFiles)} files, so it was not imported.`);
          continue;
        }
        found.push({ item, source, digest });
      } catch (error) {
        problems.push(`Skill "${item}" at ${source} could not be read (${errorText(error)}).`);
      }
    }
    return { found, problems };
  }

  async #bytes(path: string): Promise<Uint8Array> {
    const bytes = await this.deps.files.readBytes(path);
    if (bytes === undefined) throw new Error(`${path} is gone`);
    return bytes;
  }

  /** A digest over every file's relative path and bytes, in a stable order; `undefined` when too many. */
  async #digest(root: string): Promise<string | undefined> {
    const hasher = new Bun.CryptoHasher('sha256');
    const pending = [root];
    let files = 0;
    const all: string[] = [];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const name of (await this.deps.files.list(next)) ?? []) {
        const path = join(next, name);
        const info = await this.deps.files.lstat(path);
        if (info?.kind === 'directory') pending.push(path);
        else all.push(path);
      }
    }
    for (const path of all.sort()) {
      files += 1;
      if (files > this.#maxSkillFiles) return undefined;
      hasher.update(`${relative(root, path)}\0`);
      const info = await this.deps.files.lstat(path);
      hasher.update(info?.kind === 'link' ? `link\0` : await this.#bytes(path));
      hasher.update('\0');
    }
    return hasher.digest('hex');
  }
}
