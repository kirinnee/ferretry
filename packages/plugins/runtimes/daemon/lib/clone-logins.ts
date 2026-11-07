import type { CloneCredential } from '../../contract/index.ts';

/**
 * How a copy settles each sign-in the source carries (docs/design/account-model.md L2). ONE rule, owned here
 * so the daemon's planner and the app's Done screen cannot disagree about which login a sign-in became.
 * Pure: it reads descriptors (ids, harness, email, label) and never a token.
 */

/** The part of a login on the target that a source sign-in is matched against. */
export interface CloneTargetLogin {
  readonly id: string;
  readonly harness: CloneCredential['harness'];
  /** `environment` for an API-key login, which never matches. */
  readonly store?: string | undefined;
  readonly email?: string | undefined;
  readonly label?: string | undefined;
}

/** The part of a source sign-in the match reads. */
export type CloneSourceLogin = Pick<CloneCredential, 'id' | 'harness' | 'label' | 'email' | 'store'>;

/** Which of the target's own sign-ins could be the one a source sign-in is. */
export type CloneSignInMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly id: string }
  | { readonly kind: 'many'; readonly ids: readonly string[] };

const normalEmail = (email: string | undefined): string | undefined => email?.trim().toLowerCase();

/**
 * The login the target already has for a source sign-in, never by token, secret name or file. Only a sign-in
 * of the SAME harness counts, and an API-key (environment) login never does: it is config and copies. A pair
 * matches by account email, case-insensitive; when neither side has an email, by label, exactly. A login with
 * an email never matches one without. Two or more fits are `many`: no silent pick.
 */
export function matchCloneSignIn(
  source: Pick<CloneCredential, 'harness' | 'label' | 'email'>,
  targets: readonly CloneTargetLogin[],
): CloneSignInMatch {
  const email = normalEmail(source.email);
  const ids = targets
    .filter(login => {
      if (login.store === 'environment' || login.harness !== source.harness) return false;
      const own = normalEmail(login.email);
      if (email !== undefined || own !== undefined) return email !== undefined && email === own;
      return source.label !== undefined && login.label === source.label;
    })
    .map(login => login.id)
    .toSorted();
  const [first] = ids;
  if (first === undefined) return { kind: 'none' };
  return ids.length === 1 ? { kind: 'one', id: first } : { kind: 'many', ids };
}

/** `name`, else `name-2`, `name-3`, … : the first the target has not taken. */
export function freeCloneName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let index = 2; ; index += 1) {
    const candidate = `${name}-${String(index)}`;
    if (!taken(candidate)) return candidate;
  }
}

/** What became of one source login: matched to a login the target has, or given a new id. */
export type CloneLoginTarget =
  | { readonly kind: 'matched'; readonly id: string }
  | {
      /** A new login under `id` (the source's id, or `-2`…). `candidates` is set when two or more fit (`ask`). */
      readonly kind: 'new';
      readonly id: string;
      readonly candidates?: readonly string[];
    };

/**
 * Settle every source login in the bundle's order, against the target's logins as they were BEFORE the copy.
 * A matched sign-in is reused as it is; any other takes a free id, an API-key login included, and an id one
 * source login took is not offered to the next.
 */
export function planCloneLogins(
  sources: readonly CloneSourceLogin[],
  targets: readonly CloneTargetLogin[],
): ReadonlyMap<string, CloneLoginTarget> {
  const taken = new Set(targets.map(login => login.id));
  const settled = new Map<string, CloneLoginTarget>();
  for (const source of sources) {
    const match = source.store === 'environment' ? ({ kind: 'none' } as const) : matchCloneSignIn(source, targets);
    if (match.kind === 'one') {
      settled.set(source.id, { kind: 'matched', id: match.id });
      continue;
    }
    const id = freeCloneName(source.id, candidate => taken.has(candidate));
    taken.add(id);
    settled.set(source.id, { kind: 'new', id, ...(match.kind === 'many' ? { candidates: match.ids } : {}) });
  }
  return settled;
}
