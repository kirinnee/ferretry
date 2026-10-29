/**
 * Reading this machine's own Claude Code and Codex setup for the first-run import
 * (docs/design/account-model.md §4.3, §7 `/v1/fleet/setup/scan`).
 *
 * This is the half of the import that touches the host: it finds each harness's instructions,
 * settings, MCP servers, hooks and skills where the harness itself keeps them, classifies the
 * person's own login, and looks each MCP command up on this machine. Everything it reads is handed to
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
 * THE LOGIN IS READ AND CLASSIFIED, NEVER RETURNED. The credential goes through the same store the
 * account model reads (`store: host`: `""` for Claude, the person's own `auth.json` for Codex) and
 * comes out as a verdict and, where the harness records one, an email. A Codex host whose
 * `config.toml` keeps the login in a keyring has no file to share (gap G5), and is said so.
 *
 * Nothing is launched: a `PATH` lookup and file reads, so it is safe to run on a page open.
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { isHarnessOwnedSkillEntry } from '../lib/assets.ts';
import {
  CODEX_CREDENTIAL_STORE_FILE,
  CODEX_CREDENTIAL_STORE_KEY,
  hostCodexHome,
  resolveCredentialStore,
  type StoredCredentialResolution,
} from '../lib/account/credentials.ts';
import {
  type HostDocumentRead,
  type HostHarnessScan,
  type HostLogin,
  type HostSkill,
  scannedMcpServers,
} from '../lib/account/import.ts';
import { classifyCredential, type CredentialMaterial } from '../lib/identity.ts';
import type { HarnessKind } from '../lib/manifest.ts';
import { parseSettings } from '../lib/settings.ts';
import type { StoredCredentialMaterialReader } from './credential-classifier.ts';

/** Resolving a bare command name on this machine's `PATH`. The daemon's one harness locator. */
export interface HostCommandResolver {
  resolve(name: string): string | undefined;
}

export interface HostHarnessScanDeps {
  /** The person's REAL home. */
  readonly userHome: string;
  /** `CLAUDE_CONFIG_DIR` as the person's shell has it, if at all. */
  readonly claudeConfigDir?: string;
  /** `CODEX_HOME` as the person's shell has it, if at all. */
  readonly codexHome?: string;
  readonly commands: HostCommandResolver;
  /** Reads a `store: host` credential's material. The platform credential store satisfies it. */
  readonly credentials: StoredCredentialMaterialReader;
  readonly now: () => number;
  /** Largest document read; anything larger is reported, never truncated. */
  readonly maxDocumentBytes: number;
  /** Most files hashed in one skill folder before the folder is reported as too large. */
  readonly maxSkillFiles?: number;
}

const DEFAULT_MAX_SKILL_FILES = 2_000;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMissing = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** The email in a JWT's payload, without checking its signature: display only. */
function jwtEmail(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(claims) && typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

/** Codex's own record of who is signed in: the `email` claim of its id token. */
function codexEmail(material: CredentialMaterial): string | undefined {
  if (material.outcome !== 'found') return undefined;
  try {
    const document: unknown = JSON.parse(material.blob);
    return isRecord(document) && isRecord(document.tokens) ? jwtEmail(document.tokens.id_token) : undefined;
  } catch {
    return undefined;
  }
}

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
    const login = await this.#login('claude', mcp, undefined);
    return this.#complete({
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
      return this.#complete({
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
    const login = await this.#login('codex', settings, home);
    return this.#complete({
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
  #complete(scan: Omit<HostHarnessScan, 'command' | 'missingCommands'>): HostHarnessScan {
    const command = this.deps.commands.resolve(scan.harness);
    const partial: HostHarnessScan = { ...scan, missingCommands: [] };
    const missing = new Set<string>();
    for (const server of scannedMcpServers(partial)) {
      if (server.command !== undefined && !this.#commandExists(server.command)) missing.add(server.command);
    }
    return { ...partial, ...(command === undefined ? {} : { command }), missingCommands: [...missing] };
  }

  #commandExists(command: string): boolean {
    if (command.includes('/')) {
      // A path is checked where it points, never looked up on PATH.
      return isAbsolute(command) && Bun.file(command).size > 0;
    }
    return this.deps.commands.resolve(command) !== undefined;
  }

  /**
   * The person's own login: classified through the account model's `host` store, never returned.
   *
   * `document` is the harness's file that names the account (Claude's `.claude.json`) or says where
   * the login is kept (Codex's `config.toml`). `codexHome` is the Codex home already named for a Codex
   * scan.
   */
  async #login(harness: HarnessKind, document: HostDocumentRead, codexHome: string | undefined): Promise<HostLogin> {
    const parsed = parsedRecord(document, harness === 'claude' ? 'json' : 'toml');
    if (harness === 'codex') {
      const kept = parsed?.[CODEX_CREDENTIAL_STORE_KEY];
      if (kept === 'keyring') {
        return {
          state: 'not-shareable',
          reason: `your Codex keeps its login in the system keyring (${CODEX_CREDENTIAL_STORE_KEY} = "keyring"), not in a file Ferretry can share`,
        };
      }
    }
    // A host store never resolves to an environment login, and the caller only reaches here for Codex
    // once its home has been named, so what comes back is always a stored credential.
    const resolution = resolveCredentialStore(
      `${harness}-host`,
      { harness, store: 'host' },
      {
        fleetRoot: this.deps.userHome,
        userHome: this.deps.userHome,
        ...(codexHome === undefined ? {} : { hostCodexHome: codexHome }),
      },
    ) as StoredCredentialResolution;
    let material: CredentialMaterial;
    try {
      material = await this.deps.credentials.storedMaterial(resolution);
    } catch (error) {
      material = { outcome: 'unreadable', reason: errorText(error) };
    }
    const reading = classifyCredential(harness, material, this.deps.now());
    const email =
      harness === 'claude'
        ? (() => {
            const account = parsed?.oauthAccount;
            return isRecord(account) && typeof account.emailAddress === 'string' ? account.emailAddress : undefined;
          })()
        : codexEmail(material);
    const withEmail = email === undefined ? {} : { email };
    switch (reading.state) {
      case 'valid':
        return { state: 'signed-in', ...withEmail };
      case 'refreshable':
        return { state: 'refresh-due', ...withEmail };
      case 'missing':
        return harness === 'codex' && parsed?.[CODEX_CREDENTIAL_STORE_KEY] === 'auto'
          ? {
              state: 'not-signed-in',
              reason: `no auth.json was found; with ${CODEX_CREDENTIAL_STORE_KEY} = "auto" your login may be in the system keyring, which Ferretry cannot share — set it to "${CODEX_CREDENTIAL_STORE_FILE}" and sign in again to share it`,
            }
          : { state: 'not-signed-in' };
      default:
        return { state: 'unreadable', reason: reading.reason ?? 'the credential could not be read', ...withEmail };
    }
  }

  async #read(path: string): Promise<HostDocumentRead> {
    try {
      const info = await stat(path);
      if (!info.isFile()) return { kind: 'unreadable', source: path, reason: 'it is not a file' };
      if (info.size > this.deps.maxDocumentBytes) return { kind: 'too-large', source: path, bytes: info.size };
      const text = await readFile(path, 'utf8');
      return { kind: 'text', source: path, text, bytes: Buffer.byteLength(text) };
    } catch (error) {
      if (isMissing(error)) return { kind: 'absent', source: path };
      return { kind: 'unreadable', source: path, reason: errorText(error) };
    }
  }

  /** Every skill folder: one per item, each with a digest of its whole content. */
  async #skills(harness: HarnessKind, directory: string): Promise<{ found: HostSkill[]; problems: string[] }> {
    let entries: string[];
    try {
      entries = (await readdir(directory)).sort();
    } catch (error) {
      if (isMissing(error)) return { found: [], problems: [] };
      return { found: [], problems: [`Your skills folder ${directory} could not be read (${errorText(error)}).`] };
    }
    const found: HostSkill[] = [];
    const problems: string[] = [];
    for (const item of entries) {
      if (item.startsWith('.') || isHarnessOwnedSkillEntry(harness, item)) continue;
      const source = join(directory, item);
      try {
        if (!(await stat(source)).isDirectory()) continue;
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

  /** A digest over every file's relative path and bytes, in a stable order; `undefined` when too many. */
  async #digest(root: string): Promise<string | undefined> {
    const hasher = new Bun.CryptoHasher('sha256');
    const pending = [root];
    let files = 0;
    const all: string[] = [];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const name of await readdir(next)) {
        const path = join(next, name);
        const info = await lstat(path);
        if (info.isDirectory()) pending.push(path);
        else all.push(path);
      }
    }
    for (const path of all.sort()) {
      files += 1;
      if (files > this.#maxSkillFiles) return undefined;
      hasher.update(`${relative(root, path)}\0`);
      const info = await lstat(path);
      hasher.update(info.isSymbolicLink() ? `link\0` : await readFile(path));
      hasher.update('\0');
    }
    return hasher.digest('hex');
  }
}

/** A read document as a record, or `undefined` when it is absent or will not parse. */
function parsedRecord(read: HostDocumentRead, format: 'json' | 'toml'): Readonly<Record<string, unknown>> | undefined {
  if (read.kind !== 'text') return undefined;
  try {
    return parseSettings(read.text, format);
  } catch {
    return undefined;
  }
}
