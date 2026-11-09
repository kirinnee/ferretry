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
import type { AccountModel } from './schema.ts';
import { harnessKeyOfKind } from '../manifest.ts';

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
  });
  for (const [name, runtime] of Object.entries(model.runtimes)) {
    files.set(`runtimes/${name}.yaml`, {
      login: runtime.credential,
      profile: runtime.profile,
      ...(runtime.harness === undefined ? {} : { harness: harnessKeyOfKind(runtime.harness) }),
      ...(runtime.shell === undefined ? {} : { shell: runtime.shell }),
      agent: runtime.agent,
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

/** The kinds whose components another plugin owns and Runtimes cannot write. */
const FOREIGN_COMPONENT_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks'] as const;

/**
 * The components of a kind another plugin owns that `next` adds, changes or drops against `before`, as `kind "name"`.
 * Runtimes cannot write those files, so a change that carries one is refused: it would land in a home and be gone at the
 * next republish, which reads the files.
 */
export function foreignComponentChanges(before: AccountModel, next: AccountModel): readonly string[] {
  const changed: string[] = [];
  for (const kind of FOREIGN_COMPONENT_KINDS) {
    const was: Readonly<Record<string, unknown>> = before.components[kind];
    const now: Readonly<Record<string, unknown>> = next.components[kind];
    for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!same(was[name], now[name])) changed.push(`${kind} "${name}"`);
    }
  }
  return changed.toSorted((left, right) => left.localeCompare(right));
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
