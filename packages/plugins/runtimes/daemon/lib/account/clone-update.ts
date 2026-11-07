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
 * **A path another item here uses is never written.** A taken item whose document, folder or skill item is
 * shared with another item here (kept, changed here or hidden as the same) moves to a free path, which the
 * review lists, or leaves the shared skill item as it is. What it removes is only what the review listed as
 * removed inside a folder it alone owns.
 *
 * Pure: a model, a bundle, a record and the documents on both sides in; an analysis, a review and a plan
 * out. Reading and writing is the setup service's.
 */
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import type { Instant } from '@ferretry/std';
import {
  CLONE_OUTCOME_CHOICES,
  CLONE_SKILLS_DIRECTORY,
  type CloneBundle,
  type CloneChoice,
  type CloneDecisions,
  type CloneFile,
  type CloneLoginChoices,
  type CloneMatch,
  type CloneOutcome,
  type CloneReview,
  type CloneReviewItem,
  type CloneReviewKind,
  type CloneReviewLogin,
} from '../../../contract/index.ts';
import { cloneItemDigest } from '../clone-digest.ts';
import { matchCloneSignIn } from '../clone-logins.ts';
import { type CloneRunnable, cloneBundleProblem, cloneLoginRunnable, cloneRunnables } from '../clone-review.ts';
import { sha256Hex } from '../foreign.ts';
import { type HarnessKind, harnessKeyOfKind, harnessKindOfKey } from '../manifest.ts';
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
  ASSET_ROOT,
  type AssetRoots,
  assetReference,
  bundleModel,
  CloneRefusal,
  HOME_PATH,
  isAssetRelative,
  type MutableComponents,
  movedFile,
  movedFolder,
  movedUnderFolder,
  pathsOverlap,
  referencedFiles,
  wholeTreeRefusal,
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
  readonly bundle: CloneBundle;
  /** The target's name, for the sentences. */
  readonly machine: string;
  /** The source as the person names it. */
  readonly sourceName?: string;
  readonly source?: CloneSourceIdentity;
  /** What the record holds of this source, or none. */
  readonly base?: CloneBaseSource;
  /** The documents this machine holds for its own items, by path in the asset tree. */
  readonly targetFiles: readonly CloneFile[];
  readonly logins: CloneLoginResolution;
  /** The harnesses installed here. */
  readonly installed: readonly HarnessKind[];
  /** Skill items the store here already holds. */
  readonly existingSkillItems: readonly string[];
  /** Secret names the store here holds. */
  readonly existingSecrets: readonly string[];
  /** Where the asset tree and the home are here: a document reached by an absolute or `~/` spelling is the same document. */
  readonly roots: AssetRoots;
  /** The instant the review is made, for `source.lastCopiedAt`-style sentences. Never in the fingerprint. */
  readonly sourceDaemon?: string;
}

export interface CloneUpdateChoices {
  readonly decisions: CloneDecisions;
  readonly logins?: CloneLoginChoices;
  /**
   * Items the person left out, as the SOURCE names them (`clone.import`'s `skip`): each becomes the
   * choice that writes nothing. One naming nothing in the review, or contradicting a decision, is refused.
   */
  readonly skip?: readonly string[];
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
  /**
   * A document or folder the item shares here with another item, moved off that path when it is taken:
   * the source's path → where it lands here. Writing the shared path would change the other item too,
   * whether it is kept, changed here or hidden as the same.
   */
  readonly relocated?: ReadonlyMap<string, string>;
  /** Skill items another item here lists too: left as they are, never written by this one. */
  readonly sharedItems?: readonly string[];
  /** Documents here the source no longer carries, which this item alone owns: removed when it is taken. */
  readonly removals: readonly string[];
  /** Why writing this item is refused: its documents have nowhere to land that leaves another item as it was. */
  readonly blocked?: string;
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

const itemsOfBundle = (bundle: CloneBundle): Entry[] => [
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

type Resolve = (path: string) => string | undefined;

const ownedOf = (source: Entry, target: Entry | undefined, resolve: Resolve): Owned[] => {
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
      target: typeof there === 'string' ? resolve(there) : undefined,
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

/** Every path an item here owns: its document, its folder, and each skill item's folder in the store. */
const ownedHere = (entry: Entry, resolve: Resolve): { readonly path: string }[] => {
  const owned: { path: string }[] = [];
  for (const field of ['file', 'directory'] as const) {
    const path = entry.value[field];
    const canonical = typeof path === 'string' ? resolve(path) : undefined;
    if (canonical !== undefined) owned.push({ path: canonical });
  }
  if (entry.kind === 'skills') {
    for (const item of strings(entry.value.items)) owned.push({ path: `${CLONE_SKILLS_DIRECTORY}/${item}` });
  }
  return owned;
};

/** The skill item a skills component's owned path names: a skills component owns nothing but `skills/<item>`. */
const skillItemOf = (path: string): string => path.slice(CLONE_SKILLS_DIRECTORY.length + 1);

/** A side's documents as a map by plain path. */
const mapOf = (files: readonly CloneFile[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const file of files) {
    const path = plain(file.path);
    if (!map.has(path)) map.set(path, file.content);
  }
  return map;
};

/** The documents here at their canonical asset path, so a folder reached through an alias reads as the one folder. */
const canonicalFiles = (files: readonly CloneFile[], roots: AssetRoots): CloneFile[] => {
  const seen = new Set<string>();
  const result: CloneFile[] = [];
  for (const file of files) {
    const path = assetReference(file.path, roots) ?? plain(file.path);
    if (seen.has(path)) continue;
    seen.add(path);
    result.push({ path, content: file.content });
  }
  return result;
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
    if (entry.kind === 'profile') return { layers: strings(value.layers).map(of), compactAt: value.compactAt };
    if (entry.kind === 'runtime') {
      return {
        login: of(`login/${String(value.credential)}`),
        profile: of(`profile/${String(value.profile)}`),
        agent: value.agent === true,
        harness: value.harness,
        compactAt: value.compactAt,
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

/** The analysis of one repeat copy: every pairing, outcome, default and need, and the fingerprint naming them. */
export function analyseCloneUpdate(input: CloneUpdateInput): CloneAnalysis {
  const { target, bundle, source, base } = input;
  const sourceName = input.sourceName ?? bundle.machine;
  // The bundle must be one the review can list whole, and read as a setup of its own, before anything is compared.
  const problem = cloneBundleProblem(bundle);
  if (problem !== null) throw new CloneRefusal(problem);
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
  const targetFiles = canonicalFiles(input.targetFiles, input.roots);
  const myFiles = mapOf(targetFiles);
  // A carried file is compared by its bytes, always: an omission marker never stands in for one (the bundle
  // boundary refuses a file marked both, and this holds even for a bundle that never crossed it).
  const notCarried = bundle.notCopied.map(entry => plain(entry.path)).filter(path => !theirFiles.has(path));

  // Who owns which path here: every document, folder and skill item of every item here. A path two items
  // share is never written for one of them, since that would change the other one as well.
  const resolve: Resolve = path => assetReference(path, input.roots);
  const ownership = targets.flatMap(entry => ownedHere(entry, resolve).map(owned => ({ ref: entry.ref, ...owned })));
  const othersOn = (ref: string, path: string): string[] => [
    ...new Set(ownership.filter(owned => owned.ref !== ref && pathsOverlap(owned.path, path)).map(owned => owned.ref)),
  ];
  const allocated = new Set(ownership.map(owned => owned.path));

  /**
   * Why writing an item's documents here is refused, or undefined when they can land somewhere. An item here
   * that names the whole asset tree owns every path in it, so no destination leaves that one as it was, and
   * the write is refused rather than the owner dropped from what decides where things land.
   */
  const blockedBy = (entry: Entry, found: Entry | undefined): string | undefined => {
    const owned = ownedOf(entry, found, resolve);
    const first = owned[0];
    if (first === undefined) return undefined;
    const owners = [
      ...new Set(
        ownership
          .filter(
            each =>
              each.path === ASSET_ROOT && (each.ref !== found?.ref || owned.some(mine => mine.target === ASSET_ROOT)),
          )
          .map(each => each.ref),
      ),
    ];
    return owners.length === 0 ? undefined : wholeTreeRefusal(first.source, owners);
  };

  /** Where a taken item's shared documents land instead, which skill items it leaves alone, and why. */
  const destinations = (
    entry: Entry,
    found: Entry,
  ): { relocated: Map<string, string>; sharedItems: string[]; note: string | undefined } => {
    const relocated = new Map<string, string>();
    const sharedItems: string[] = [];
    const sentences: string[] = [];
    for (const owned of ownedOf(entry, found, resolve)) {
      const item = entry.kind === 'skills' ? skillItemOf(owned.source) : undefined;
      if (item !== undefined) {
        const others = othersOn(found.ref, owned.source);
        if (others.length === 0) continue;
        sharedItems.push(item);
        sentences.push(`Skill ${item} is also used by ${others.join(', ')} here, so it stays as it is.`);
        continue;
      }
      // Where the review lists it: the folder here, or the source's own path when there is none in the tree.
      const lands = owned.target ?? owned.source;
      const others = othersOn(found.ref, lands);
      if (others.length === 0) continue;
      const moved = owned.directory
        ? movedFolder(owned.source, entry.name, found.name, allocated)
        : movedFile(owned.source, entry.name, found.name, allocated);
      allocated.add(moved);
      relocated.set(owned.source, moved);
      sentences.push(
        `${lands} is also used by ${others.join(', ')} here, so taking this writes it to ${moved} and leaves ${others.length === 1 ? 'that one' : 'those'} as ${others.length === 1 ? 'it is' : 'they are'}.`,
      );
    }
    return { relocated, sharedItems, note: sentences.length === 0 ? undefined : sentences.join(' ') };
  };

  /** Documents as each side compares them: what the bundle could not carry stands for itself on both. */
  const comparable = (
    entry: Entry,
    found: Entry | undefined,
  ): {
    readonly source: readonly CloneFile[];
    readonly target: readonly CloneFile[];
    readonly left: number;
  } => {
    const extraSource: CloneFile[] = [];
    const extraTarget: CloneFile[] = [];
    // Each omitted folder here, with where its contents sit on the source.
    const omitted: { readonly here: string; readonly there: string }[] = [];
    let left = 0;
    for (const owned of ownedOf(entry, found, resolve)) {
      for (const path of notCarried) {
        if (path !== owned.source && !path.startsWith(`${owned.source}/`)) continue;
        const rest = path.slice(owned.source.length + 1);
        left += 1;
        extraSource.push({ path: rest === '' ? owned.source : `${owned.source}/${rest}`, content: NOT_CARRIED });
        if (owned.target !== undefined) {
          const here = rest === '' ? owned.target : `${owned.target}/${rest}`;
          extraTarget.push({ path: here, content: NOT_CARRIED });
          omitted.push({ here, there: rest === '' ? owned.source : `${owned.source}/${rest}` });
        }
      }
    }
    // An omitted folder stands for what beneath it the source did not carry, here: that is never compared. A
    // file the source did carry is compared by its bytes on both sides, so an omission never hides one.
    const protectedHere = (file: CloneFile): boolean =>
      omitted.some(
        ({ here, there }) =>
          file.path.startsWith(`${here}/`) && !theirFiles.has(`${there}${file.path.slice(here.length)}`),
      );
    const targetDocuments = omitted.length === 0 ? targetFiles : targetFiles.filter(file => !protectedHere(file));
    return {
      source: extraSource.length === 0 ? bundle.files : [...extraSource, ...bundle.files],
      target: extraTarget.length === 0 ? targetDocuments : [...extraTarget, ...targetDocuments],
      left,
    };
  };

  /**
   * Every document a take would change, at the path it lands on here, and the ones it would remove. A
   * relocated document is written whole at its new path; a shared skill item is not written at all; a
   * document the source could not carry is neither listed nor removed.
   */
  const files = (
    entry: Entry,
    found: Entry | undefined,
    moved: { readonly relocated: ReadonlyMap<string, string>; readonly sharedItems: readonly string[] } = {
      relocated: new Map(),
      sharedItems: [],
    },
  ): { changes: CloneReviewItem['files'][number][]; removals: string[] } => {
    const changes: CloneReviewItem['files'][number][] = [];
    const removals: string[] = [];
    for (const owned of ownedOf(entry, found, resolve)) {
      const item = entry.kind === 'skills' ? skillItemOf(owned.source) : undefined;
      if (item !== undefined && moved.sharedItems.includes(item)) continue;
      const relocated = moved.relocated.get(owned.source);
      const theirs = under(theirFiles, owned.source, owned.directory);
      const mine =
        owned.target === undefined || relocated !== undefined
          ? new Map<string, string>()
          : under(myFiles, owned.target, owned.directory);
      const hidden = notCarried
        .filter(path => path === owned.source || path.startsWith(`${owned.source}/`))
        .map(path => path.slice(owned.source.length + 1));
      // A folder the source left out protects everything beneath it, not only the folder itself.
      const isHidden = (rest: string): boolean =>
        hidden.some(omitted => omitted === '' || rest === omitted || rest.startsWith(`${omitted}/`));
      const where = relocated ?? owned.target ?? owned.source;
      for (const rest of new Set([...theirs.keys(), ...mine.keys()])) {
        // Only what the source did not carry is protected: a carried file is a change like any other.
        if (isHidden(rest) && !theirs.has(rest)) continue;
        const path = rest === '' ? where : `${where}/${rest}`;
        const next = theirs.get(rest);
        const previous = mine.get(rest);
        if (next !== undefined && previous === undefined) {
          changes.push({ path, change: 'added', lines: { added: next.split('\n').length, removed: 0 } });
        } else if (next === undefined && previous !== undefined) {
          changes.push({ path, change: 'removed', lines: { added: 0, removed: previous.split('\n').length } });
          // Only a file inside a folder this item owns alone goes: a lone document the source stopped naming stays.
          if (owned.directory && rest !== '' && found !== undefined && othersOn(found.ref, path).length === 0) {
            removals.push(path);
          }
        } else if (next !== undefined && previous !== undefined && next !== previous) {
          changes.push({ path, change: 'changed', lines: lineDelta(previous, next) });
        }
      }
    }
    return {
      changes: changes.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
      removals: removals.toSorted(),
    };
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
      const blocked = blockedBy(entry, undefined);
      if (maybe === undefined && baseDigest !== undefined) {
        analysed.push({
          ref: landing(entry, entry.name),
          kind: entry.kind,
          outcome: 'removed-here',
          match: 'none',
          source: entry,
          ...(key === undefined ? {} : { key }),
          note: [
            baseDigest === theirDigest
              ? 'Not here: it was left out when last copied, or removed here since. It stays out unless you add it.'
              : 'Not here: it was left out when last copied, or removed here since, and it has changed on the source too. It stays out unless you add it.',
            blocked,
          ]
            .filter(sentence => sentence !== undefined)
            .join(' '),
          fields: [],
          files: files(entry, undefined).changes,
          stamp: false,
          digests: [theirDigest, '', baseDigest],
          usedBy: [],
          ambiguous: false,
          removals: [],
          ...(blocked === undefined ? {} : { blocked }),
        });
        continue;
      }
      const names = (maybe?.candidates ?? []).map(candidate => candidate.ref);
      const maybeNote =
        maybe === undefined
          ? undefined
          : maybe.claimed
            ? `${names.join(' and ')} here each say they are a copy of this, so none was picked. You may already have this as ${names.join(' or ')}.`
            : `You may already have this as ${names.join(' or ')}.`;
      const newNote = [maybeNote, blocked].filter(sentence => sentence !== undefined).join(' ');
      analysed.push({
        ref: landing(entry, entry.name),
        kind: entry.kind,
        outcome: 'new',
        match: 'none',
        source: entry,
        ...(key === undefined ? {} : { key }),
        ...(newNote === '' ? {} : { note: newNote }),
        fields: [],
        files: files(entry, undefined).changes,
        stamp: false,
        digests: [theirDigest, '', baseDigest ?? ''],
        usedBy: [],
        ambiguous: maybe !== undefined,
        removals: [],
        ...(blocked === undefined ? {} : { blocked }),
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
        removals: [],
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
      removals: [] as string[],
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
    // Only a write can touch another item's path, so only what may be taken is moved off a shared one.
    const writable = outcome === 'theirs' || outcome === 'both';
    const blocked = writable ? blockedBy(entry, found.target) : undefined;
    const moved = writable && blocked === undefined ? destinations(entry, found.target) : undefined;
    const listed = files(entry, found.target, moved);
    const said = [note, moved?.note, blocked].filter(sentence => sentence !== undefined).join(' ');
    analysed.push({
      ...common,
      ref: found.target.ref,
      outcome,
      ...(said === '' && partial === '' ? {} : { note: `${said}${partial}`.trim() }),
      fields: differingFields(entry, found.target, identity),
      files: listed.changes,
      stamp: false,
      ...(moved === undefined || moved.relocated.size === 0 ? {} : { relocated: moved.relocated }),
      ...(moved === undefined || moved.sharedItems.length === 0 ? {} : { sharedItems: moved.sharedItems }),
      removals: listed.removals,
      ...(blocked === undefined ? {} : { blocked }),
    });
  }

  // Items here that the source no longer holds.
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
      removals: [],
    });
  }

  // The logins.
  const logins: CloneReviewLogin[] = bundle.credentials.map(credential => {
    const matched = input.logins.matched.get(credential.id);
    if (matched !== undefined) return { sourceId: credential.id, outcome: 'matched', target: matched };
    const candidates = input.logins.ask.get(credential.id);
    // An environment login is copied as a new login of its own, so everything it runs with is listed.
    const entries = cloneLoginRunnable(credential);
    const runnable = entries === undefined ? {} : { runnable: { entries: [...entries] } };
    if (candidates !== undefined && candidates.length > 1) {
      return { sourceId: credential.id, outcome: 'ask', candidates: [...candidates], ...runnable };
    }
    return { sourceId: credential.id, outcome: 'slot', ...runnable };
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
      item.outcome === 'new'
        ? item.ambiguous || item.blocked !== undefined
          ? 'skip'
          : 'add'
        : item.outcome === 'theirs' && item.blocked === undefined
          ? 'take'
          : 'keep',
    );
  }
  const writes = (choice: CloneChoice | undefined): boolean => choice === 'take' || choice === 'add';
  const idle = (ref: string): CloneChoice => (byRef.get(ref)?.outcome === 'new' ? 'skip' : 'keep');
  // An item whose write is refused, or that needs one that is, can't be written by default. The set is
  // closed over the dependency graph first, so a dependent can never re-add what was left out for a refusal.
  const unwritable = new Set<string>();
  for (let grown = true; grown; ) {
    grown = false;
    for (const [ref, wanted] of needs) {
      if (unwritable.has(ref)) continue;
      if (wanted.some(need => unwritable.has(need) || byRef.get(need)?.blocked !== undefined)) {
        unwritable.add(ref);
        grown = true;
      }
    }
  }
  for (const ref of unwritable) {
    if (byRef.get(ref)?.outcome !== 'both') defaults.set(ref, idle(ref));
  }
  // What is left only ever goes from left out to added, so it settles: at most one pass per item.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [ref, wanted] of needs) {
      if (!writes(defaults.get(ref))) continue;
      for (const need of wanted) {
        if (writes(defaults.get(need)) || !byRef.has(need)) continue;
        defaults.set(need, 'add');
        changed = true;
      }
    }
  }

  const shown = analysed.filter(item => item.outcome !== 'same');
  // The semantic digests pair and compare items; they deliberately ignore paths and provenance, so they
  // cannot be all a review names. The fingerprint also binds the RAW state an apply acts on: every byte
  // and declaration the bundle carries (its omissions and login descriptors included), this machine's
  // declarations as they stand (destination paths, gone items and what uses them), the revision of every
  // document its items own, the record, and where each taken item lands and what it removes. Anything
  // that moves between the review and the apply asks for the review again.
  const fingerprint = sha256Hex(
    JSON.stringify({
      version: 1,
      source: source?.id ?? '',
      verified: source?.verified ?? '',
      sourceDaemon: input.sourceDaemon ?? '',
      items: analysed.map(item => [
        item.ref,
        item.source?.ref ?? '',
        item.outcome,
        item.match,
        item.stamp,
        ...item.digests,
        [...(item.relocated ?? [])],
        item.sharedItems ?? [],
        item.removals,
        item.usedBy,
      ]),
      logins: logins.map(login => [
        login.sourceId,
        login.outcome,
        login.target ?? '',
        login.candidates ?? [],
        login.runnable ?? null,
      ]),
      shown: shown.length,
      bundle: sha256Hex(JSON.stringify(bundle)),
      target: sha256Hex(JSON.stringify(target)),
      documents: [...myFiles].map(([path, content]) => [path, sha256Hex(content)]).toSorted(),
      base: base === undefined ? '' : sha256Hex(JSON.stringify(base)),
      skillItems: [...input.existingSkillItems].toSorted(),
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
export function reviewCloneUpdate(analysis: CloneAnalysis): CloneReview {
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
      // The record holds only instants the clock wrote, so each is already in the one canonical spelling.
      ...(input.base === undefined ? {} : { lastCopiedAt: input.base.lastCopiedAt as Instant }),
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
  readonly files: readonly CloneFile[];
  /**
   * Documents to remove, relative to the asset tree: the files the review listed as removed inside a folder
   * a taken item alone owns. Applied in the same batch as the writes and the record, or not at all.
   */
  readonly removals: readonly string[];
  /** Taken items moved off a path another item here shares, and where each landed. */
  readonly relocations: readonly { readonly reference: string; readonly from: string; readonly to: string }[];
  readonly slots: readonly {
    readonly id: string;
    readonly harness: HarnessKind;
    readonly runtimes: readonly string[];
    /** A copy of an environment login's configuration, as the review listed it, rather than an empty sign-in. */
    readonly environment?: true;
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
  given: CloneDecisions,
  skip: readonly string[] = [],
): ReadonlyMap<string, CloneChoice> {
  const byRef = new Map(analysis.items.filter(item => item.outcome !== 'same').map(item => [item.ref, item]));
  const decisions = withSkipped(analysis, given, skip);
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
  for (const item of byRef.values()) {
    if (item.blocked !== undefined && writes(chosen.get(item.ref))) throw new CloneRefusal(item.blocked);
  }
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
 * The decisions with every left-out item turned into the choice that writes nothing for it: `skip` for a
 * new item, `keep` for anything else. `skip` names items as the source does, so each is found by its source
 * ref; one naming nothing the source holds, or contradicting the person's own decision, is refused rather
 * than dropped. An item already the same needs nothing: it is never written.
 */
function withSkipped(analysis: CloneAnalysis, decisions: CloneDecisions, skip: readonly string[]): CloneDecisions {
  if (skip.length === 0) return decisions;
  const sourceName = analysis.input.sourceName ?? analysis.input.bundle.machine;
  const bySource = new Map(
    analysis.items.flatMap(item => (item.source === undefined ? [] : [[item.source.ref, item] as const])),
  );
  const merged: Record<string, CloneChoice> = { ...decisions };
  for (const reference of new Set(skip)) {
    const item = bySource.get(reference);
    if (item === undefined) {
      throw new CloneRefusal(`The setup from ${sourceName} has no ${reference} to leave out. Review it again.`);
    }
    if (item.outcome === 'same') continue;
    const allowed = CLONE_OUTCOME_CHOICES[item.outcome] as readonly CloneChoice[];
    const choice: CloneChoice = allowed.includes('skip') ? 'skip' : 'keep';
    const decided = merged[item.ref];
    if (decided !== undefined && decided !== choice) {
      throw new CloneRefusal(
        `${reference} is left out, but ${item.ref} is also set to "${decided}". Leave it out or choose "${decided}", not both.`,
      );
    }
    merged[item.ref] = choice;
  }
  return merged;
}

/**
 * The next setup and the documents to write. Throws {@link CloneRefusal} when the decisions leave a
 * `both` item unchosen, ask for what an item cannot do, or would leave a setup this machine cannot read.
 */
export function planCloneUpdate(analysis: CloneAnalysis, choices: CloneUpdateChoices): CloneUpdatePlan {
  const { input } = analysis;
  const { target, bundle } = input;
  const sourceName = input.sourceName ?? bundle.machine;
  const chosen = resolveCloneDecisions(analysis, choices.decisions, choices.skip);
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
  const resolveOwner: Resolve = path => assetReference(path, input.roots);
  const usedFiles = referencedFiles(target);
  for (const entry of itemsOfModel(target))
    for (const owned of ownedHere(entry, resolveOwner)) usedFiles.add(owned.path);
  // Where the review moved a taken item off a shared path is spoken for before anything new is placed.
  for (const item of analysis.items) for (const moved of item.relocated?.values() ?? []) usedFiles.add(moved);
  const theirContents = new Map(bundle.files.map(file => [plain(file.path), file.content]));
  const myContents = mapOf(canonicalFiles(input.targetFiles, input.roots));
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
  const removals: string[] = [];
  const relocations: { reference: string; from: string; to: string }[] = [];
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
  const slots = new Map<string, { id: string; harness: HarnessKind; environment?: true }>();
  const writtenRuntimes = analysis.items.filter(
    item =>
      item.kind === 'runtime' && item.source !== undefined && ['take', 'add'].includes(chosen.get(item.ref) ?? ''),
  );
  for (const item of writtenRuntimes) {
    const credential = String(item.source?.value.credential);
    if (loginFor.has(credential)) continue;
    // The bundle read as a setup above, so every login a runtime names is carried.
    const descriptor = bundle.credentials.find(
      candidate => candidate.id === credential,
    ) as (typeof bundle.credentials)[number];
    const asked = analysis.logins.find(login => login.sourceId === credential);
    const picked = loginChoices[credential];
    let here: string | undefined = analysis.input.logins.matched.get(credential);
    if (picked !== undefined && picked !== 'slot') {
      const existing = target.credentials[picked];
      if (existing === undefined || existing.harness !== harnessKindOfKey(descriptor.harness)) {
        throw new CloneRefusal(
          `${picked} isn't a ${harnessKindOfKey(descriptor.harness)} login on ${input.machine}. Pick another one.`,
        );
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
            harness: harnessKindOfKey(descriptor.harness),
            store: 'ferretry',
            ...(label === undefined ? {} : { label }),
            ...origin,
            ...keyed(`login/${credential}`),
          }
    ) as Credential;
    loginFor.set(credential, id);
    slots.set(id, {
      id,
      harness: harnessKindOfKey(descriptor.harness),
      ...(descriptor.store === 'environment' ? { environment: true as const } : {}),
    });
  }

  /**
   * One component as it is written here, under `name`: its document and folder follow the name. A taken one
   * lands exactly where its review listed it: the path the review moved it to off a shared one, else its own
   * here as the review read it (one canonical spelling, whatever alias names it), else the source's.
   */
  const writeComponent = (
    entry: Entry,
    name: string,
    here: Entry | undefined,
    relocated: ReadonlyMap<string, string>,
  ): void => {
    const kind = entry.kind as ComponentKind;
    const { clonedFrom: _from, clonedFromDaemon: _daemon, clonedFromKey: _key, ...own } = entry.value;
    const copy: Record<string, unknown> = { ...own, ...origin, ...keyed(entry.ref) };
    // The same reading of each path the review used, so the review and the write cannot land apart.
    const reviewed = new Map(
      here === undefined
        ? []
        : ownedOf(entry, here, resolveOwner).map(owned => [owned.source, owned.target ?? owned.source] as const),
    );
    const file = copy.file;
    if (typeof file === 'string' && isAssetRelative(file)) {
      const moved =
        relocated.get(plain(file)) ??
        fileMoves.get(file) ??
        reviewed.get(plain(file)) ??
        movedFile(file, entry.name, name, usedFiles);
      fileMoves.set(file, moved);
      usedFiles.add(moved);
      copy.file = moved;
    }
    const directory = copy.directory;
    if (typeof directory === 'string' && isAssetRelative(directory)) {
      const moved =
        relocated.get(plain(directory)) ??
        folderMoves.get(directory) ??
        reviewed.get(plain(directory)) ??
        movedFolder(directory, entry.name, name, usedFiles);
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
  };

  // Components first, then profiles, then runtimes: each one's references follow what was written.
  const order = (kind: ItemKind): number => (kind === 'profile' ? 1 : kind === 'runtime' ? 2 : 0);
  for (const item of analysis.items.toSorted((left, right) => order(left.kind) - order(right.kind))) {
    const choice = chosen.get(item.ref);
    const entry = item.source;
    if (item.outcome === 'same') {
      if (item.stamp && entry !== undefined && item.target !== undefined) {
        // Linked by name: the same item, so only the link is written.
        // A profile or runtime carries only the key, never where it came from.
        if (item.kind === 'profile') {
          profiles[item.target.name] = { ...item.target.value, ...keyed(entry.ref) } as unknown as LayeredProfile;
        } else if (item.kind === 'runtime') {
          runtimes[item.target.name] = { ...item.target.value, ...keyed(entry.ref) } as unknown as Runtime;
        } else {
          components[item.kind][item.target.name] = { ...item.target.value, ...origin, ...keyed(entry.ref) };
        }
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
      const theirProfile = source.profiles[entry.name] as LayeredProfile;
      profiles[name] = {
        // Every need was ticked or unticked together in resolveCloneDecisions, so each layer resolves.
        layers: strings(entry.value.layers).map(hereRef) as unknown as LayeredProfile['layers'],
        ...(theirProfile.compactAt === undefined ? {} : { compactAt: theirProfile.compactAt }),
        ...keyed(entry.ref),
      };
    } else if (item.kind === 'runtime') {
      const credential = loginFor.get(String(entry.value.credential)) as string;
      const profile = hereRef(`profile/${String(entry.value.profile)}`) as string;
      const theirRuntime = source.runtimes[entry.name] as Runtime;
      // Switched off here is this machine's own say, never the source's: a take keeps it, an add never copies it.
      const disabled = choice === 'take' ? target.runtimes[name]?.disabled : undefined;
      runtimes[name] = {
        credential,
        profile: profile.slice('profile/'.length),
        agent: theirRuntime.agent,
        ...(theirRuntime.harness === undefined ? {} : { harness: theirRuntime.harness }),
        ...(theirRuntime.compactAt === undefined ? {} : { compactAt: theirRuntime.compactAt }),
        ...(disabled === undefined ? {} : { disabled }),
        ...keyed(entry.ref),
      };
      slotRuntimes.set(credential, [...(slotRuntimes.get(credential) ?? []), name]);
      const harness = runtimeHarness(source, theirRuntime) as HarnessKind;
      if (!input.installed.includes(harness)) missingHarnesses.add(harness);
    } else {
      writeComponent(entry, name, item.target, item.relocated ?? new Map());
      for (const [from, to] of item.relocated ?? []) relocations.push({ reference: item.ref, from, to });
      // What the review listed as removed goes with the take, in the same batch: only files inside a folder
      // this item alone owns, never one the source could not carry.
      if (choice === 'take') removals.push(...item.removals);
    }
  }

  // Documents: each under the path its component now names, and only when its content differs.
  const files: CloneFile[] = [];
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
    // A skill item another item here lists too stays as it is: writing it would change that one as well.
    if (skillItem !== undefined && owner.sharedItems?.includes(skillItem) === true) {
      keptSkillItems.add(skillItem);
      continue;
    }
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
    removals: [...new Set(removals)].toSorted(),
    relocations,
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
    lines.push(
      slot.environment === true
        ? `Adds login ${slot.id} on ${machine} with the environment configuration the review listed; no existing login is changed.`
        : `Adds an empty login ${slot.id} on ${machine} that needs sign-in; no existing login is changed.`,
    );
  }
  for (const moved of plan.relocations) {
    lines.push(
      `Writes ${moved.reference} to ${moved.to}: its old path is shared with another item here, which stays as it is.`,
    );
  }
  if (plan.removals.length > 0) {
    lines.push(
      `Removes ${plural(plan.removals.length, 'file')} the source no longer has: ${plan.removals.join(', ')}.`,
    );
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
 * claiming one key is a question for the person, never a guess. Only then the shared sign-in matcher
 * (`matchCloneSignIn`: same harness, email case-insensitive, else exact label when neither side has an
 * email; two or more fits ask). `targetEmails` is login id → account email, as the credentials surface
 * reports it. An API-key (environment) login is config and is never sign-in matched. A login with no pairing
 * is an empty slot — an existing login is only ever pointed at, never rewritten (design §14.4).
 */
export function resolveCloneLogins(
  bundle: CloneBundle,
  target: AccountModel,
  base: CloneBaseSource | undefined,
  targetEmails: Readonly<Record<string, string | undefined>> = {},
): CloneLoginResolution {
  const keys = cloneOriginKeys(bundle);
  const matched = new Map<string, string>();
  const ask = new Map<string, readonly string[]>();
  const settle = (credential: CloneBundle['credentials'][number], found: readonly string[]): boolean => {
    if (found.length === 1 && found[0] !== undefined) matched.set(credential.id, found[0]);
    else if (found.length > 1) ask.set(credential.id, found);
    return found.length > 0;
  };
  const heldLogins = Object.entries(target.credentials).map(([id, held]) => ({
    id,
    harness: harnessKeyOfKind(held.harness),
    store: held.store,
    email: targetEmails[id],
    label: held.label,
  }));
  for (const credential of bundle.credentials) {
    const key = keys.get(`login/${credential.id}`);
    if (key !== undefined) {
      const linked = base?.items[key]?.login;
      const known = linked === undefined ? undefined : target.credentials[linked];
      if (linked !== undefined && known?.harness === harnessKindOfKey(credential.harness)) {
        matched.set(credential.id, linked);
        continue;
      }
      const claimants = Object.entries(target.credentials)
        .filter(([, held]) => held.clonedFromKey === key && held.harness === harnessKindOfKey(credential.harness))
        .map(([id]) => id)
        .toSorted();
      if (settle(credential, claimants)) continue;
    }
    // The record and the key said nothing: the shared sign-in matcher is next.
    if (credential.store === 'environment') continue;
    const fit = matchCloneSignIn(credential, heldLogins);
    settle(credential, fit.kind === 'one' ? [fit.id] : fit.kind === 'many' ? fit.ids : []);
  }
  return { matched, ask };
}
