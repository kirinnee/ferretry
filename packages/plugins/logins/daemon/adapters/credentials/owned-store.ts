/**
 * The file-store branch of today's PlatformFleetCredentialStore and credential-facts readers, restricted to
 * Logins' own state/logins/credentials root. Material exists only inside these adapters for one read/probe.
 *
 * Every filesystem operation goes through the kernel's `credentials` internal root (§7.7): the kernel gives that root
 * to Logins alone, places its base at `<home>/state/logins/credentials`, refuses a base reached through a link, and
 * re-checks links and device files on every call. This adapter holds no filesystem authority of its own.
 */
import { dirname, relative } from 'node:path';
import type { FencedPath, RootHandle, RootLstat } from '@ferretry/kernel/contract';
import type { LoginFile } from '../../../contract/index.ts';
import { FleetCredentialCatalog, type CredentialEmailSource } from '../../lib/credentials/credentials-service.ts';
import {
  InMemoryCredentialStatusStore,
  localCredentialFacts,
  type CredentialStatusPorts,
  type LocalCredentialFacts,
} from '../../lib/credentials/credential-status.ts';
import { resolveCredentialStore, type StoredCredentialResolution } from '../../lib/credentials/credentials.ts';
import type { FleetTokenRefreshPort } from '../../lib/credentials/token-refresh.ts';
import { PassiveUsageRecordSchema } from '../../lib/credentials/usage.ts';
import { classifyCredential, type CredentialMaterial } from '../../lib/shared/identity.ts';
import type { CredentialStoreCheck, CredentialStoreInspection } from '../../lib/shared/store-inspection.ts';
import { credentialFingerprint } from './credential-classifier.ts';
import type { AnthropicUsageProbe } from './anthropic-usage-probe.ts';
import type { CodexUsageProbe } from './codex-usage-probe.ts';

/** The calls this store makes on the kernel's `credentials` root. No host-home or keychain authority exists here. */
/** Said for a login kept in the person's own terminal sign-in folder (store: host): not in 5.0 yet. Their terminal's own sign-in is not touched and still works. */
export const HOST_STORE_PENDING =
  "using a login kept in your terminal's own sign-in folder (store: host) is not in 5.0 yet; the sign-in in your terminal itself still works";

export type OwnedLoginRoot = Pick<RootHandle, 'resolve' | 'readText' | 'stat' | 'lstat' | 'ensurePrivateDirectory'>;

const describe = (info: Pick<RootLstat, 'kind' | 'size' | 'modified' | 'mode' | 'links'>): string =>
  `${info.kind}:${info.size}:${String(info.modified)}:${info.mode}:${info.links}`;

/**
 * Today's credentialFileStamp (the link, and what it points at), not material: a metadata-only cache key for the
 * Claude account email, through the root's own lstat/stat. `undefined` (nothing is kept) when either look fails.
 */
async function stampOf(root: OwnedLoginRoot, path: FencedPath): Promise<string | undefined> {
  try {
    const link = await root.lstat(path);
    if (link === undefined) return 'absent';
    if (link.kind !== 'symlink') return describe(link);
    const target = await root.stat(path);
    return `${describe(link)}>${target === undefined ? 'dangling' : describe(target)}`;
  } catch {
    return undefined;
  }
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

// Copied from credential-store.ts: keep failures fixed and never quote a caught message or file contents.
function fileFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `the file could not be read (${code ?? 'an unknown error'})`;
}

export class OwnedLoginStore {
  readonly #base: string;
  readonly #emails = new Map<string, { readonly stamp: string; readonly email: string | undefined }>();

  /**
   * `root` is `kernel.roots.root('credentials')`, and nothing else: the kernel binds that name to Logins and its base to
   * `<home>/state/logins/credentials`, and refuses a linked, foreign or missing base on every call (§7.7).
   */
  constructor(
    private readonly root: OwnedLoginRoot,
    private readonly now: () => number,
  ) {
    const base = root.resolve('');
    if (!base.ok) throw new Error('the owned login root could not be resolved');
    this.#base = base.value;
  }

  /** Preserve today's store paths, substituting state/logins for the former fleet root. Host stores stay refused. */
  catalog(logins: () => ReadonlyMap<string, LoginFile>): FleetCredentialCatalog {
    return new FleetCredentialCatalog({
      logins,
      paths: undefined,
      resolveStore: (id, credential) => {
        if (credential.store === 'host')
          return {
            harness: credential.harness,
            store: 'host',
            unavailable: HOST_STORE_PENDING,
          };
        // A login is one directory, never a path supplied by a configuration name.
        if (id.length === 0 || id === '.' || id === '..' || /[/\\\0]/u.test(id))
          return {
            harness: credential.harness,
            store: 'ferretry',
            unavailable: 'the login id is not a directory name',
          };
        return resolveCredentialStore(id, credential, { fleetRoot: dirname(this.#base), userHome: this.#base });
      },
      inspect: resolution => this.inspectStored(resolution),
      ensureDirectory: path => this.root.ensurePrivateDirectory(this.#path(path)),
    });
  }

  #path(path: string): FencedPath {
    const within = relative(this.#base, path);
    if (within === '..' || within.startsWith('../') || within.startsWith('/') || within.includes('\0'))
      throw new Error('the store is outside the owned login root');
    const result = this.root.resolve(within);
    if (!result.ok) throw new Error('the owned login path was refused');
    return result.value;
  }

  #file(resolution: StoredCredentialResolution): FencedPath {
    if (resolution.store !== 'ferretry' || resolution.ownedDirectory === undefined)
      throw new Error('only an owned login store may be read');
    this.#path(resolution.ownedDirectory);
    return this.#path(resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile);
  }

  // Today's readFileMaterial + readClaudeStoreFile + checkedFile, with every filesystem operation on the root.
  async #material(
    resolution: StoredCredentialResolution,
    checked: CredentialStoreCheck[],
  ): Promise<CredentialMaterial> {
    const path = this.#file(resolution);
    const location = `the file ${path}`;
    let material: CredentialMaterial;
    try {
      if (resolution.harness === 'claude' && (await this.root.lstat(path))?.kind === 'symlink') {
        material = {
          outcome: 'unreadable',
          reason:
            'the Claude credential file is a symbolic link, which Claude replaces with a private copy on its next refresh',
        };
      } else if ((await this.root.stat(path)) === undefined) material = { outcome: 'absent' };
      else {
        const blob = (await this.root.readText(path)).trim();
        material = blob.length === 0 ? { outcome: 'absent' } : { outcome: 'found', blob };
      }
    } catch (error) {
      checked.push({ location, found: 'unreadable', why: fileFailure(error) });
      throw error;
    }
    if (material.outcome === 'found') checked.push({ location, found: 'present' });
    else if (material.outcome === 'absent') checked.push({ location, found: 'nothing' });
    else checked.push({ location, found: 'unreadable', why: material.reason });
    return material;
  }

  async inspectStored(resolution: StoredCredentialResolution): Promise<CredentialStoreInspection> {
    const checked: CredentialStoreCheck[] = [];
    let material: CredentialMaterial;
    try {
      material = await this.#material(resolution, checked);
    } catch (error) {
      material = { outcome: 'unreadable', reason: fileFailure(error) };
    }
    return { reading: classifyCredential(resolution.harness, material, this.now()), checked };
  }

  #facts(resolution: StoredCredentialResolution, material: CredentialMaterial): LocalCredentialFacts {
    return localCredentialFacts(
      resolution.harness,
      material,
      material.outcome === 'found' ? credentialFingerprint(material.blob) : undefined,
    );
  }

  async local(resolution: StoredCredentialResolution): Promise<LocalCredentialFacts> {
    return this.#facts(resolution, await this.#material(resolution, []));
  }

  /** Today's CredentialEmailReader: Codex's claims, or Claude's account file, kept only while its stamp holds. */
  async email(source: CredentialEmailSource): Promise<string | undefined> {
    if (source.harness === 'codex') {
      const facts = await this.local(source.resolution).catch(() => undefined);
      return facts?.codex?.state === 'tokens' ? facts.codex.email : undefined;
    }
    const path = this.#path(source.accountFile);
    const stamp = await stampOf(this.root, path);
    const kept = this.#emails.get(path);
    if (stamp !== undefined && kept?.stamp === stamp) return kept.email;
    let email: string | undefined;
    try {
      const root = asRecord(JSON.parse(await this.root.readText(path)) as unknown);
      email = nonEmpty(asRecord(root?.oauthAccount)?.emailAddress);
    } catch {
      email = undefined;
    }
    if (stamp !== undefined) this.#emails.set(path, { stamp, email });
    return email;
  }

  statusPorts(options: {
    readonly anthropic: AnthropicUsageProbe;
    readonly codex: CodexUsageProbe;
    readonly refresh: FleetTokenRefreshPort;
    readonly usageIntervalMs: number;
  }): CredentialStatusPorts {
    return {
      local: resolution => this.local(resolution),
      passiveUsage: async subject => {
        try {
          const resolution = subject.resolution;
          if (resolution.store !== 'ferretry' || 'unavailable' in resolution) return undefined;
          const path = this.#path(`${resolution.ownedDirectory}/usage.json`);
          const parsed = PassiveUsageRecordSchema.safeParse(JSON.parse(await this.root.readText(path)) as unknown);
          return parsed.success ? parsed.data : undefined;
        } catch {
          return undefined;
        }
      },
      // Today's MaterialCredentialReads.active: one read, facts for that exact material, a fixed failure on throw.
      activeUsage: async resolution => {
        const material = await this.#material(resolution, []);
        const local = this.#facts(resolution, material);
        try {
          const probe = resolution.harness === 'claude' ? options.anthropic : options.codex;
          return { result: await probe.probeMaterial(material), local };
        } catch {
          return { result: { usageBased: true, ok: false, credentialSignal: 'inconclusive' }, local };
        }
      },
      refresh: {
        refresh: async (target, settled) => {
          // Check now may launch a harness only inside this owned root, never on a host home.
          const home = this.#path(target.home);
          if ((await this.root.stat(home))?.kind !== 'directory')
            return { outcome: 'unavailable', reason: 'the owned login directory could not be reached' };
          // The canonical file may itself be a link; apply the root's link/device check to it too.
          await this.root.stat(this.#path(`${target.home}/auth.json`));
          return await options.refresh.refresh(target, settled);
        },
      },
      heads: new InMemoryCredentialStatusStore(),
      now: this.now,
      usageIntervalMs: options.usageIntervalMs,
    };
  }
}
