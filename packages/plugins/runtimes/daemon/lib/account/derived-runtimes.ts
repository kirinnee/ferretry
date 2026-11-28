/**
 * The runtimes a machine has WITHOUT anybody making one: every login that is ready and has no runtime of its own yields
 * one, on Ferretry's default profile. It is derived at read time from the logins and the explicit files, never written:
 * nothing is migrated, and the moment the owner makes a runtime on that login (or edits the derived one, which writes it)
 * the explicit file is the only one there is.
 *
 * What "Ferretry's default profile" holds (`builtin-autonomous.ts`) is a starter model set, the "work alone well"
 * instructions and Claude's comfort settings, and NO permissions. The autonomous settings (permission mode, the Ferretry
 * tools) are the fixed layer a ferret started in `auto` mode gets (`fixed-layer.ts`, applied by the wrapper only for that
 * launch), so a derived runtime runs unattended exactly as one made by hand does, and runs as the person's own CLI from a
 * shell or for an `interactive` ferret.
 *
 * The two built-in profiles and their starter model sets are derived whether or not any login is, so a runtime saved on
 * one of them never dangles.
 *
 * An environment login (a key or endpoint of another provider) is derived too (runtimes plan U3, one-step Add account): its
 * model is its own catalog's default (a login that reads a model catalog wins over the profile's model set), and one that
 * drives both CLIs runs the first installed (Claude first). It is derived only while Logins gives its variable templates
 * clean; a withheld one would be a stand-in, which a runtime may not use.
 *
 * A login with no installed CLI to run it (when the installed set is known) gets NO runtime: the login stays, and says which
 * CLI it needs.
 *
 * A name is a pure function of its OWN login: the login's id, else `<id>-<suffix>` with the suffix derived from that id alone
 * when an owner runtime holds the id. Deleting or adding another login never renames this one, and a saved name whose login
 * is gone finds no runtime (it never lands on another login, and so never on its home, which is keyed by the name).
 *
 * Pure: no filesystem, no clock.
 */
import type { EnvironmentLoginTemplate, LoginView } from '@ferretry/plugin-logins/contract';
import type { ModelSetFile, ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { builtinProfileLayers, pinnedProfileName, starterModelSet } from './builtin-autonomous.ts';
import { supportedKindOfKey, supportedKinds } from '../harness-kind.ts';
import { type HarnessKind, harnessKeyOfKind } from '../manifest.ts';
import { NO_STARTERS, type StarterModels } from '../models/catalog.ts';
import type { LaunchModels } from '../models/runtime.ts';
import { isRuntimeName } from './schema.ts';

/** What the explicit files already hold, by name. */
export interface DerivedFrom {
  readonly runtimes: ReadonlyMap<string, RuntimeFile>;
  readonly profiles: ReadonlyMap<string, ProfileFile>;
  readonly modelSets: ReadonlyMap<string, ModelSetFile>;
  readonly logins: readonly LoginView[];
  /** The model each harness starts with (the catalog default); what the built-in model sets hold. */
  readonly starters?: StarterModels;
  /**
   * The model each (login, harness) was PINNED to the first time it was seen, by {@link pinKey} (the plugin's state, which
   * the adapter reads). A pair in here keeps that model whatever the catalogs say next; one that is not is seen for the
   * first time and starts on what its login's catalog gives (`Derived.firstSeen`). The pin is all that resolution reads once
   * it exists.
   */
  readonly pins?: ReadonlyMap<string, string>;
  /**
   * Set when the pin state exists but could not be read (the file it names). Nothing then says what any derived runtime was
   * pinned to, so every derived runtime is refused: never resolved to the live default, never written over.
   */
  readonly pinsUnreadable?: string;
  /**
   * The model a login launches `harness` with, and the models its catalog offers, resolved through THAT login's catalog (a
   * provider login uses its provider's default, not the harness maker's starter). Absent: only the harness's starter is known.
   */
  readonly launch?: (login: LoginView, harness: HarnessKind) => LaunchModels;
  /**
   * The harnesses installed here, when the caller knows: a login that drives both CLIs then runs the first (Claude first)
   * that is installed, and a login none of whose CLIs is installed gets no runtime. Absent: not known, so the first it drives.
   */
  readonly installed?: readonly HarnessKind[] | undefined;
  /**
   * The environment logins' variable templates by login id; `undefined` when Logins could not give them. An environment
   * login without its templates is NOT derived: the model would hold it as a stand-in, and a runtime on a stand-in is
   * refused (`standInsNamedBy`), so deriving one would block every change to the files while it stood.
   */
  readonly templates?: ReadonlyMap<string, EnvironmentLoginTemplate> | undefined;
}

/** What is derived, to be added beside the explicit files (an entry already there is never in here). */
export interface Derived {
  readonly runtimes: ReadonlyMap<string, RuntimeFile>;
  readonly profiles: ReadonlyMap<string, ProfileFile>;
  readonly modelSets: ReadonlyMap<string, ModelSetFile>;
  /** The (login, harness) pairs with no pin yet and the model each launches with now: what the adapter records as their pin. */
  readonly firstSeen: ReadonlyMap<string, string>;
  /** The derived runtimes that may not launch, by name, with why (a pinned model no catalog offers, or pins nobody could read). */
  readonly refused: ReadonlyMap<string, string>;
}

/** The key a pin is kept under: its login's id and its harness. A login that is removed takes its pins with it. */
export const pinKey = (login: string, harness: HarnessKind): string => `${harness}:${login}`;

/** The login a pin key belongs to, or `undefined` for a key that is no pin's (it is pruned with the stale ones). */
export const loginOfPinKey = (key: string): string | undefined => {
  const at = key.indexOf(':');
  return at <= 0 || !supportedKinds().some(kind => kind === key.slice(0, at)) ? undefined : key.slice(at + 1);
};

/** The sentence a pinned model that nothing offers any more is refused with. */
export const pinGoneSentence = (model: string, login: string): string =>
  `${model} is no longer offered for ${login}; pick a model or use Update now`;

/** The sentence every derived runtime is refused with while the pin state cannot be read. */
const pinsUnreadableSentence = (file: string): string => `model pins unreadable: ${file}`;

/**
 * Why a runtime of this login may not launch on its pin, or `undefined` when it may: the pin state could not be read, or the
 * pinned model is one the login's catalog no longer offers. Never "fall back": the answer is a refusal.
 */
export function pinRefusal(
  login: string,
  pin: string | undefined,
  offered: readonly string[] | undefined,
  unreadable: string | undefined,
): string | undefined {
  if (unreadable !== undefined) return pinsUnreadableSentence(unreadable);
  return pin !== undefined && offered !== undefined && !offered.includes(pin) ? pinGoneSentence(pin, login) : undefined;
}

/** The profile and model set a derived runtime of a harness uses. */
const defaultProfileName = (harness: HarnessKind): string => `ferretry-${harness}`;

/** A login a person can start a ferret on now: signed in (or about to be refreshed). A key or endpoint is usable too. */
const usable = (login: LoginView): boolean => login.status.word !== 'needs_sign_in';

/**
 * The CLI a login's derived runtime runs: the first it drives (Claude first) that is installed here. `undefined` when the
 * installed set is KNOWN and none of them is installed: no runtime is derived for it (the login says which CLI it needs), so
 * a ferret is never offered a runtime whose CLI is absent. When the installed set is not known, the first it drives.
 */
function harnessToRun(login: LoginView, installed: readonly HarnessKind[] | undefined): HarnessKind | undefined {
  // A harness Runtimes has no behaviour for is skipped here: a login that drives only that one derives no runtime, and is never
  // handed Claude's.
  const drives = login.harnesses.flatMap(key => supportedKindOfKey(key) ?? []);
  if (installed === undefined) return drives[0] ?? supportedKindOfKey(login.harness);
  return drives.find(harness => installed.includes(harness));
}

/** The longest a runtime name may be (`RuntimeNameSchema`). */
const MAX_NAME = 64;

/** Five lowercase base-36 characters from a 32-bit FNV-1a of `text`: short, stable, and the same on every machine. */
export function stableSuffix(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(5, '0').slice(-5);
}

/**
 * The name a login's runtime gets, a pure function of THAT login's own id and of what is already named: the login's id when
 * nothing holds it, else `<id>-<suffix>` where the suffix is derived from the id alone. Nothing about any OTHER login enters
 * it, so adding or deleting a login never renames (or re-points) the name of another: a saved reference to a runtime whose
 * login is gone finds no runtime, rather than a different login's. `undefined` when the id is no valid runtime name, or when
 * the suffixed name is taken too (the login then has no derived runtime; the owner can make one under Advanced).
 */
export function derivedRuntimeName(id: string, isTaken: (name: string) => boolean): string | undefined {
  if (!isRuntimeName(id)) return undefined;
  if (!isTaken(id)) return id;
  const suffixed = `${id.slice(0, MAX_NAME - 6)}-${stableSuffix(id)}`;
  return isRuntimeName(suffixed) && !isTaken(suffixed) ? suffixed : undefined;
}

export function deriveRuntimes(from: DerivedFrom): Derived {
  const runtimes = new Map<string, RuntimeFile>();
  const profiles = new Map<string, ProfileFile>();
  const modelSets = new Map<string, ModelSetFile>();
  // The built-in profiles and model sets are ALWAYS here (an explicit one of the same name wins), never only while a runtime is
  // derived: a runtime the owner saves from Advanced on a preset must not dangle the moment its login stops being derived.
  for (const harness of supportedKinds()) {
    const wanted = defaultProfileName(harness);
    if (!from.profiles.has(wanted))
      profiles.set(wanted, {
        contents: [...builtinProfileLayers(harness, from.starters ?? NO_STARTERS)],
      } as ProfileFile);
    const starter = starterModelSet(harness, from.starters ?? NO_STARTERS);
    if (starter !== undefined && !from.modelSets.has(wanted)) modelSets.set(wanted, starter as ModelSetFile);
  }
  const firstSeen = new Map<string, string>();
  const refused = new Map<string, string>();
  const taken = new Set([...from.runtimes.values()].map(runtime => runtime.login as string));
  // Every login's id is a name that login owns (derived, or held by the owner's runtime on it), so a suffixed name never takes one.
  const loginIds = new Set(from.logins.map(login => login.id as string));
  const wanting = from.logins.filter(
    login =>
      usable(login) &&
      !taken.has(login.id as string) &&
      (login.store !== 'environment' || from.templates?.get(login.id as string)?.kind === 'templates'),
  );
  for (const login of wanting) {
    const id = login.id as string;
    const harness = harnessToRun(login, from.installed);
    if (harness === undefined) continue;
    const name = derivedRuntimeName(
      id,
      candidate => from.runtimes.has(candidate) || (candidate !== id && loginIds.has(candidate)),
    );
    if (name === undefined) continue;
    // The pin is keyed by the login's id and the harness it runs, and holds the model that login LAUNCHES with (through its
    // own catalog). Once it exists it is the only thing the model is read from.
    const starter = from.starters?.[harness];
    const now = from.launch?.(login, harness) ?? { model: starter, offered: undefined };
    const key = pinKey(id, harness);
    const pin = from.pins?.get(key);
    if (pin === undefined && now.model !== undefined && from.pinsUnreadable === undefined)
      firstSeen.set(key, now.model);
    const model = pin ?? now.model;
    const refusal = pinRefusal(id, pin, now.offered, from.pinsUnreadable);
    if (refusal !== undefined) refused.set(name, refusal);
    // A model other than the harness's starter lives on a profile of its own, so the shared built-in one can follow the
    // catalog for runtimes seen later while this one stays where it was.
    const profile =
      model === undefined || model === starter ? defaultProfileName(harness) : pinnedProfileName(harness, model);
    if (profile !== defaultProfileName(harness) && !from.profiles.has(profile) && model !== undefined) {
      profiles.set(profile, {
        contents: [...builtinProfileLayers(harness, { [harness]: model }, profile)],
      } as ProfileFile);
      modelSets.set(profile, starterModelSet(harness, { [harness]: model }) as ModelSetFile);
    }
    runtimes.set(name, {
      login: id,
      profile,
      // A login that drives both CLIs runs the one chosen here; a one-CLI login's runtime says nothing (its login does).
      ...(login.harnesses.length > 1 ? { harness: harnessKeyOfKind(harness) } : {}),
    } as RuntimeFile);
  }
  return { runtimes, profiles, modelSets, firstSeen, refused };
}

/** The explicit entries with the derived ones beside them; an explicit entry is never replaced. */
export const withDerived = <T>(explicit: ReadonlyMap<string, T>, derived: ReadonlyMap<string, T>): Map<string, T> =>
  new Map([...derived, ...explicit]);
