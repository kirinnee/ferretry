/**
 * The edits that move Runtimes' own files from the model in effect to another model: only the keys that changed, never
 * a whole text rendered from what is in effect (docs/config-files.md rule: "every write edits only the changed keys").
 *
 * Today's renderer edited the YAML TEXT of each file in place so the owner's comments survived. A plugin cannot read
 * its own file's text (`ConfigPort` offers values), so this renders PATCHES instead and the kernel's writer applies them
 * to the file it holds, inside its own write queue: a key nobody changed is never touched, so a comment, an unknown
 * future key and a concurrent edit of another key all survive, and the file is created whole when it was not there.
 *
 * Two things follow and are declared: a runtime renamed gets a NEW file written from the model (its comments stay with
 * the old name, which is removed), and a patch carries no etag, so a concurrent edit of the SAME key is overwritten by
 * the change that was reviewed (the reviewed change names the keys it sets, and the proposal's revision is checked first).
 *
 * Pure.
 */
import { type HarnessKind, harnessKeyOfKind } from '../manifest.ts';
import { builtinProfileLayers, pinnedProfileName } from './builtin-autonomous.ts';
import type { AccountModel } from './schema.ts';
import { runtimeHarness } from './scope.ts';

/** One file to write (a patch, created whole when the file is absent) or to remove. */
export interface OwnedFileEdit {
  /** The file's path under `config/`. */
  readonly path: string;
  /** Top-level keys to set; a key whose value is `undefined` is removed. Absent for a removal. */
  readonly patch?: Readonly<Record<string, unknown>>;
  readonly remove?: true;
}

type Body = Readonly<Record<string, unknown>>;

/** The keys of every file the model holds that Runtimes owns, by path. */
export function ownedFileBodies(model: AccountModel): ReadonlyMap<string, Body> {
  const files = new Map<string, Body>();
  files.set('runtimes.yaml', {
    ...(model.machine.defaultRuntime === undefined ? {} : { defaultRuntime: model.machine.defaultRuntime }),
    autoResume: model.machine.autoResume,
    // Written only off its default, so a machine that never set them keeps a file that never names them.
    ...(model.machine.browserPorts === 'random' ? {} : { browserPorts: model.machine.browserPorts }),
    ...(model.machine.browserFirewallFailure === 'warn'
      ? {}
      : { browserFirewallFailure: model.machine.browserFirewallFailure }),
  });
  for (const [name, runtime] of Object.entries(model.runtimes)) {
    files.set(`runtimes/${name}.yaml`, {
      login: runtime.credential,
      profile: runtime.profile,
      ...(runtime.harness === undefined ? {} : { harness: harnessKeyOfKind(runtime.harness) }),
      ...(runtime.shell === undefined ? {} : { shell: runtime.shell }),
      ...(runtime.disabled === undefined ? {} : { disabled: runtime.disabled }),
      ...(runtime.compactAt === undefined ? {} : { compactAt: runtime.compactAt }),
      ...(runtime.clonedFromKey === undefined ? {} : { clonedFromKey: runtime.clonedFromKey }),
    });
  }
  for (const [name, profile] of Object.entries(model.profiles)) {
    files.set(`profiles/${name}.yaml`, {
      contents: [...profile.layers],
      ...(profile.compactAt === undefined ? {} : { compactAt: profile.compactAt }),
      ...(profile.clonedFromKey === undefined ? {} : { clonedFromKey: profile.clonedFromKey }),
    });
  }
  // Instructions are Runtimes' own kind: the text lives in the item itself (`config/instructions/<name>.yaml`).
  for (const [name, instructions] of Object.entries(model.components.instructions)) {
    if (instructions.text === undefined) continue;
    files.set(`instructions/${name}.yaml`, {
      text: instructions.text,
      ...(instructions.harness === undefined ? {} : { harness: harnessKeyOfKind(instructions.harness) }),
      ...(instructions.clonedFrom === undefined ? {} : { clonedFrom: instructions.clonedFrom }),
      ...(instructions.clonedFromDaemon === undefined ? {} : { clonedFromDaemon: instructions.clonedFromDaemon }),
      ...(instructions.clonedFromKey === undefined ? {} : { clonedFromKey: instructions.clonedFromKey }),
    });
  }
  for (const [name, set] of Object.entries(model.components.modelSets)) {
    files.set(`model-sets/${name}.yaml`, {
      models: [...set.models],
      default: set.default,
      ...(set.clonedFrom === undefined ? {} : { clonedFrom: set.clonedFrom }),
      ...(set.clonedFromDaemon === undefined ? {} : { clonedFromDaemon: set.clonedFromDaemon }),
      ...(set.clonedFromKey === undefined ? {} : { clonedFromKey: set.clonedFromKey }),
    });
  }
  return files;
}

/** The machine settings Runtimes' own `runtimes.yaml` holds (see {@link ownedFileBodies}); every other one has no file here. */
const OWNED_MACHINE_KEYS: ReadonlySet<string> = new Set([
  'defaultRuntime',
  'autoResume',
  'browserPorts',
  'browserFirewallFailure',
]);

/**
 * The parts of the model `next` moves that no file of Runtimes holds: a machine setting other than the default runtime,
 * auto-resume and the two loopback-port settings (agent permissions, what agents may control, browser mode and proxy,
 * agenda mode, the usage feed, the time zone) and the `advanced` block. {@link ownedFileEdits} renders none of them, so a change carrying one would be reported
 * as applied and save nothing, while the homes it published were built from a model that was never saved (a permission
 * mode loosened with no owner hold). Such a change is refused instead.
 */
export function unownedChanges(before: AccountModel, next: AccountModel): readonly string[] {
  const machine: Readonly<Record<string, unknown>> = before.machine;
  const nextMachine: Readonly<Record<string, unknown>> = next.machine;
  const changed = [...new Set([...Object.keys(machine), ...Object.keys(nextMachine)])]
    .filter(key => !OWNED_MACHINE_KEYS.has(key) && !same(machine[key], nextMachine[key]))
    .map(key => `the machine setting ${key}`);
  if (!same(before.advanced, next.advanced)) changed.push('the advanced settings');
  return changed.toSorted((left, right) => left.localeCompare(right));
}

/** The kinds whose components another plugin owns and Runtimes cannot write (`instructions` are Runtimes' own). */
const FOREIGN_COMPONENT_KINDS = ['mcp', 'skills', 'settings', 'hooks'] as const;

/**
 * The components of a kind another plugin owns that `next` adds, changes or drops against `before`, as `kind "name"`.
 * Runtimes cannot write those files, so a change that carries one is refused: it would land in a home and be gone at the
 * next republish, which reads the files.
 */
export function foreignComponentChanges(before: AccountModel, next: AccountModel): readonly string[] {
  return foreignComponentRefs(before, next)
    .map(({ kind, name }) => `${kind} "${name}"`)
    .toSorted((left, right) => left.localeCompare(right));
}

/** The same components as {@link foreignComponentChanges}, as kind and name (the setup import hands them to their owners). */
export function foreignComponentRefs(
  before: AccountModel,
  next: AccountModel,
): readonly { readonly kind: (typeof FOREIGN_COMPONENT_KINDS)[number]; readonly name: string }[] {
  const changed: { kind: (typeof FOREIGN_COMPONENT_KINDS)[number]; name: string }[] = [];
  for (const kind of FOREIGN_COMPONENT_KINDS) {
    const was: Readonly<Record<string, unknown>> = before.components[kind];
    const now: Readonly<Record<string, unknown>> = next.components[kind];
    for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!same(was[name], now[name])) changed.push({ kind, name });
    }
  }
  return changed;
}

/** A value's identity for comparison: the same keys in any order are the same value. */
function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * The edits that move the files from `before` to `next`: each file whose keys differ gets a patch of exactly those keys
 * (a key `next` no longer has is removed), a file `next` has and `before` did not is written whole, and a file `before`
 * had and `next` no longer has is removed. The singleton `runtimes.yaml` is never removed.
 */
export function ownedFileEdits(before: AccountModel, next: AccountModel): readonly OwnedFileEdit[] {
  const was = ownedFileBodies(before);
  const now = ownedFileBodies(next);
  const edits: OwnedFileEdit[] = [];
  for (const [path, body] of now) {
    const old = was.get(path);
    if (old === undefined) {
      edits.push({ path, patch: body });
      continue;
    }
    const patch: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(body)])) {
      if (!same(old[key], body[key])) patch[key] = body[key];
    }
    if (Object.keys(patch).length > 0) edits.push({ path, patch });
  }
  for (const path of was.keys()) {
    if (!now.has(path) && path !== 'runtimes.yaml') edits.push({ path, remove: true });
  }
  return edits;
}

/** What a change needs to know about the runtimes that exist only because they are derived (`RuntimesModel.derived`). */
export interface DerivedAtSave {
  readonly runtimes: ReadonlySet<string>;
  /** The profiles that exist only because they are generated (the built-in ones and the pinned ones no file holds). */
  readonly profiles: ReadonlySet<string>;
  readonly pinnedModelOf: (login: string, harness: HarnessKind) => string | undefined;
  readonly refusedFor: (login: string, harness: HarnessKind) => string | undefined;
}

/**
 * {@link ownedFileEdits} for a model whose derived runtimes are not on disk. A derived runtime that is saved (edited, or
 * renamed) is written WHOLE, because no file of it exists to patch, and it never keeps a reference to a GENERATED profile:
 * that profile follows the live catalog (or is not there once nothing derives it), so the saved runtime would move on its
 * own or dangle. It is written onto a REAL profile and model set holding the pinned model, so the file launches the model the
 * runtime had. A derived runtime that is refused cannot be saved on its generated profile at all: `refused` says why.
 */
export function realisedEdits(
  before: AccountModel,
  next: AccountModel,
  derived: DerivedAtSave,
): { readonly edits: readonly OwnedFileEdit[]; readonly refused: readonly string[] } {
  const edits = new Map(ownedFileEdits(before, next).map(edit => [edit.path, edit]));
  const bodies = ownedFileBodies(next);
  const refused: string[] = [];
  for (const [name, runtime] of Object.entries(next.runtimes)) {
    const path = `runtimes/${name}.yaml`;
    const edit = edits.get(path);
    const body = bodies.get(path);
    if (edit?.patch === undefined || body === undefined) continue;
    // A derived runtime has no file: whatever is written is its whole body.
    const whole = derived.runtimes.has(name) ? body : { ...edit.patch };
    const profile = typeof whole.profile === 'string' ? whole.profile : undefined;
    if (profile === undefined || !derived.profiles.has(profile)) {
      edits.set(path, { path, patch: whole });
      continue;
    }
    const harness = runtimeHarness(next, runtime);
    const model = harness === undefined ? undefined : derived.pinnedModelOf(runtime.credential as string, harness);
    const why = harness === undefined ? undefined : derived.refusedFor(runtime.credential as string, harness);
    if (why !== undefined) refused.push(`${name}: ${why}`);
    if (harness === undefined || model === undefined) {
      edits.set(path, { path, patch: whole });
      continue;
    }
    const real = pinnedProfileName(harness, model);
    edits.set(path, { path, patch: { ...whole, profile: real } });
    // The real profile and model set are written unless an explicit file of that name is already there.
    const held = before.profiles[real] !== undefined && !derived.profiles.has(real);
    if (!held) {
      const profilePath = `profiles/${real}.yaml`;
      const setPath = `model-sets/${real}.yaml`;
      edits.set(profilePath, {
        path: profilePath,
        patch: { contents: [...builtinProfileLayers(harness, { [harness]: model }, real)] },
      });
      edits.set(setPath, { path: setPath, patch: { models: [model], default: model } });
    }
  }
  return { edits: [...edits.values()], refused };
}
