/**
 * A repeat copy: what a copy from a machine this one already copied from would change here
 * (docs/design/account-model.md §3.8 L1/L4, docs/cross-daemon.md §3).
 *
 * Three versions of every item meet: **theirs** (what the source holds now), **mine** (what this machine
 * holds now) and the **base** (what the source held at the last copy, `./clone-base.ts`). The outcome
 * follows from which two agree:
 *
 * | mine = theirs | same — hidden, counted, never written                         |
 * | theirs = base | **mine**: changed here, kept                                   |
 * | mine = base   | **theirs**: changed on the source, taken by default            |
 * | otherwise     | **both**: changed on both sides — NOTHING is chosen for the person |
 *
 * An item with no counterpart here is **new** (or **removed-here** when it was copied before and has gone
 * since — never silently brought back); one only here that the source dropped is **gone** (kept unless
 * the person removes it, and only when nothing here uses it).
 *
 * ## Pairing
 *
 * An item is paired by origin key first. A key two items here claim pairs neither, and the review says
 * why. Without a key, an item is paired by name — the same source, and the source's name or that name
 * plus `-N` — and a pairing by name is labelled `probable`: equal content links it silently, differing
 * content is `both` because there is no base to say which side moved. Two candidates pair nothing: the
 * item is new, unticked, and says what it may already be.
 *
 * ## What an update never touches
 *
 * **A login is never written.** An update, an alongside copy and a replace may point a runtime at a login
 * or add an empty slot; none may change, empty, re-point or remove an existing login's sign-in, tokens,
 * secret entries, `${secret:NAME}` values, defaults or factors (§14.4). So this module never reads or
 * writes a credential entry that exists, and a link to one is recorded in the base record, not on it.
 *
 * Pure: a model, a bundle, a record and the documents on both sides in; an analysis, a review and a plan
 * out. Reading and writing is the setup service's.
 */
import {
  CLONE_OUTCOME_CHOICES,
  CLONE_REVIEW_STALE,
  CLONE_SKILLS_DIRECTORY,
  type CloneChoice,
  type CloneDecisions,
  type CloneLoginChoices,
  type CloneMatch,
  type CloneOutcome,
  type CloneReviewItem,
  type CloneReviewKind,
  type CloneReviewLogin,
  type CloneRunnable,
  cloneItemDigest,
  cloneRunnables,
  type FleetCloneBundle,
  type FleetCloneFile,
  type FleetCloneReview,
  secretReferencesIn,
  sha256Hex,
} from '@ferretry/protocol';
import type { HarnessKind } from '../manifest.ts';
import { canonicalAssetReference } from '../paths.ts';
import {
  type CloneBase,
  type CloneBaseEntry,
  type CloneBaseSource,
  type CloneSourceIdentity,
  cloneBaseEntries,
  cloneOriginKeys,
} from './clone-base.ts';
import {
  bundleModel,
  CloneRefusal,
  HOME_PATH,
  isAssetRelative,
  type MutableComponents,
  movedFile,
  movedFolder,
  movedUnderFolder,
  referencedFiles,
} from './clone-parts.ts';
import { freeName } from './import.ts';
import {
  type AccountModel,
  COMPONENT_KINDS,
  type ComponentKind,
  type Credential,
  type LayeredProfile,
  parseAccountModel,
  type Runtime,
} from './schema.ts';
import { runtimeHarness } from './scope.ts';

type ItemKind = ComponentKind | 'profile' | 'runtime';
type Value = Readonly<Record<string, unknown>>;

/** One item on either side. */
interface Entry {
  /** `<kind>/<name>`, `profile/<name>`, `runtime/<name>`. */
  readonly ref: string;
  readonly kind: ItemKind;
  readonly name: string;
  readonly value: Value;
}

const isRecord = (value: unknown): value is Value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** An asset path in its plain spelling (`./a//b/` → `a/b`). */
const plain = (path: string): string => canonicalAssetReference(path).replace(/\/+$/u, '');

/** What a document the source could not carry stands for on both sides, so it is never read as a change. */
const NOT_CARRIED = '\u0000not carried';

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

/** Which login here each login the source carries uses, before the person is asked about the rest. */
export interface CloneLoginResolution {
  /** Source login id → the login here it is. */
  readonly matched: ReadonlyMap<string, string>;
  /** Source login id → the logins here it could be, when more than one could. */
  readonly ask: ReadonlyMap<string, readonly string[]>;
}

export interface CloneUpdateInput {
  readonly target: AccountModel;
  /** The source's bundle, accepted by `parseCloneBundle`. */
  readonly bundle: FleetCloneBundle;
  /** The target's name, for the sentences. */
  readonly machine: string;
  /** The source as the person names it. */
  readonly sourceName?: string;
  readonly source?: CloneSourceIdentity;
  /** What the record holds of this source, or none. */
  readonly base?: CloneBaseSource;
  /** The documents this machine holds for its own items, by path in the asset tree. */
  readonly targetFiles: readonly FleetCloneFile[];
  readonly logins: CloneLoginResolution;
  /** The harnesses installed here. */
  readonly installed: readonly HarnessKind[];
  /** Skill items the store here already holds. */
  readonly existingSkillItems: readonly string[];
  /** Secret names the store here holds. */
  readonly existingSecrets: readonly string[];
  /** The instant the review is made, for `source.lastCopiedAt`-style sentences. Never in the fingerprint. */
  readonly sourceDaemon?: string;
}

export interface CloneUpdateChoices {
  readonly decisions: CloneDecisions;
  readonly logins?: CloneLoginChoices;
}

// ── The analysis ─────────────────────────────────────────────────────────────────────────────────

interface Analysed {
  /** As it is called here: the paired item's name, or the name a new one would land with. */
  readonly ref: string;
  readonly kind: ItemKind;
  readonly outcome: CloneOutcome | 'same';
  readonly match: CloneMatch;
  readonly source?: Entry;
  readonly target?: Entry;
  readonly key?: string;
  readonly note?: string;
  readonly fields: readonly string[];
  readonly files: readonly CloneReviewItem['files'][number][];
  /** Matched by name with the same content: linked, and the link is stamped on apply. */
  readonly stamp: boolean;
  /** Written into the fingerprint. */
  readonly digests: readonly [string, string, string];
  /** Anything here that uses a `gone` item and so stops it being removed. */
  readonly usedBy: readonly string[];
  readonly ambiguous: boolean;
}

export interface CloneAnalysis {
  readonly input: CloneUpdateInput;
  readonly items: readonly Analysed[];
  readonly same: { readonly count: number; readonly probable: number };
  readonly logins: readonly CloneReviewLogin[];
  /** What each item does when nothing is decided. Absent for `both`. */
  readonly defaults: ReadonlyMap<string, CloneChoice>;
  /** Each item's ref → the refs it needs written alongside. */
  readonly needs: ReadonlyMap<string, readonly string[]>;
  readonly fingerprint: string;
  readonly keys: ReadonlyMap<string, string>;
}

const itemsOfModel = (model: AccountModel): Entry[] => [
  ...COMPONENT_KINDS.flatMap(kind =>
    Object.entries(model.components[kind] as Readonly<Record<string, Value>>).map(([name, value]) => ({
      ref: `${kind}/${name}`,
      kind,
      name,
      value,
    })),
  ),
  ...Object.entries(model.profiles).map(([name, value]) => ({
    ref: `profile/${name}`,
    kind: 'profile' as const,
    name,
    value: value as unknown as Value,
  })),
  ...Object.entries(model.runtimes).map(([name, value]) => ({
    ref: `runtime/${name}`,
    kind: 'runtime' as const,
    name,
    value: value as unknown as Value,
  })),
];

const itemsOfBundle = (bundle: FleetCloneBundle): Entry[] => [
  ...COMPONENT_KINDS.flatMap(kind =>
    Object.entries(bundle.components[kind] ?? {}).flatMap(([name, value]) =>
      isRecord(value) ? [{ ref: `${kind}/${name}`, kind, name, value }] : [],
    ),
  ),
  ...Object.entries(bundle.profiles).flatMap(([name, value]) =>
    isRecord(value) ? [{ ref: `profile/${name}`, kind: 'profile' as const, name, value }] : [],
  ),
  ...Object.entries(bundle.runtimes).flatMap(([name, value]) =>
    isRecord(value) ? [{ ref: `runtime/${name}`, kind: 'runtime' as const, name, value }] : [],
  ),
];

/** Whether an item here says it came from this source. A name is only what a machine says; the id is checked when there is one. */
function fromSource(value: Value, source: CloneSourceIdentity | undefined, machine: string): boolean {
  // Profiles and runtimes carry only the link, never the source: the key (checked) is all they say.
  if (!('clonedFrom' in value) && !('clonedFromDaemon' in value)) return true;
  const daemon = value.clonedFromDaemon;
  if (typeof daemon === 'string') return source !== undefined && daemon === source.id;
  return value.clonedFrom === machine;
}

/** The name an item of this source has here when it was copied before and landed beside another: `notes`, `notes-2`. */
const sameName = (here: string, theirs: string): boolean =>
  here === theirs || (here.startsWith(`${theirs}-`) && /^\d+$/u.test(here.slice(theirs.length + 1)));

interface Pairing {
  /** Source ref → the item here. */
  readonly paired: Map<string, { readonly target: Entry; readonly match: 'key' | 'probable' }>;
  /** Source ref → the items here that might be it. */
  readonly ambiguous: Map<string, { readonly candidates: readonly Entry[]; readonly claimed: boolean }>;
  /** Items here that say they are copies of an item of this source that it does not hold now. */
  readonly leftover: readonly Entry[];
}

function pair(
  sources: readonly Entry[],
  targets: readonly Entry[],
  keys: ReadonlyMap<string, string>,
  source: CloneSourceIdentity | undefined,
  machine: string,
): Pairing {
  const paired = new Map<string, { target: Entry; match: 'key' | 'probable' }>();
  const ambiguous = new Map<string, { candidates: readonly Entry[]; claimed: boolean }>();
  const linked = new Set<string>();

  const claims = new Map<string, Entry[]>();
  for (const target of targets) {
    const key = target.value.clonedFromKey;
    if (typeof key !== 'string' || !fromSource(target.value, source, machine)) continue;
    claims.set(key, [...(claims.get(key) ?? []), target]);
  }
  const heldKeys = new Set<string>();
  for (const entry of sources) {
    const key = keys.get(entry.ref);
    if (key === undefined) continue;
    heldKeys.add(key);
    const claimants = (claims.get(key) ?? []).filter(target => target.kind === entry.kind);
    if (claimants.length === 1 && claimants[0] !== undefined) {
      paired.set(entry.ref, { target: claimants[0], match: 'key' });
      linked.add(claimants[0].ref);
    } else if (claimants.length > 1) {
      ambiguous.set(entry.ref, { candidates: claimants, claimed: true });
    }
  }

  // By name: only what has no link, from the same source.
  const pool = targets.filter(target => !linked.has(target.ref) && fromSource(target.value, source, machine));
  const candidatesOf = new Map<string, Entry[]>();
  for (const entry of sources) {
    if (paired.has(entry.ref)) continue;
    const found = ambiguous.get(entry.ref)?.candidates ?? [
      ...pool.filter(target => target.kind === entry.kind && sameName(target.name, entry.name)),
    ];
    if (found.length > 0) candidatesOf.set(entry.ref, found as Entry[]);
  }
  const wanted = new Map<string, number>();
  for (const found of candidatesOf.values()) {
    for (const target of found) wanted.set(target.ref, (wanted.get(target.ref) ?? 0) + 1);
  }
  for (const [ref, found] of candidatesOf) {
    const only = found[0];
    if (
      ambiguous.get(ref)?.claimed !== true &&
      found.length === 1 &&
      only !== undefined &&
      wanted.get(only.ref) === 1
    ) {
      paired.set(ref, { target: only, match: 'probable' });
      linked.add(only.ref);
      ambiguous.delete(ref);
    } else {
      ambiguous.set(ref, { candidates: found, claimed: ambiguous.get(ref)?.claimed === true });
    }
  }

  // What says it is a copy of something this source no longer holds.
  const candidateRefs = new Set([...ambiguous.values()].flatMap(entry => entry.candidates.map(target => target.ref)));
  const leftover = targets.filter(target => {
    const key = target.value.clonedFromKey;
    return (
      typeof key === 'string' &&
      !heldKeys.has(key) &&
      !linked.has(target.ref) &&
      !candidateRefs.has(target.ref) &&
      fromSource(target.value, source, machine)
    );
  });
  return { paired, ambiguous, leftover };
}

// ── Documents ────────────────────────────────────────────────────────────────────────────────────

/** One document or folder an item owns, on its side and (when paired) on the other. */
interface Owned {
  readonly source: string;
  readonly target: string | undefined;
  readonly directory: boolean;
}

const ownedOf = (source: Entry, target: Entry | undefined): Owned[] => {
  const owned: Owned[] = [];
  for (const [field, directory] of [
    ['file', false],
    ['directory', true],
  ] as const) {
    const path = source.value[field];
    if (typeof path !== 'string' || !isAssetRelative(path)) continue;
    const there = target?.value[field];
    owned.push({
      source: plain(path),
      target: typeof there === 'string' && isAssetRelative(there) ? plain(there) : undefined,
      directory,
    });
  }
  if (source.kind === 'skills') {
    const there = new Set(strings(target?.value.items));
    for (const item of strings(source.value.items)) {
      owned.push({
        source: `${CLONE_SKILLS_DIRECTORY}/${item}`,
        target: there.has(item) ? `${CLONE_SKILLS_DIRECTORY}/${item}` : undefined,
        directory: true,
      });
    }
  }
  return owned;
};

/** A side's documents as a map by plain path. */
const mapOf = (files: readonly FleetCloneFile[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const file of files) {
    const path = plain(file.path);
    if (!map.has(path)) map.set(path, file.content);
  }
  return map;
};

/** Every document under a folder (or the one file) as `relative path → content`. */
const under = (files: ReadonlyMap<string, string>, path: string, directory: boolean): Map<string, string> => {
  const found = new Map<string, string>();
  if (!directory) {
    const content = files.get(path);
    if (content !== undefined) found.set('', content);
    return found;
  }
  const prefix = `${path}/`;
  for (const [file, content] of files) if (file.startsWith(prefix)) found.set(file.slice(prefix.length), content);
  return found;
};

/** Lines in `next` that `previous` lacks, and the other way: a count for the screen, not a diff. */
function lineDelta(previous: string, next: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const line of previous.split('\n')) count.set(line, (count.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of next.split('\n')) {
    const seen = count.get(line) ?? 0;
    if (seen > 0) count.set(line, seen - 1);
    else added += 1;
  }
  const removed = [...count.values()].reduce((sum, left) => sum + left, 0);
  return { added, removed };
}

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────────

const REVIEW_KIND = (kind: ItemKind): CloneReviewKind => kind;

const withoutProvenance = (value: Value): Record<string, unknown> => {
  const own: Record<string, unknown> = { ...value };
  for (const field of ['clonedFrom', 'clonedFromDaemon', 'clonedFromKey', 'installedFrom']) delete own[field];
  return own;
};

/** The top-level fields whose value differs, as the digest sees them. Documents are the file list's to say. */
function differingFields(
  source: Entry,
  target: Entry,
  identity: { readonly source: (reference: string) => string; readonly target: (reference: string) => string },
): string[] {
  const view = (entry: Entry, of: (reference: string) => string): Record<string, unknown> => {
    const value = withoutProvenance(entry.value);
    if (entry.kind === 'profile') return { layers: strings(value.layers).map(of) };
    if (entry.kind === 'runtime') {
      return {
        login: of(`login/${String(value.credential)}`),
        profile: of(`profile/${String(value.profile)}`),
        agent: value.agent === true,
        harness: value.harness,
      };
    }
    delete value.file;
    delete value.directory;
    return value;
  };
  const mine = view(target, identity.target);
  const theirs = view(source, identity.source);
  const fields = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  return [...fields]
    .filter(field => JSON.stringify(mine[field] ?? null) !== JSON.stringify(theirs[field] ?? null))
    .toSorted();
}

/** What uses an item here: the layers that name it, the runtimes on a profile, the default runtime. */
function usersOf(target: AccountModel, entry: Entry): string[] {
  const users: string[] = [];
  if (entry.kind !== 'runtime') {
    for (const [name, profile] of Object.entries(target.profiles)) {
      if (profile.layers.includes(entry.ref as never)) users.push(`profile/${name}`);
    }
  }
  if (entry.kind === 'profile') {
    for (const [name, runtime] of Object.entries(target.runtimes)) {
      if (runtime.profile === entry.name) users.push(`runtime/${name}`);
    }
  }
  if (entry.kind === 'runtime' && target.machine.defaultRuntime === entry.name) users.push('the default runtime');
  return users;
}

const bundleKinds = (bundle: FleetCloneBundle): ReadonlySet<string> => new Set(Object.keys(bundle.components));

/** The analysis of one repeat copy: every pairing, outcome, default and need, and the fingerprint naming them. */
export function analyseCloneUpdate(input: CloneUpdateInput): CloneAnalysis {
  const { target, bundle, source, base } = input;
  bundleKinds(bundle);
  const sourceName = input.sourceName ?? bundle.machine;
  // The bundle must read as a setup of its own before anything is compared against it.
  const theirModel = bundleModel(bundle, sourceName);
  const keys = cloneOriginKeys(bundle);
  const sources = itemsOfBundle(bundle);
  const targets = itemsOfModel(target);
  const pairing = pair(sources, targets, keys, source, bundle.machine);
  const sourceIdentity = (reference: string): string => keys.get(reference) ?? reference;

  // What each login of the source is here, so a runtime's login is compared as the same login.
  const loginHere = new Map<string, string>();
  for (const credential of bundle.credentials) {
    const here = input.logins.matched.get(credential.id);
    if (here !== undefined) loginHere.set(here, credential.id);
  }
  const sourceOfTarget = new Map<string, Entry>();
  for (const { target: found } of pairing.paired.values()) sourceOfTarget.set(found.ref, found);
  const pairedSource = new Map<string, Entry>();
  for (const entry of sources) {
    const found = pairing.paired.get(entry.ref);
    if (found !== undefined) pairedSource.set(found.target.ref, entry);
  }
  const targetIdentity = (reference: string): string => {
    const theirs = pairedSource.get(reference);
    if (theirs !== undefined) return sourceIdentity(theirs.ref);
    if (reference.startsWith('login/')) {
      const id = loginHere.get(reference.slice('login/'.length));
      if (id !== undefined) return sourceIdentity(`login/${id}`);
    }
    return `here:${reference}`;
  };
  const identity = { source: sourceIdentity, target: targetIdentity };

  const theirFiles = mapOf(bundle.files);
  const myFiles = mapOf(input.targetFiles);
  const notCarried = bundle.notCopied.map(entry => plain(entry.path));

  /** Documents as each side compares them: what the bundle could not carry stands for itself on both. */
  const comparable = (
    entry: Entry,
    found: Entry | undefined,
  ): {
    readonly source: readonly FleetCloneFile[];
    readonly target: readonly FleetCloneFile[];
    readonly left: number;
  } => {
    const extraSource: FleetCloneFile[] = [];
    const extraTarget: FleetCloneFile[] = [];
    let left = 0;
    for (const owned of ownedOf(entry, found)) {
      for (const path of notCarried) {
        if (path !== owned.source && !path.startsWith(`${owned.source}/`)) continue;
        const rest = path.slice(owned.source.length + 1);
        left += 1;
        extraSource.push({ path: rest === '' ? owned.source : `${owned.source}/${rest}`, content: NOT_CARRIED });
        if (owned.target !== undefined) {
          extraTarget.push({ path: rest === '' ? owned.target : `${owned.target}/${rest}`, content: NOT_CARRIED });
        }
      }
    }
    return {
      source: extraSource.length === 0 ? bundle.files : [...extraSource, ...bundle.files],
      target: extraTarget.length === 0 ? input.targetFiles : [...extraTarget, ...input.targetFiles],
      left,
    };
  };

  const files = (entry: Entry, found: Entry | undefined): CloneReviewItem['files'][number][] => {
    const changes: CloneReviewItem['files'][number][] = [];
    for (const owned of ownedOf(entry, found)) {
      const theirs = under(theirFiles, owned.source, owned.directory);
      const mine =
        owned.target === undefined ? new Map<string, string>() : under(myFiles, owned.target, owned.directory);
      const hidden = new Set(
        notCarried
          .filter(path => path === owned.source || path.startsWith(`${owned.source}/`))
          .map(path => path.slice(owned.source.length + 1)),
      );
      const where = owned.target ?? owned.source;
      for (const rest of new Set([...theirs.keys(), ...mine.keys()])) {
        if (hidden.has(rest)) continue;
        const path = rest === '' ? where : `${where}/${rest}`;
        const next = theirs.get(rest);
        const previous = mine.get(rest);
        if (next !== undefined && previous === undefined) {
          changes.push({ path, change: 'added', lines: { added: next.split('\n').length, removed: 0 } });
        } else if (next === undefined && previous !== undefined) {
          changes.push({ path, change: 'removed', lines: { added: 0, removed: previous.split('\n').length } });
        } else if (next !== undefined && previous !== undefined && next !== previous) {
          changes.push({ path, change: 'changed', lines: lineDelta(previous, next) });
        }
      }
    }
    return changes.toSorted((left, right) => (left.path < right.path ? -1 : 1));
  };

  const taken: Record<string, Set<string>> = {};
  const takenNames = (kind: ItemKind): Set<string> => {
    taken[kind] ??= new Set(targets.filter(entry => entry.kind === kind).map(entry => entry.name));
    if (kind === 'runtime') for (const command of target.advanced.commands) taken[kind].add(command.wrapper);
    return taken[kind];
  };
  const landing = (entry: Entry, preferred: string): string => {
    const used = takenNames(entry.kind);
    const name = freeName(preferred, candidate => used.has(candidate));
    used.add(name);
    return `${entry.kind === 'profile' || entry.kind === 'runtime' ? entry.kind : entry.kind}/${name}`;
  };

  const analysed: Analysed[] = [];
  let sameCount = 0;
  let sameProbable = 0;
  for (const entry of sources) {
    const key = keys.get(entry.ref);
    const recorded = key === undefined ? undefined : base?.items[key];
    const baseDigest = recorded?.kind === entry.kind ? recorded.digest : undefined;
    const found = pairing.paired.get(entry.ref);
    const documents = comparable(entry, found?.target);
    const theirDigest = cloneItemDigest({ kind: entry.kind, value: entry.value }, documents.source, sourceIdentity);
    if (found === undefined) {
      const maybe = pairing.ambiguous.get(entry.ref);
      if (maybe === undefined && baseDigest !== undefined) {
        analysed.push({
          ref: landing(entry, entry.name),
          kind: entry.kind,
          outcome: 'removed-here',
          match: 'none',
          source: entry,
          ...(key === undefined ? {} : { key }),
          note:
            baseDigest === theirDigest
              ? 'Not here: it was left out when last copied, or removed here since. It stays out unless you add it.'
              : 'Not here: it was left out when last copied, or removed here since, and it has changed on the source too. It stays out unless you add it.',
          fields: [],
          files: files(entry, undefined),
          stamp: false,
          digests: [theirDigest, '', baseDigest],
          usedBy: [],
          ambiguous: false,
        });
        continue;
      }
      const names = (maybe?.candidates ?? []).map(candidate => candidate.ref);
      analysed.push({
        ref: landing(entry, entry.name),
        kind: entry.kind,
        outcome: 'new',
        match: 'none',
        source: entry,
        ...(key === undefined ? {} : { key }),
        ...(maybe === undefined
          ? {}
          : {
              note: maybe.claimed
                ? `${names.join(' and ')} here each say they are a copy of this, so none was picked. You may already have this as ${names.join(' or ')}.`
                : `You may already have this as ${names.join(' or ')}.`,
            }),
        fields: [],
        files: files(entry, undefined),
        stamp: false,
        digests: [theirDigest, '', baseDigest ?? ''],
        usedBy: [],
        ambiguous: maybe !== undefined,
      });
      continue;
    }
    const mineDigest = cloneItemDigest(
      { kind: found.target.kind, value: found.target.value },
      documents.target,
      targetIdentity,
    );
    if (
      mineDigest !== theirDigest &&
      found.match === 'probable' &&
      (entry.kind === 'profile' || entry.kind === 'runtime')
    ) {
      // A profile or runtime has no provenance, so a name alone is not enough to overwrite one with: offer it, unticked.
      analysed.push({
        ref: landing(entry, entry.name),
        kind: entry.kind,
        outcome: 'new',
        match: 'none',
        source: entry,
        ...(key === undefined ? {} : { key }),
        note: `You may already have this as ${found.target.ref}.`,
        fields: [],
        files: [],
        stamp: false,
        digests: [theirDigest, '', baseDigest ?? ''],
        usedBy: [],
        ambiguous: true,
      });
      continue;
    }
    const partial =
      documents.left === 0 ? '' : ` ${String(documents.left)} file(s) too large to copy could not be compared.`;
    const common = {
      kind: entry.kind,
      match: found.match,
      source: entry,
      target: found.target,
      ...(key === undefined ? {} : { key }),
      digests: [theirDigest, mineDigest, baseDigest ?? ''] as const,
      usedBy: [] as string[],
      ambiguous: false,
    };
    if (mineDigest === theirDigest) {
      sameCount += 1;
      if (found.match === 'probable') sameProbable += 1;
      analysed.push({
        ...common,
        ref: found.target.ref,
        outcome: 'same',
        fields: [],
        files: [],
        stamp: found.match === 'probable',
      });
      continue;
    }
    let outcome: CloneOutcome;
    let note: string | undefined;
    if (baseDigest === undefined) {
      outcome = 'both';
      note =
        found.match === 'probable'
          ? "Probably the same item (same name, copied from this machine), but there is no record of the last copy, so we can't tell which side changed."
          : "There is no record of the last copy, so we can't tell which side changed.";
    } else if (baseDigest === theirDigest) {
      outcome = 'mine';
      note = 'Changed here since the last copy. It stays as it is.';
    } else if (baseDigest === mineDigest) {
      outcome = 'theirs';
    } else {
      outcome = 'both';
      note = 'Changed on both sides since the last copy.';
    }
    analysed.push({
      ...common,
      ref: found.target.ref,
      outcome,
      ...(note === undefined && partial === '' ? {} : { note: `${note ?? ''}${partial}`.trim() }),
      fields: differingFields(entry, found.target, identity),
      files: files(entry, found.target),
      stamp: false,
    });
  }

  // Items here that the source no longer holds (a v2 bundle only: without keys, absent means unknown).
  if (bundle.version === 2) {
    for (const entry of pairing.leftover) {
      const key = entry.value.clonedFromKey as string;
      if (base?.items[key]?.settled === true) continue;
      const users = usersOf(target, entry);
      analysed.push({
        ref: entry.ref,
        kind: entry.kind,
        outcome: 'gone',
        match: 'key',
        target: entry,
        key,
        note:
          users.length === 0
            ? 'The source no longer has it. It stays here unless you remove it.'
            : `The source no longer has it. ${users.join(', ')} still use${users.length === 1 && !users[0]?.startsWith('the ') ? 's' : ''} it, so it stays unless they go too.`,
        fields: [],
        files: [],
        stamp: false,
        digests: ['', '', base?.items[key]?.digest ?? ''],
        usedBy: users,
        ambiguous: false,
      });
    }
  }

  // The logins.
  const logins: CloneReviewLogin[] = bundle.credentials.map(credential => {
    const matched = input.logins.matched.get(credential.id);
    if (matched !== undefined) return { sourceId: credential.id, outcome: 'matched', target: matched };
    const candidates = input.logins.ask.get(credential.id);
    if (candidates !== undefined && candidates.length > 1) {
      return { sourceId: credential.id, outcome: 'ask', candidates: [...candidates] };
    }
    return { sourceId: credential.id, outcome: 'slot' };
  });

  // What each item needs written beside it, and what it does when the person decides nothing.
  const byRef = new Map(analysed.map(item => [item.ref, item]));
  const bySource = new Map(
    analysed.flatMap(item => (item.source === undefined ? [] : [[item.source.ref, item] as const])),
  );
  const needs = new Map<string, readonly string[]>();
  for (const item of analysed) {
    if (item.source === undefined || (item.kind !== 'profile' && item.kind !== 'runtime')) continue;
    const wants =
      item.kind === 'profile' ? strings(item.source.value.layers) : [`profile/${String(item.source.value.profile)}`];
    const absent = wants.flatMap(reference => {
      const wanted = bySource.get(reference);
      return wanted !== undefined && wanted.target === undefined ? [wanted.ref] : [];
    });
    if (absent.length > 0) needs.set(item.ref, absent);
  }
  const defaults = new Map<string, CloneChoice>();
  for (const item of analysed) {
    if (item.outcome === 'same' || item.outcome === 'both') continue;
    defaults.set(
      item.ref,
      item.outcome === 'new' ? (item.ambiguous ? 'skip' : 'add') : item.outcome === 'theirs' ? 'take' : 'keep',
    );
  }
  const writes = (choice: CloneChoice | undefined): boolean => choice === 'take' || choice === 'add';
  for (let changed = true; changed; ) {
    changed = false;
    for (const [ref, wanted] of needs) {
      if (!writes(defaults.get(ref))) continue;
      for (const need of wanted) {
        if (!writes(defaults.get(need)) && byRef.has(need)) {
          defaults.set(need, 'add');
          changed = true;
        }
      }
    }
  }

  const shown = analysed.filter(item => item.outcome !== 'same');
  const fingerprint = sha256Hex(
    JSON.stringify({
      version: 1,
      source: source?.id ?? '',
      items: analysed.map(item => [
        item.ref,
        item.source?.ref ?? '',
        item.outcome,
        item.match,
        item.stamp,
        ...item.digests,
      ]),
      logins: logins.map(login => [login.sourceId, login.outcome, login.target ?? '', login.candidates ?? []]),
      shown: shown.length,
    }),
  );
  void theirModel;
  return {
    input,
    items: analysed,
    same: { count: sameCount, probable: sameProbable },
    logins,
    defaults,
    needs,
    fingerprint,
    keys,
  };
}

// ── The review ───────────────────────────────────────────────────────────────────────────────────

/** The review the app shows: every item that differs, why, and what is chosen for it. */
export function reviewCloneUpdate(analysis: CloneAnalysis): FleetCloneReview {
  const { input } = analysis;
  const runnables = new Map(cloneRunnables(input.bundle).map(runnable => [runnable.reference, runnable]));
  const items: CloneReviewItem[] = [];
  for (const item of analysis.items) {
    if (item.outcome === 'same') continue;
    const choice = analysis.defaults.get(item.ref);
    const runnable = item.source === undefined ? undefined : runnables.get(item.source.ref);
    const writes =
      item.outcome === 'new' || item.outcome === 'theirs' || item.outcome === 'both' || item.outcome === 'removed-here';
    const wanted = analysis.needs.get(item.ref);
    items.push({
      ref: item.ref,
      ...(item.source === undefined ? {} : { sourceRef: item.source.ref }),
      kind: REVIEW_KIND(item.kind),
      outcome: item.outcome,
      match: item.match,
      ...(choice === undefined ? {} : { choice }),
      files: [...item.files],
      ...(item.fields.length === 0 ? {} : { fields: [...item.fields] }),
      ...(writes && runnable !== undefined
        ? {
            runnable: {
              ...runnable,
              entries: [...runnable.entries],
              reference: item.ref,
              name: item.ref.slice(item.ref.indexOf('/') + 1),
            },
          }
        : {}),
      ...(wanted === undefined ? {} : { needs: [...wanted] }),
      ...(item.note === undefined ? {} : { note: item.note }),
    });
  }
  return {
    mode: input.base !== undefined || analysis.items.some(item => item.match !== 'none') ? 'update' : 'first',
    source: {
      name: input.sourceName ?? input.bundle.machine,
      ...(input.base === undefined ? {} : { lastCopiedAt: input.base.lastCopiedAt }),
      verified: input.source?.verified ?? 'self',
    },
    items,
    settings: [],
    logins: [...analysis.logins],
    keys: [],
    same: analysis.same,
    fingerprint: analysis.fingerprint,
  };
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────

export interface CloneUpdatePlan {
  readonly model: AccountModel;
  /** Documents to write, relative to the asset tree: only what differs from what is there. */
  readonly files: readonly FleetCloneFile[];
  readonly slots: readonly {
    readonly id: string;
    readonly harness: HarnessKind;
    readonly runtimes: readonly string[];
  }[];
  readonly checkPaths: readonly { readonly reference: string; readonly path: string }[];
  readonly missingHarnesses: readonly HarnessKind[];
  readonly missingSecrets: readonly string[];
  readonly keptSkillItems: readonly string[];
  /** What was done, by item. */
  readonly done: {
    readonly taken: readonly string[];
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly kept: readonly string[];
    readonly linked: readonly string[];
  };
  readonly same: { readonly count: number; readonly probable: number };
  readonly runnables: readonly CloneRunnable[];
  readonly notCopied: readonly { readonly path: string; readonly reason: string }[];
  /** The source's side of everything, for the record. */
  readonly base: readonly CloneBaseEntry[];
  readonly sourceKeys: ReadonlySet<string>;
  /** Origin keys of the items kept here that the source dropped: not asked about again. */
  readonly settled: readonly string[];
}

/** The base a source's entry gives a review: the record's entry only when it is for the same kind of source. */
export function cloneBaseFor(record: CloneBase, source: CloneSourceIdentity | undefined): CloneBaseSource | undefined {
  if (source === undefined) return undefined;
  const entry = record.sources[source.id];
  // A source verified by another machine's own word must never read, or write over, one a browser verified.
  return entry !== undefined && entry.verified === source.verified ? entry : undefined;
}

/**
 * The decisions for a review, whole: what the person chose, what is chosen for them by default, and a
 * sentence when the set cannot be applied. `both` has no default, so a `both` item with no decision
 * refuses the update and says which.
 */
export function resolveCloneDecisions(
  analysis: CloneAnalysis,
  decisions: CloneDecisions,
): ReadonlyMap<string, CloneChoice> {
  const byRef = new Map(analysis.items.filter(item => item.outcome !== 'same').map(item => [item.ref, item]));
  for (const [ref, choice] of Object.entries(decisions)) {
    const item = byRef.get(ref);
    if (item === undefined) throw new CloneRefusal(`There is nothing called ${ref} in this review.`);
    const allowed = CLONE_OUTCOME_CHOICES[item.outcome as CloneOutcome] as readonly CloneChoice[];
    if (!allowed.includes(choice)) {
      throw new CloneRefusal(
        `${ref} can't be set to "${choice}": it can be ${allowed.map(one => `"${one}"`).join(' or ')}.`,
      );
    }
  }
  const unchosen = [...byRef.values()]
    .filter(item => item.outcome === 'both' && decisions[item.ref] === undefined)
    .map(item => item.ref);
  if (unchosen.length > 0) {
    throw new CloneRefusal(
      `Both sides changed ${unchosen.join(', ')}. Choose whether to take theirs or keep yours for each one.`,
    );
  }
  const chosen = new Map<string, CloneChoice>();
  for (const item of byRef.values()) {
    const choice = decisions[item.ref] ?? analysis.defaults.get(item.ref);
    if (choice !== undefined) chosen.set(item.ref, choice);
  }
  const writes = (choice: CloneChoice | undefined): boolean => choice === 'take' || choice === 'add';
  for (const [ref, wanted] of analysis.needs) {
    if (!writes(chosen.get(ref))) continue;
    for (const need of wanted) {
      if (!writes(chosen.get(need))) {
        throw new CloneRefusal(`${ref} needs ${need}. Add ${need} too, or leave ${ref} as it is.`);
      }
    }
  }
  for (const item of byRef.values()) {
    if (chosen.get(item.ref) !== 'remove') continue;
    const blockers = item.usedBy.filter(user => chosen.get(user) !== 'remove');
    if (blockers.length > 0) {
      throw new CloneRefusal(`${item.ref} is still used by ${blockers.join(', ')}, so it can't be removed here.`);
    }
  }
  return chosen;
}

/**
 * The next setup and the documents to write. Throws {@link CloneRefusal} when the decisions leave a
 * `both` item unchosen, ask for what an item cannot do, or would leave a setup this machine cannot read.
 */
export function planCloneUpdate(analysis: CloneAnalysis, choices: CloneUpdateChoices): CloneUpdatePlan {
  const { input } = analysis;
  const { target, bundle } = input;
  const sourceName = input.sourceName ?? bundle.machine;
  const chosen = resolveCloneDecisions(analysis, choices.decisions);
  const source = bundleModel(bundle, sourceName);
  const origin = {
    clonedFrom: bundle.machine,
    ...(input.sourceDaemon === undefined ? {} : { clonedFromDaemon: input.sourceDaemon }),
  };
  const keyed = (reference: string): { clonedFromKey?: string } => {
    const key = analysis.keys.get(reference);
    return key === undefined ? {} : { clonedFromKey: key };
  };

  const components = Object.fromEntries(
    COMPONENT_KINDS.map(kind => [kind, { ...target.components[kind] }]),
  ) as MutableComponents;
  const profiles: Record<string, LayeredProfile> = { ...target.profiles };
  const runtimes: Record<string, Runtime> = { ...target.runtimes };
  const credentials: Record<string, Credential> = { ...target.credentials };
  const usedFiles = referencedFiles(target);
  const theirContents = new Map(bundle.files.map(file => [plain(file.path), file.content]));
  const myContents = mapOf(input.targetFiles);
  const writing = new Map<string, string>();
  const fileMoves = new Map<string, string>();
  const folderMoves = new Map<string, string>();
  const checkPaths: { reference: string; path: string }[] = [];
  const taken: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  const linked: string[] = [];
  const settled: string[] = [];
  const keptSkillItems = new Set<string>();
  const existingItems = new Set(input.existingSkillItems);
  const writtenSources = new Set<string>();
  const slotRuntimes = new Map<string, string[]>();
  const missingHarnesses = new Set<HarnessKind>();

  const bySource = new Map(
    analysis.items.flatMap(item => (item.source === undefined ? [] : [[item.source.ref, item] as const])),
  );
  /** The reference an item of the source goes by here, once the choices are applied. */
  const hereRef = (reference: string): string | undefined => {
    const item = bySource.get(reference);
    if (item === undefined) return undefined;
    if (item.target !== undefined) return item.target.ref;
    return chosen.get(item.ref) === 'add' ? item.ref : undefined;
  };

  // Logins first: a runtime's slot has to exist before the runtime points at it.
  const loginChoices = choices.logins ?? {};
  const loginFor = new Map<string, string>();
  const slots = new Map<string, { id: string; harness: HarnessKind }>();
  const writtenRuntimes = analysis.items.filter(
    item =>
      item.kind === 'runtime' && item.source !== undefined && ['take', 'add'].includes(chosen.get(item.ref) ?? ''),
  );
  for (const item of writtenRuntimes) {
    const credential = String(item.source?.value.credential);
    if (loginFor.has(credential)) continue;
    const descriptor = bundle.credentials.find(candidate => candidate.id === credential);
    if (descriptor === undefined)
      throw new CloneRefusal(`The setup from ${sourceName} names a login it does not carry.`);
    const asked = analysis.logins.find(login => login.sourceId === credential);
    const picked = loginChoices[credential];
    let here: string | undefined = analysis.input.logins.matched.get(credential);
    if (picked !== undefined && picked !== 'slot') {
      const existing = target.credentials[picked];
      if (existing === undefined || existing.harness !== descriptor.harness) {
        throw new CloneRefusal(`${picked} isn't a ${descriptor.harness} login on ${input.machine}. Pick another one.`);
      }
      here = picked;
    } else if (picked === 'slot') {
      here = undefined;
    } else if (here === undefined && asked?.outcome === 'ask') {
      throw new CloneRefusal(
        `Choose which login on ${input.machine} ${descriptor.email ?? descriptor.label ?? credential} is: ${(asked.candidates ?? []).join(', ')}, or a new empty one.`,
      );
    }
    if (here !== undefined) {
      loginFor.set(credential, here);
      continue;
    }
    // An empty slot (or a copy of an environment login's own configuration): a new login, never an existing one.
    const id = freeName(credential, candidate => credentials[candidate] !== undefined);
    const label = descriptor.label ?? descriptor.email;
    credentials[id] = (
      descriptor.store === 'environment'
        ? { ...(source.credentials[credential] as Credential), ...origin, ...keyed(`login/${credential}`) }
        : {
            harness: descriptor.harness,
            store: 'ferretry',
            ...(label === undefined ? {} : { label }),
            ...origin,
            ...keyed(`login/${credential}`),
          }
    ) as Credential;
    loginFor.set(credential, id);
    slots.set(id, { id, harness: descriptor.harness });
  }

  /** One component as it is written here, under `name`: its document and folder follow the name. */
  const writeComponent = (entry: Entry, name: string, here: Entry | undefined, existing: boolean): void => {
    const kind = entry.kind as ComponentKind;
    const { clonedFrom: _from, clonedFromDaemon: _daemon, clonedFromKey: _key, ...own } = entry.value;
    const copy: Record<string, unknown> = { ...own, ...origin, ...keyed(entry.ref) };
    const file = copy.file;
    if (typeof file === 'string' && isAssetRelative(file)) {
      const theirs = here?.value.file;
      const moved =
        fileMoves.get(file) ??
        (typeof theirs === 'string' && isAssetRelative(theirs) ? theirs : movedFile(file, entry.name, name, usedFiles));
      fileMoves.set(file, moved);
      usedFiles.add(moved);
      copy.file = moved;
    }
    const directory = copy.directory;
    if (typeof directory === 'string' && isAssetRelative(directory)) {
      const theirs = here?.value.directory;
      const moved =
        folderMoves.get(directory) ??
        (typeof theirs === 'string' && isAssetRelative(theirs)
          ? theirs
          : movedFolder(directory, entry.name, name, usedFiles));
      folderMoves.set(directory, moved);
      if (moved !== directory) usedFiles.add(moved);
      copy.directory = moved;
    }
    components[kind][name] = copy;
    const text = [
      JSON.stringify(entry.value),
      ...['file', 'directory'].map(field => theirContents.get(String(entry.value[field]))),
    ]
      .filter(piece => piece !== undefined)
      .join('\n');
    const path = HOME_PATH.exec(text)?.[0];
    if (path !== undefined) checkPaths.push({ reference: `${kind}/${name}`, path });
    void existing;
  };

  // Components first, then profiles, then runtimes: each one's references follow what was written.
  const order = (kind: ItemKind): number => (kind === 'profile' ? 1 : kind === 'runtime' ? 2 : 0);
  for (const item of analysis.items.toSorted((left, right) => order(left.kind) - order(right.kind))) {
    const choice = chosen.get(item.ref);
    const entry = item.source;
    if (item.outcome === 'same') {
      if (item.stamp && entry !== undefined && item.target !== undefined) {
        // Linked by name: the same item, so only the link is written.
        const stamped = { ...item.target.value, ...origin, ...keyed(entry.ref) };
        if (item.kind === 'profile') profiles[item.target.name] = stamped as unknown as LayeredProfile;
        else if (item.kind === 'runtime') runtimes[item.target.name] = stamped as unknown as Runtime;
        else components[item.kind][item.target.name] = stamped;
        linked.push(item.ref);
      }
      continue;
    }
    if (choice === 'remove') {
      const name = item.ref.slice(item.ref.indexOf('/') + 1);
      if (item.kind === 'profile') delete profiles[name];
      else if (item.kind === 'runtime') delete runtimes[name];
      else delete components[item.kind][name];
      removed.push(item.ref);
      continue;
    }
    if (choice !== 'take' && choice !== 'add') {
      kept.push(item.ref);
      if (item.outcome === 'gone' && choice === 'keep' && item.key !== undefined) settled.push(item.key);
      continue;
    }
    if (entry === undefined) continue;
    const name = item.ref.slice(item.ref.indexOf('/') + 1);
    writtenSources.add(entry.ref);
    (choice === 'take' ? taken : added).push(item.ref);
    if (item.kind === 'profile') {
      profiles[name] = {
        layers: strings(entry.value.layers).map(layer => {
          const reference = hereRef(layer);
          if (reference === undefined) {
            throw new CloneRefusal(`${item.ref} needs ${layer}. Add it too, or leave ${item.ref} as it is.`);
          }
          return reference;
        }) as LayeredProfile['layers'],
        ...keyed(entry.ref),
      };
    } else if (item.kind === 'runtime') {
      const credential = loginFor.get(String(entry.value.credential)) as string;
      const profile = hereRef(`profile/${String(entry.value.profile)}`);
      if (profile === undefined) {
        throw new CloneRefusal(`${item.ref} needs profile/${String(entry.value.profile)}. Add it too.`);
      }
      const theirRuntime = source.runtimes[entry.name] as Runtime;
      runtimes[name] = {
        credential,
        profile: profile.slice('profile/'.length),
        agent: theirRuntime.agent,
        ...(theirRuntime.harness === undefined ? {} : { harness: theirRuntime.harness }),
        ...keyed(entry.ref),
      };
      slotRuntimes.set(credential, [...(slotRuntimes.get(credential) ?? []), name]);
      const harness = runtimeHarness(source, theirRuntime) as HarnessKind;
      if (!input.installed.includes(harness)) missingHarnesses.add(harness);
    } else {
      writeComponent(entry, name, item.target, choice === 'take');
    }
  }

  // Documents: each under the path its component now names, and only when its content differs.
  const files: FleetCloneFile[] = [];
  for (const file of bundle.files) {
    const owner = bySource.get(
      [...bySource.keys()].find(reference => {
        const candidate = bySource.get(reference);
        return (
          candidate?.source !== undefined &&
          writtenSources.has(reference) &&
          candidate.kind !== 'profile' &&
          candidate.kind !== 'runtime' &&
          ownsFile(candidate.source.value, file.path)
        );
      }) ?? '',
    );
    if (owner === undefined) continue;
    const moved = fileMoves.get(file.path) ?? movedUnderFolder(file.path, folderMoves) ?? file.path;
    const skillItem = /^skills\/([^/]+)\//u.exec(file.path)?.[1];
    if (
      skillItem !== undefined &&
      owner.outcome !== 'theirs' &&
      owner.outcome !== 'both' &&
      existingItems.has(skillItem)
    ) {
      keptSkillItems.add(skillItem);
      continue;
    }
    if (myContents.get(plain(moved)) === file.content) continue;
    files.push({ path: moved, content: file.content });
  }
  void writing;

  let model: AccountModel;
  try {
    model = parseAccountModel({ ...target, credentials, components, profiles, runtimes });
  } catch (error) {
    const first = (error as { issues?: readonly { message: string }[] }).issues?.[0]?.message;
    throw new CloneRefusal(
      `Updating from ${sourceName} would leave ${input.machine} with a setup it cannot read${first === undefined ? '' : `: ${first}`}. Nothing was changed. Fix that on ${input.machine} (Settings › Machine), or review again.`,
    );
  }

  const written = analysis.items.flatMap(item =>
    item.source !== undefined &&
    writtenSources.has(item.source.ref) &&
    item.kind !== 'profile' &&
    item.kind !== 'runtime'
      ? [item.source]
      : [],
  );
  const held = new Set(input.existingSecrets);
  const missingSecrets = [...new Set(secretReferencesIn(JSON.stringify(written.map(entry => entry.value))))].filter(
    name => !held.has(name),
  );
  const references = new Map(
    analysis.items.flatMap(item =>
      item.source !== undefined && writtenSources.has(item.source.ref) ? [[item.source.ref, item.ref] as const] : [],
    ),
  );
  const runnables = cloneRunnables(bundle).flatMap(runnable => {
    const reference = references.get(runnable.reference);
    return reference === undefined
      ? []
      : [{ ...runnable, reference, name: reference.slice(reference.indexOf('/') + 1) }];
  });

  return {
    model,
    files,
    slots: [...slots.values()].map(slot => ({ ...slot, runtimes: slotRuntimes.get(slot.id) ?? [] })),
    checkPaths,
    missingHarnesses: [...missingHarnesses].toSorted(),
    missingSecrets,
    keptSkillItems: [...keptSkillItems].toSorted(),
    done: { taken, added, removed, kept, linked },
    same: analysis.same,
    runnables,
    notCopied: bundle.notCopied,
    base: cloneBaseEntries(bundle, bundle, new Map([...analysis.input.logins.matched, ...loginFor])),
    sourceKeys: new Set(analysis.keys.values()),
    settled,
  };
}

function ownsFile(component: Value, path: string): boolean {
  if (component.file === path) return true;
  if (typeof component.directory === 'string' && path.startsWith(`${component.directory}/`)) return true;
  return strings(component.items).some(item => path.startsWith(`${CLONE_SKILLS_DIRECTORY}/${item}/`));
}

/** The sentence an apply is refused with when the review it names is not the one this machine answers with now. */
export function checkCloneReviewed(analysis: CloneAnalysis, reviewed: string | undefined): void {
  if (reviewed === undefined || reviewed !== analysis.fingerprint) throw new CloneRefusal(CLONE_REVIEW_STALE);
}

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/** What applying the update would do, as the confirm card says it. */
export function describeCloneUpdate(plan: CloneUpdatePlan, machine: string, sourceName: string): readonly string[] {
  const lines: string[] = [];
  const { taken, added, removed, linked } = plan.done;
  lines.push(
    `Updates ${machine} from ${sourceName}: ${plural(taken.length, 'item')} updated, ${plural(added.length, 'item')} added, ${plural(removed.length, 'item')} removed. ${plural(plan.same.count, 'item')} already the same.`,
  );
  if (linked.length > 0)
    lines.push(`Links ${plural(linked.length, 'item')} to ${sourceName} by name; their content is unchanged.`);
  if (plan.runnables.length > 0) {
    lines.push(
      `${plural(plan.runnables.length, 'component')} from ${sourceName} can make ${machine} run something: ${plan.runnables.map(runnable => runnable.reference).join(', ')}.`,
    );
  }
  for (const slot of plan.slots) {
    lines.push(`Adds an empty login ${slot.id} on ${machine} that needs sign-in; no existing login is changed.`);
  }
  for (const check of plan.checkPaths) lines.push(`Check after copying: ${check.reference} names ${check.path}.`);
  for (const harness of plan.missingHarnesses) {
    lines.push(`${harness} isn't installed on ${machine}: its runtimes are copied and wait for it.`);
  }
  if (plan.missingSecrets.length > 0) {
    lines.push(`${machine}'s secret store has no ${plan.missingSecrets.join(', ')}: add them before those items run.`);
  }
  for (const item of plan.keptSkillItems)
    lines.push(`Skill ${item} is already on ${machine}, so its copy there was kept.`);
  return lines;
}

/**
 * Which login here each login of the source is: the record's link (the login this source's login was
 * last paired with), then a login here that carries the source login's origin key. Two logins here
 * claiming one key is a question for the person, never a guess. A login with no pairing is an empty slot —
 * an existing login is only ever pointed at, never rewritten (design §14.4).
 */
export function resolveCloneLogins(
  bundle: FleetCloneBundle,
  target: AccountModel,
  base: CloneBaseSource | undefined,
): CloneLoginResolution {
  const keys = cloneOriginKeys(bundle);
  const matched = new Map<string, string>();
  const ask = new Map<string, readonly string[]>();
  for (const credential of bundle.credentials) {
    const key = keys.get(`login/${credential.id}`);
    if (key === undefined) continue;
    const linked = base?.items[key]?.login;
    const known = linked === undefined ? undefined : target.credentials[linked];
    if (linked !== undefined && known?.harness === credential.harness) {
      matched.set(credential.id, linked);
      continue;
    }
    const claimants = Object.entries(target.credentials)
      .filter(([, held]) => held.clonedFromKey === key && held.harness === credential.harness)
      .map(([id]) => id)
      .toSorted();
    if (claimants.length === 1 && claimants[0] !== undefined) matched.set(credential.id, claimants[0]);
    else if (claimants.length > 1) ask.set(credential.id, claimants);
  }
  return { matched, ask };
}
