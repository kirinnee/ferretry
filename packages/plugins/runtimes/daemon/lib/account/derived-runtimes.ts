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
 * A name that is taken (an owner runtime, or another login's) gets `-2`, `-3`...; logins are settled in id order so a name
 * is the same on every read.
 *
 * Pure: no filesystem, no clock.
 */
import type { EnvironmentLoginTemplate, LoginView } from '@ferretry/plugin-logins/contract';
import type { ModelSetFile, ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { builtinProfileLayers, starterModelSet } from './builtin-autonomous.ts';
import { type HarnessKind, harnessKeyOfKind, harnessKindOfKey } from '../manifest.ts';
import { isRuntimeName } from './schema.ts';

/** What the explicit files already hold, by name. */
export interface DerivedFrom {
  readonly runtimes: ReadonlyMap<string, RuntimeFile>;
  readonly profiles: ReadonlyMap<string, ProfileFile>;
  readonly modelSets: ReadonlyMap<string, ModelSetFile>;
  readonly logins: readonly LoginView[];
  /**
   * The harnesses installed here, when the caller knows: a login that drives both CLIs then runs the first (Claude first)
   * that is installed. Absent: the first it drives. A runtime whose CLI is missing is still derived and says so
   * ("isn't installed here"): it waits for the install, as a copied one does.
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
}

/** The profile and model set a derived runtime of a harness uses. */
const defaultProfileName = (harness: 'claude' | 'codex'): string => `ferretry-${harness}`;

/** A login a person can start a ferret on now: signed in (or about to be refreshed). A key or endpoint is usable too. */
const usable = (login: LoginView): boolean => login.status.word !== 'needs_sign_in';

/** The CLI a login's derived runtime runs: the first it drives (Claude first) that is installed, else the first it drives. */
function harnessToRun(login: LoginView, installed: readonly HarnessKind[] | undefined): HarnessKind {
  const drives = login.harnesses.map(harnessKindOfKey);
  return drives.find(harness => installed?.includes(harness) === true) ?? drives[0] ?? harnessKindOfKey(login.harness);
}

/**
 * The name a login's runtime gets: the login's own id, else `<id>-2`, `<id>-3`... the first that is free. `isFree` is asked
 * about each candidate, so a name the owner or another login holds is never taken. `undefined` when no candidate is a valid
 * runtime name (a login id the grammar refuses cannot be made valid by a suffix).
 */
export function freeRuntimeName(id: string, isFree: (name: string) => boolean): string | undefined {
  if (!isRuntimeName(id)) return undefined;
  if (isFree(id)) return id;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${id}-${String(n)}`;
    if (isRuntimeName(candidate) && isFree(candidate)) return candidate;
  }
  return undefined;
}

export function deriveRuntimes(from: DerivedFrom): Derived {
  const runtimes = new Map<string, RuntimeFile>();
  const profiles = new Map<string, ProfileFile>();
  const modelSets = new Map<string, ModelSetFile>();
  // The built-in profiles and model sets are ALWAYS here (an explicit one of the same name wins), never only while a runtime is
  // derived: a runtime the owner saves from Advanced on a preset must not dangle the moment its login stops being derived.
  for (const harness of ['claude', 'codex'] as const) {
    const wanted = defaultProfileName(harness);
    if (!from.profiles.has(wanted))
      profiles.set(wanted, { contents: [...builtinProfileLayers(harness)] } as ProfileFile);
    if (!from.modelSets.has(wanted)) modelSets.set(wanted, starterModelSet(harness) as ModelSetFile);
  }
  const taken = new Set([...from.runtimes.values()].map(runtime => runtime.login as string));
  // In login-id order, so a clash is settled the same way on every read whatever order the logins are listed in.
  const wanting = from.logins
    .filter(
      login =>
        usable(login) &&
        !taken.has(login.id as string) &&
        (login.store !== 'environment' || from.templates?.get(login.id as string)?.kind === 'templates'),
    )
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // A login whose own id is free is named by it, so another login's suffixed name never takes it.
  const plainIds = new Set(wanting.map(login => login.id as string).filter(id => !from.runtimes.has(id)));
  const claimed = new Set<string>();
  for (const login of wanting) {
    const id = login.id as string;
    const name = freeRuntimeName(
      id,
      candidate =>
        !from.runtimes.has(candidate) && !claimed.has(candidate) && (candidate === id || !plainIds.has(candidate)),
    );
    if (name === undefined) continue;
    claimed.add(name);
    const harness = harnessToRun(login, from.installed);
    runtimes.set(name, {
      login: id,
      profile: defaultProfileName(harness),
      // A login that drives both CLIs runs the one chosen here; a one-CLI login's runtime says nothing (its login does).
      ...(login.harnesses.length > 1 ? { harness: harnessKeyOfKind(harness) } : {}),
    } as RuntimeFile);
  }
  return { runtimes, profiles, modelSets };
}

/** The explicit entries with the derived ones beside them; an explicit entry is never replaced. */
export const withDerived = <T>(explicit: ReadonlyMap<string, T>, derived: ReadonlyMap<string, T>): Map<string, T> =>
  new Map([...derived, ...explicit]);
