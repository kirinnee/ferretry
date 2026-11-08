/**
 * The files the account model's catalogue reads (docs/design/account-model.md §5.3,
 * docs/config-files.md): the configuration files in effect with the revision they were read at, the
 * component documents they name, and what a document is now.
 *
 * Reads only. Every write a reviewed change makes goes through the provisioner, inside its rollback
 * boundary, so nothing here can leave a machine half-changed — and every configuration file that write
 * carries is acknowledged first, so the daemon never mistakes the owner's own reviewed change for an
 * unconfirmed loosening.
 */

import { join } from 'node:path';
import { z } from 'zod';
import type { AccountModel } from '../lib/account/schema.ts';
import type { AccountDocumentReading } from '../lib/service/catalog-service.ts';
import { type RuntimeRename, SESSION_STATUSES, type SessionStatus } from '../lib/service/foreign.ts';

import { ABSENT_DOCUMENT_REVISION, type FleetDocumentWrite } from '../lib/provisioning.ts';

import type { ConfigFilesPort, HostFiles, SourceFence } from './ports.ts';

const digest = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** Configuration and component documents are private: they name everything a runtime runs with. */
const DOCUMENT_MODE = 0o600;

/**
 * The directories of this daemon's home that the catalogue names.
 *
 * GAP(kernel): `FoundationPaths` (`lib/paths.ts`) is the kernel's layout of the state home; these are the five paths
 * this file reads from it, kept local until a kernel port hands them to a plugin.
 */
export interface FleetHomePaths {
  readonly home: string;
  readonly state: string;
  readonly config: string;
  readonly fleet: string;
  readonly fleetManifest: string;
}

/** Where the configuration lives. */
export interface ConfigAccountLocations {
  /** `<FY_HOME>/config`. */
  readonly configDirectory: string;
}

/**
 * The configuration in effect, as the catalogue reads it: the account model the files hold — each at
 * its last good version — and the writes that would move them to another model. `fresh` loads the directory first
 * instead of answering the last load.
 */
export async function readConfigAccountDocument(
  config: Pick<ConfigFilesPort<AccountModel>, 'inEffect' | 'load' | 'editsFor' | 'mentionsRenamed'>,
  locations: ConfigAccountLocations,
  fresh = false,
): Promise<AccountDocumentReading> {
  const loaded = fresh ? await config.load() : await config.inEffect();
  const { evaluation } = loaded;
  const model = evaluation.effective.model;
  return {
    format: evaluation.fleetFiles === 0 ? 'none' : 'present',
    model,
    revision: evaluation.fleetRevision,
    documents: (next: AccountModel, rename?: RuntimeRename): readonly FleetDocumentWrite[] =>
      [
        ...config.editsFor(loaded, next, runtimeFileMoves(rename)),
        ...(rename === undefined ? [] : config.mentionsRenamed(loaded, rename)),
      ].map(edit => ({
        path: join(locations.configDirectory, edit.path),
        content: edit.content ?? '',
        mode: DOCUMENT_MODE,
        expect: edit.expect,
        ...(edit.content === undefined ? { remove: true as const } : {}),
      })),
  };
}

/** A runtime's file under `config/` (`RUNTIME_ITEMS`: `config/runtimes/<name>.yaml`). */
const runtimeConfigPath = (name: string): string => `runtimes/${name}.yaml`;

/** A renamed runtime's file, new path → old path, so it moves with the owner's comments. */
export const runtimeFileMoves = (rename: RuntimeRename | undefined): ReadonlyMap<string, string> =>
  rename === undefined ? new Map() : new Map([[runtimeConfigPath(rename.to), runtimeConfigPath(rename.from)]]);

/**
 * The account model this machine declares, or `undefined` for a machine with no fleet files yet.
 * `fresh` (the default) loads the directory first — what a decision about authority needs, such as an
 * agent-control switch that must be in effect the moment it is saved; `false` answers the last load,
 * for a reader that runs on a timer.
 */
export async function readDeclaredAccountModel(
  config: Pick<ConfigFilesPort<AccountModel>, 'inEffect' | 'load' | 'editsFor' | 'mentionsRenamed'>,
  locations: ConfigAccountLocations,
  fresh = true,
): Promise<AccountModel | undefined> {
  const reading = await readConfigAccountDocument(config, locations, fresh);
  return reading.format === 'none' ? undefined : reading.model;
}

/**
 * The component-source fence over this daemon's own directories, as configured: no component may read, copy
 * or link a document inside them, the fleet's asset tree excepted (docs/secrets.md#what-the-state-home-fence-refuses).
 */
export const componentSourceFence = (
  paths: Pick<FleetHomePaths, 'home' | 'state' | 'config' | 'fleet'>,
): SourceFence => ({
  homes: [paths.home, paths.state, paths.config],
  open: [join(paths.fleet, 'assets')],
});

/** What a document is now: its sha256, or the absent sentinel. Throws when it exists and cannot be read. */
export async function documentRevision(files: Pick<HostFiles, 'readBytes'>, path: string): Promise<string> {
  const bytes = await files.readBytes(path);
  return bytes === undefined ? ABSENT_DOCUMENT_REVISION : digest(bytes);
}

/**
 * The status a raw state document says, or `undefined` when it says none a reader can count. Only the status is
 * read: the catalogue counts running sessions, and parsing the whole state of every session to count them was
 * the cost the session status tally exists to remove.
 */
export function sessionStatusOf(raw: unknown): SessionStatus | undefined {
  if (typeof raw !== 'object' || raw === null || !('status' in raw)) return undefined;
  const status = SessionStatusSchema.safeParse(raw.status);
  return status.success ? status.data : undefined;
}

const SessionStatusSchema = z.enum(SESSION_STATUSES);
