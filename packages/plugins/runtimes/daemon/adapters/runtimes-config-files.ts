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
import { foreignComponentChanges, realisedEdits, unownedChanges } from '../lib/account/runtimes-edits.ts';
import {
  assembleRuntimesModel,
  type RuntimesModel,
  standInsNamedBy,
  stoodInLoginSentence,
} from '../lib/account/runtimes-model.ts';
import type { AccountModel } from '../lib/account/schema.ts';
import { type ModelCatalogSources, starterModelsOf } from '../lib/models/catalog.ts';
import { modelCatalogSourcesOf } from './model-sources.ts';
import { loginOfPinKey } from '../lib/account/derived-runtimes.ts';
import type { RuntimesHarnessKit } from '../../contract/harness-kit.ts';
import type { HarnessKind } from '../lib/manifest.ts';
import {
  FleetCatalogRefusal,
  type FleetCatalogServiceDeps,
  unreadableSentence,
} from '../lib/service/catalog-service.ts';
import { ownInstructionsSource } from './own-instructions-source.ts';
import { type ComponentSourceLookup, harnessKits, readProfileComponents, type Within } from './profile-components.ts';
import type { ConfigFilesPort } from './ports.ts';

// The contract widens its config defs so `manifest.data.config` accepts them (`contract/config-def.ts`); these put the shapes back.
const runtimeItems = RUNTIME_ITEMS as unknown as ConfigCollectionDef<RuntimeFile>;
const profileItems = PROFILE_ITEMS as unknown as ConfigCollectionDef<ProfileFile>;
const modelSetItems = MODEL_SET_ITEMS as unknown as ConfigCollectionDef<ModelSetFile>;
const runtimesFile = RUNTIMES_CONFIG as unknown as ConfigFileDef<RuntimesFile>;

/** What the pin state holds: its pins (empty on the first run, when no file exists), or that it exists and cannot be read. */
type PinsReading =
  | { readonly state: 'read'; readonly pins: ReadonlyMap<string, string> }
  | { readonly state: 'unreadable'; readonly file: string };

/**
 * Where a derived runtime's first-seen model is kept, by login and harness (D4: a runtime's default model never moves by
 * itself). An unreadable file refuses every derived runtime and is never written over.
 */
export interface StarterPins {
  read(): Promise<PinsReading>;
  /**
   * Records the pairs with no pin yet (a pin that is there is never replaced) and prunes the pins of every login not in
   * `present`, so a login that is removed and an id that returns later never inherit.
   */
  record(firstSeen: ReadonlyMap<string, string>, present: ReadonlySet<string>): Promise<void>;
}

/**
 * What the evaluator reads: Runtimes' own files, the logins Logins states (and their environment templates), and the
 * components the plugins that own the other kinds provide.
 */
export interface RuntimesConfigSources {
  readonly config: Pick<ConfigPort, 'collection' | 'file'>;
  readonly logins: Pick<LoginsApi, 'list' | 'environmentTemplates' | 'modelSources'>;
  /** The first-seen model of each derived runtime. */
  readonly pins: StarterPins;
  /** Who provides each profile component source; read live on every load, never kept. */
  readonly components: ComponentSourceLookup;
  /** Bounds each owner's answer, so one that never answers cannot hold an evaluation (and every apply behind it). */
  readonly within: Within;
  /** Looks up, ahead of a read, the commands the read will ask about (`./command-cache.ts`). */
  readonly prime?: (model: AccountModel | undefined) => Promise<void>;
  /** The harnesses installed here, as of the last `prime`: which CLI a login that drives both gets its derived runtime on. */
  readonly installed?: () => readonly HarnessKind[];
}

/**
 * The evaluator. What stood in for a part it could not read is part of EACH load it answers (`ConfigLoad.unreadable`),
 * never a field shared between loads: a decision about a plan asks the load the plan came from.
 */
export type RuntimesConfigFiles = ConfigFilesPort<AccountModel>;

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

/**
 * The catalogs Logins holds, asked on every evaluation: each harness's starter and each login's own default read through
 * them. `undefined` when Logins cannot say (the built-in profiles then hold no model set, and a pin still holds).
 */
async function loginCatalogs(
  logins: Pick<LoginsApi, 'modelSources'>,
  kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit>,
): Promise<ModelCatalogSources | undefined> {
  try {
    return modelCatalogSourcesOf(await logins.modelSources(), kits);
  } catch {
    return undefined;
  }
}

export function runtimesConfigFiles(sources: RuntimesConfigSources): RuntimesConfigFiles {
  let lastLogins: Awaited<ReturnType<LoginsApi['list']>>['logins'] | undefined;

  // EVERY evaluation reads the owners' components and the login templates again: nothing of them is kept between reads
  // (a cache refreshed by a watch showed a removed item for the length of the reload window).
  const evaluate = async (
    logins: NonNullable<typeof lastLogins>,
  ): Promise<Awaited<ReturnType<ConfigFilesPort<AccountModel>['load']>>> => {
    let assembled: RuntimesModel;
    // The harness commands are looked up before the model is derived from them (a login that drives both CLIs runs the
    // first that is installed), so the very first read already agrees with every later one.
    if (sources.installed !== undefined) await sources.prime?.(undefined);
    // What each harness's plugin gives, read with every evaluation like the components themselves.
    const kits = harnessKits(sources.components);
    const [components, templates, catalogs, pinned] = await Promise.all([
      readProfileComponents(sources.components, ownInstructionsSource(sources.config), sources.within),
      loginTemplates(sources.logins),
      loginCatalogs(sources.logins, kits),
      sources.pins.read(),
    ]);
    const starters = catalogs === undefined ? undefined : starterModelsOf(catalogs);
    try {
      assembled = assembleRuntimesModel({
        runtimes: sources.config.collection(runtimeItems),
        profiles: sources.config.collection(profileItems),
        modelSets: sources.config.collection(modelSetItems),
        settings: sources.config.file(runtimesFile),
        logins,
        templates,
        components,
        ...(starters === undefined ? {} : { starters }),
        ...(catalogs === undefined ? {} : { catalogs }),
        ...(pinned.state === 'read' ? { pins: pinned.pins } : { pinsUnreadable: pinned.file }),
        installed: sources.installed?.(),
        kits,
      });
    } catch (error) {
      throw inconsistent(error);
    }
    // A pair is pinned the FIRST time it is seen. The pin is written before the model is answered, so no later read can see
    // a different default; a login that is gone takes its pins with it, here, not on a timer. An unreadable file is never written.
    if (pinned.state === 'read') {
      const present = new Set(logins.map(login => login.id as string));
      const stale = [...pinned.pins.keys()].some(key => {
        const login = loginOfPinKey(key);
        return login === undefined || !present.has(login);
      });
      if (assembled.firstSeen.size > 0 || stale) await sources.pins.record(assembled.firstSeen, present);
    }
    return {
      evaluation: {
        fleetFiles: assembled.sources,
        fleetRevision: assembled.revision,
        effective: { model: assembled.model },
      },
      files: assembled,
      unreadable: assembled.unreadable,
      notices: assembled.notices,
      stoodInLogins: assembled.stoodInLogins,
    };
  };

  const load = async (): Promise<Awaited<ReturnType<ConfigFilesPort<AccountModel>['load']>>> => {
    lastLogins = (await sources.logins.list()).logins;
    const loaded = await evaluate(lastLogins);
    await sources.prime?.(loaded.evaluation.effective.model);
    return loaded;
  };

  return {
    // The last load; the files and the owners' components are live, so only the login list is reused. The command
    // lookups are asked again too (the cache itself answers from the last ten seconds): every catalogue read comes
    // through here, so a tool installed or removed since boot shows on the NEXT read, never only after a load.
    inEffect: async () => {
      if (lastLogins === undefined) return await load();
      const loaded = await evaluate(lastLogins);
      await sources.prime?.(loaded.evaluation.effective.model);
      return loaded;
    },
    load,
    // Every refusal here is made while the change is PROPOSED, before any document is written, so each sentence's
    // "nothing was changed" is true and the owner is never shown a plan that can only be refused at apply.
    editsFor: (loaded, next) => {
      if (loaded.unreadable.length > 0)
        throw new FleetCatalogRefusal('fleet_change_refused', unreadableSentence(loaded.unreadable));
      // The model the change would WRITE is judged, not the one in effect: a new runtime (or one moved) onto a login that
      // stands in would carry the stand-in in its wrapper, while removing the runtime that uses it carries none.
      const standingIn = standInsNamedBy(next, loaded.stoodInLogins);
      if (standingIn.length > 0)
        throw new FleetCatalogRefusal('fleet_change_refused', stoodInLoginSentence(standingIn));
      const unowned = unownedChanges(loaded.evaluation.effective.model, next);
      if (unowned.length > 0)
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `this change also sets ${unowned.join(', ')}, which no file of Runtimes holds, so it would be reported as applied and save nothing; nothing was changed`,
        );
      const foreign = foreignComponentChanges(loaded.evaluation.effective.model, next);
      if (foreign.length > 0)
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `this change also edits ${foreign.join(', ')}, which another part of Ferretry owns or that Runtimes does not write through a change (edit its own file under config/); nothing was changed`,
        );
      // A derived runtime that is saved is written whole, onto a real profile holding its pinned model (never onto a generated
      // one), and one that is refused is not saved on its generated profile at all.
      const realised = realisedEdits(loaded.evaluation.effective.model, next, (loaded.files as RuntimesModel).derived);
      if (realised.refused.length > 0)
        throw new FleetCatalogRefusal('fleet_change_refused', `${realised.refused.join('; ')}; nothing was changed`);
      return realised.edits.map(edit => ({
        path: edit.path,
        ...(edit.patch === undefined ? {} : { patch: edit.patch }),
        ...(edit.remove === true ? { content: undefined } : {}),
      }));
    },
    // GAP(runtimes): Warden's accounts and Lessons' agent live in those plugins' own files, which Runtimes cannot
    // write (a change that spans owners is not one set, #52 Q3), so a renamed runtime is not re-pointed there.
    mentionsRenamed: () => [],
  };
}

/**
 * The check that runs BEFORE any configuration document is written by a path that has no plan of its own to ask (a setup
 * or a clone: `FleetCatalogServiceDeps.preflight`): the model is read again and the change is refused while THAT reading
 * holds a stand-in. A catalogue apply additionally asks the plan itself (`FleetCatalogService`), and no check is made
 * against a list that other reads can overwrite.
 */
export function refuseBeforeWriting(
  files: Pick<RuntimesConfigFiles, 'inEffect'>,
): NonNullable<FleetCatalogServiceDeps['preflight']> {
  return async () => {
    const { unreadable } = await files.inEffect();
    if (unreadable.length > 0) throw new Error(unreadableSentence(unreadable));
  };
}
