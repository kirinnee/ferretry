/**
 * The preview carries each v4 `config/logins/<id>.yaml` as an empty, SIGNED-OUT shell, so every runtime that names a
 * login still finds it (a runtime whose login is missing makes the whole fleet configuration unreadable, in v4 and in
 * 5.0 alike) and shows "Needs sign-in" exactly like a signed-out v4 login.
 *
 * A shell holds only: `harness`, `store`, `label`, `preset` and `env` (and the same `env` of each harness half of an
 * environment login). Nothing else of the file travels (budget, disabled, clonedFrom*, cloudCredential, codexProvider),
 * and `fleet/credentials` (the sign-in itself) stays denied by the plan. `store: host` is written as `store: ferretry`:
 * the preview's HOME is empty by design, so a host login would find no sign-in to share. This is the PREVIEW only; the
 * real converter keeps `store: host`. An env value that is a plain key never reaches the shell: the Settings step parks
 * it (`takeLoginKeys`) and the file names `${secret:NAME}`; the preview then discards the parked value
 * (`loginKeysStep`) and its vault stays empty, so the owner stores the secret with `fy secret set NAME`.
 * A Codex login is not carried while Codex is held (`holdsCodex`).
 */
import { isMap, isScalar, type Document, type YAMLMap } from 'yaml';

/** The only top-level keys a shell keeps. */
export const SHELL_KEYS: ReadonlySet<string> = new Set([
  'harness',
  'store',
  'label',
  'preset',
  'env',
  'claude',
  'codex',
]);

/** What the shell kept of one login file, as field NAMES (never values). */
export type LoginShell =
  | { readonly kind: 'carried'; readonly removed: readonly string[]; readonly storeMoved: boolean }
  /** Not carried: a Codex login while Codex is held, or one whose harness is not named. */
  | { readonly kind: 'held'; readonly harness: 'codex' | 'unknown' };

const keyOf = (pair: { key: unknown }): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);

/**
 * Reduces a v4 login document, in place, to its shell. Reads the harness and store scalars and drops every other key;
 * no value outside the kept keys is looked at.
 */
export function loginShell(document: Document, holdCodex: boolean): LoginShell {
  const map = document.contents;
  if (!isMap(map)) return { kind: 'held', harness: 'unknown' };
  const scalar = (key: string): unknown => {
    const pair = map.items.find(item => keyOf(item) === key);
    return isScalar(pair?.value) ? pair.value.value : undefined;
  };
  const harness = scalar('harness');
  const isCodex = harness === 'codex';
  if (harness !== 'claude' && harness !== 'claude-code' && !isCodex) return { kind: 'held', harness: 'unknown' };
  if (isCodex && holdCodex) return { kind: 'held', harness: 'codex' };

  const removed: string[] = [];
  map.items = map.items.filter(pair => {
    const key = keyOf(pair);
    if (typeof key === 'string' && SHELL_KEYS.has(key) && !(key === 'codex' && holdCodex)) return true;
    removed.push(typeof key === 'string' ? key : '<key>');
    return false;
  });
  // A harness half keeps its `env` only (not its Codex provider).
  for (const half of ['claude', 'codex']) {
    const pair = map.items.find(item => keyOf(item) === half);
    if (pair === undefined || !isMap(pair.value)) continue;
    const inner: YAMLMap = pair.value;
    inner.items = inner.items.filter(item => {
      const keep = keyOf(item) === 'env';
      if (!keep) removed.push(`${half}.${String(keyOf(item))}`);
      return keep;
    });
  }
  const store = map.items.find(item => keyOf(item) === 'store');
  const storeMoved = isScalar(store?.value) && store.value.value === 'host';
  if (storeMoved && isScalar(store?.value)) store.value.value = 'ferretry';
  return { kind: 'carried', removed, storeMoved };
}
