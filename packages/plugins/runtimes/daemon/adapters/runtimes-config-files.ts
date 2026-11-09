/**
 * The catalogue's {@link ConfigFilesPort} over the files Runtimes owns: `runtimes.yaml`, `runtimes/`, `profiles/` and
 * `model-sets/` through the kernel's `ConfigPort` (values, live, each at its last good version), and the logins through
 * Logins' port. It is today's evaluator and edit renderer made to the part of the machine a plugin may read:
 * `../lib/account/runtimes-model.ts` assembles the model, `../lib/account/runtimes-edits.ts` renders a change as
 * patches of the keys that moved.
 *
 * Read side only; the writes a change makes land through the all-or-none config writer (`./config-write-all.ts`).
 *
 * What is NOT read (a login's `${secret:NAME}` templates, the components another plugin owns) stands in and is listed in
 * {@link RuntimesConfigFiles.unreadable}; the catalogue's provisioner refuses an apply while that list is not empty
 * ({@link refuseWhileUnreadable}), so a stand-in is shown but never replaces a real document.
 */
import type { ConfigCollectionDef, ConfigFileDef, ConfigPort } from '@ferretry/kernel/contract';
import type { EnvironmentLoginTemplate, LoginsApi } from '@ferretry/plugin-logins/contract';
import {
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
  type ModelSetFile,
  type ProfileFile,
  type RuntimeFile,
  type RuntimesFile,
} from '../../contract/index.ts';
import { foreignComponentChanges, ownedFileEdits } from '../lib/account/runtimes-edits.ts';
import { assembleRuntimesModel, type RuntimesModel } from '../lib/account/runtimes-model.ts';
import type { AccountModel } from '../lib/account/schema.ts';
import { FleetCatalogRefusal, type FleetCatalogServiceDeps } from '../lib/service/catalog-service.ts';
import { ownInstructionsSource } from './own-instructions-source.ts';
import { type ComponentSourceLookup, readProfileComponents } from './profile-components.ts';
import type { ConfigFilesPort } from './ports.ts';

// The contract widens its config defs so `manifest.data.config` accepts them (`contract/config-def.ts`); these put the shapes back.
const runtimeItems = RUNTIME_ITEMS as unknown as ConfigCollectionDef<RuntimeFile>;
const profileItems = PROFILE_ITEMS as unknown as ConfigCollectionDef<ProfileFile>;
const modelSetItems = MODEL_SET_ITEMS as unknown as ConfigCollectionDef<ModelSetFile>;
const runtimesFile = RUNTIMES_CONFIG as unknown as ConfigFileDef<RuntimesFile>;

/**
 * What the evaluator reads: Runtimes' own files, the logins Logins states (and their environment templates), and the
 * components the plugins that own the other kinds provide.
 */
export interface RuntimesConfigSources {
  readonly config: Pick<ConfigPort, 'collection' | 'file'>;
  readonly logins: Pick<LoginsApi, 'list' | 'environmentTemplates'>;
  /** Who provides each profile component source; read live on every load, never kept. */
  readonly components: ComponentSourceLookup;
  /** Looks up, ahead of a read, the commands the read will ask about (`./command-cache.ts`). */
  readonly prime?: (model: AccountModel | undefined) => Promise<void>;
}

/** The evaluator, with what it had to stand in for. */
export interface RuntimesConfigFiles extends ConfigFilesPort<AccountModel> {
  /** What stands in for something it could not read at the last load; empty when every part was read. */
  unreadable(): readonly string[];
}

/** The sentence a set of files that do not hold together is refused with. Names and rules only, never a value. */
function inconsistent(error: unknown): Error {
  const issues =
    typeof error === 'object' && error !== null && 'issues' in error && Array.isArray(error.issues)
      ? (error.issues as readonly { readonly message?: unknown }[])
          .map(issue => (typeof issue.message === 'string' ? issue.message : undefined))
          .filter((message): message is string => message !== undefined)
      : [error instanceof Error ? error.message : String(error)];
  return new Error(`the runtimes, profiles and model sets on this machine do not fit together: ${issues.join('; ')}`);
}

/** The environment logins' templates by login id, or `undefined` when Logins could not give them (fail closed). */
async function loginTemplates(
  logins: Pick<LoginsApi, 'environmentTemplates'>,
): Promise<ReadonlyMap<string, EnvironmentLoginTemplate> | undefined> {
  try {
    return new Map((await logins.environmentTemplates()).map(template => [template.id, template]));
  } catch {
    return undefined;
  }
}

export function runtimesConfigFiles(sources: RuntimesConfigSources): RuntimesConfigFiles {
  let last: Awaited<ReturnType<ConfigFilesPort<AccountModel>['load']>> | undefined;
  let lastLogins: Awaited<ReturnType<LoginsApi['list']>>['logins'] | undefined;

  // EVERY evaluation reads the owners' components and the login templates again: nothing of them is kept between reads
  // (a cache refreshed by a watch showed a removed item for the length of the reload window).
  const evaluate = async (logins: NonNullable<typeof lastLogins>): Promise<NonNullable<typeof last>> => {
    let assembled: RuntimesModel;
    const [components, templates] = await Promise.all([
      readProfileComponents(sources.components, ownInstructionsSource(sources.config)),
      loginTemplates(sources.logins),
    ]);
    try {
      assembled = assembleRuntimesModel({
        runtimes: sources.config.collection(runtimeItems),
        profiles: sources.config.collection(profileItems),
        modelSets: sources.config.collection(modelSetItems),
        settings: sources.config.file(runtimesFile),
        logins,
        templates,
        components,
      });
    } catch (error) {
      throw inconsistent(error);
    }
    last = {
      evaluation: {
        fleetFiles: assembled.sources,
        fleetRevision: assembled.revision,
        effective: { model: assembled.model },
      },
      files: assembled,
    };
    return last;
  };

  const load = async (): Promise<NonNullable<typeof last>> => {
    lastLogins = (await sources.logins.list()).logins;
    const loaded = await evaluate(lastLogins);
    await sources.prime?.(loaded.evaluation.effective.model);
    return loaded;
  };

  return {
    // The last load; the files and the owners' components are live, so only the login list is reused.
    inEffect: async () => (lastLogins === undefined ? await load() : await evaluate(lastLogins)),
    load,
    editsFor: (loaded, next) => {
      const foreign = foreignComponentChanges(loaded.evaluation.effective.model, next);
      if (foreign.length > 0)
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `this change also edits ${foreign.join(', ')}, which another part of Ferretry owns or that Runtimes does not write through a change (edit its own file under config/); nothing was changed`,
        );
      return ownedFileEdits(loaded.evaluation.effective.model, next).map(edit => ({
        path: edit.path,
        ...(edit.patch === undefined ? {} : { patch: edit.patch }),
        ...(edit.remove === true ? { content: undefined } : {}),
      }));
    },
    // GAP(runtimes): Warden's accounts and Lessons' agent live in those plugins' own files, which Runtimes cannot
    // write (a change that spans owners is not one set, #52 Q3), so a renamed runtime is not re-pointed there.
    mentionsRenamed: () => [],
    unreadable: () => (last === undefined ? [] : (last.files as RuntimesModel).unreadable),
  };
}

/** The sentence an apply is refused with while something stands in for a document it could not read. */
const unreadableRefusal = (unreadable: readonly string[]): string =>
  `nothing was changed: ${unreadable.length === 1 ? 'a part of this machine' : `${String(unreadable.length)} parts of this machine`} could not be read from the Runtimes plugin, and a home written without ${unreadable.length === 1 ? 'it' : 'them'} would replace what is there (${unreadable.join('; ')})`;

/**
 * The provisioner as the catalogue uses it, refusing a preview or an apply while the model holds a stand-in: the
 * homes the plan would write are built from documents Runtimes could not read, and an apply replaces every home.
 */
export function refuseWhileUnreadable(
  inner: FleetCatalogServiceDeps['provisioner'],
  files: Pick<RuntimesConfigFiles, 'unreadable'>,
): FleetCatalogServiceDeps['provisioner'] {
  const refuse = (): void => {
    const unreadable = files.unreadable();
    if (unreadable.length > 0) throw new Error(unreadableRefusal(unreadable));
  };
  return {
    preview: async plan => await inner.preview(plan),
    apply: async (plan, documents) => {
      refuse();
      return await inner.apply(plan, documents);
    },
  };
}
