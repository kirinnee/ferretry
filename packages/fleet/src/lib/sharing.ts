/**
 * Shared fleet assets: which documents a fleet offers to every account, and who is actually using
 * one.
 *
 * ## What was missing, and what this is not
 *
 * Sharing an asset has always been expressible. Several accounts naming one path in the asset tree
 * get one source copied into each home, and the starter configuration already does exactly that —
 * `profiles.base.memory` points every account at one `CLAUDE.md`. What did not exist was any way to
 * *say so*: nothing declared which paths were the shared ones, nothing reported per account whether
 * its instructions were that shared document or its own copy, and there was no operation for moving
 * an account between the two. A surface therefore had to infer sharing from string equality across a
 * composition chain it could not see, which is to say it could not.
 *
 * So this module adds a **declaration and a report**, not a second mechanism. `config.shared` names
 * documents; an account uses one by naming it in the composition chain exactly as before; and
 * {@link resolveFleetSharing} answers, per account and per field, which of the two it is and where
 * the value came from. Nothing here materializes anything: the plan builder still emits the same copy
 * operations, so a link takes effect on the next reviewed apply like every other change.
 *
 * ## Why this is not the shared-history pool
 *
 * `shared-history.ts` pools one harness-owned directory per account home and replaces each with a
 * symlink into it. That is right for state the harness writes and Ferretry never does — transcripts,
 * prompt history, todos. It is wrong for assets, and not by a little: every asset path is a
 * destination the fleet plan **writes on every apply**. Pooling one would give a single inode two
 * owners, and the pool's own rename-based migration would move the fleet's copy into the pool where
 * the next apply overwrites it — so one account's instructions would silently become everyone's, or
 * the shared default would silently become one account's. The pool's contract ("Ferretry never writes
 * this") and the asset contract ("the fleet writes this every apply") cannot both hold for one path.
 *
 * The property the pool exists to protect is preserved rather than abandoned. A pooled rename must
 * never cross a filesystem device because a copy would hand every reader a new inode; here there is
 * no rename at all — shared documents already live in one place, and the only writes are the
 * configuration and a new private copy, both inside the provisioner's existing capture-and-rollback
 * boundary. Migration is a *declaration*: registering the path a fleet already shares makes every
 * account that references it recognised as sharing it, and moves nothing.
 *
 * ## Identity and auth are never shared
 *
 * The same line the pool draws, drawn by the schema rather than by convention. Everything shareable
 * is a field of `Profile`; an account's identity and its provider login are fields of `AccountRoute`
 * and `Agent`, which no profile, variant or overlay can express — `ProfileSchema` is strict, so a
 * configuration that tried would fail to parse. {@link PER_ACCOUNT_FIELDS} names them so the fact has
 * an owner and a test rather than only a paragraph.
 *
 * Pure throughout: no filesystem, no clock, no environment.
 */
import { ASSET_FIELD_SHAPES, type AssetField, HARNESS_ASSETS, unsupportedAssetFields } from './assets.ts';
import type { FleetConfig, SettingsLayer } from './config.ts';
import type { HarnessKind } from './manifest.ts';
import { canonicalAssetReference } from './paths.ts';
import { type CompositionOrigin, compositionSlots, flattenForKind, settingsLayersOf } from './profiles.ts';

/**
 * The asset fields a shared document may supply. Every one of them is a `Profile` field, which is
 * what makes it reachable from a slot more than one account reads.
 */
export const SHAREABLE_FIELDS: readonly AssetField[] = ['settings', 'memory', 'skills', 'hooks', 'hooksDir', 'mcp'];

/**
 * The fields `link` and `unlink` operate on: every shareable field except `settings`.
 *
 * `settings` is deliberately absent, and this is the one asymmetry worth reading. Every other field
 * is a scalar the last slot wins outright, so "use the shared one" has exactly one meaning. Settings
 * is a *stack* that is deep-merged left to right, which is what makes a shared base plus a
 * per-account override possible at all — and it is also why "link" has no meaning there: it would
 * have to choose a position in the stack, and a shared layer inserted in the wrong place is silently
 * overridden or silently overriding. The report below still classifies every layer, so a person can
 * see which of them are shared documents; changing the stack stays the existing overlay edit, where
 * the order is written down and reviewed.
 */
export type LinkableField = Exclude<AssetField, 'settings'>;

export const LINKABLE_FIELDS: readonly LinkableField[] = ['memory', 'skills', 'hooks', 'hooksDir', 'mcp'];

/**
 * Everything that is an account's own and can never come from a shared slot.
 *
 * These are `AccountRoute` and `Agent` fields. They are listed here as the *statement* of the rule —
 * a test compares this list against what a profile can express, so the schema is what enforces it.
 * Provider account name, display name, lane, mode and default model all live here, which is why a
 * shared configuration layer cannot flatten a fleet into one indistinguishable account.
 */
export const PER_ACCOUNT_FIELDS: readonly string[] = [
  'id',
  'wrapper',
  'home',
  'mode',
  'displayName',
  'defaultModel',
  'models',
  'available',
  'unavailableReason',
  'auth',
  'identity',
  'routes',
];

/** The conventional name for the document a fleet offers to everything by default. */
export const DEFAULT_SHARED_NAME = 'default';

/** The asset-tree directory a privately materialized copy is written under, per account. */
export const ACCOUNT_ASSET_PREFIX = 'accounts';

/** One declared shared document and every account whose effective value for that field is it. */
export interface SharedAssetDocument {
  readonly field: AssetField;
  readonly name: string;
  readonly path: string;
  /**
   * Account ids using this document, in fleet order. Ids rather than a count, because "shared with
   * these four" is the fact a person acts on, and the registry is small enough to carry them.
   */
  readonly accounts: readonly string[];
}

/**
 * What one account's asset field is.
 *
 * `local` means the path is not a declared shared document — which is not the same as "only this
 * account uses it". `referrers` is how many accounts in the fleet resolve this field to this same
 * path, so `local` with more than one referrer is a document a fleet is already sharing without
 * having said so, and exactly the thing "declare this as the shared default" would fix.
 */
export type AssetSharing =
  | { readonly state: 'absent' }
  | {
      readonly state: 'shared';
      readonly name: string;
      readonly path: string;
      readonly origin: CompositionOrigin;
      readonly referrers: number;
    }
  | {
      readonly state: 'local';
      readonly path: string;
      readonly origin: CompositionOrigin;
      readonly referrers: number;
    };

/** One layer of an account's settings stack, in stack order. Reported, never linkable. */
export type SettingsLayerSharing =
  | { readonly position: number; readonly kind: 'inline'; readonly origin: CompositionOrigin }
  | {
      readonly position: number;
      readonly kind: 'document';
      readonly path: string;
      /** The shared name of this document, or absent when it is not a declared shared one. */
      readonly name: string | undefined;
      readonly origin: CompositionOrigin;
      readonly referrers: number;
    };

export interface AccountSharing {
  readonly accountId: string;
  readonly kind: HarnessKind;
  readonly wrapper: string;
  readonly displayName: string;
  /** Every linkable field, whether or not this account declares one. */
  readonly fields: Readonly<Record<LinkableField, AssetSharing>>;
  /** The settings stack in merge order. Empty when this account layers no settings. */
  readonly settings: readonly SettingsLayerSharing[];
  /**
   * The fields this account can actually be linked or unlinked, so a surface never offers a control
   * whose apply would be refused. A field this harness has no destination for is excluded here
   * rather than left for the plan builder to reject.
   */
  readonly linkable: readonly LinkableField[];
}

export interface FleetSharing {
  /** Every declared shared document, field by field, in declaration order. */
  readonly documents: readonly SharedAssetDocument[];
  readonly accounts: readonly AccountSharing[];
}

/** Whether two references name one document. An absent reference names nothing, never everything. */
function sameReference(left: string | undefined, right: string): boolean {
  return left !== undefined && canonicalAssetReference(left) === canonicalAssetReference(right);
}

/** The path a shared name resolves to, or `undefined` when this fleet declares no such document. */
export function sharedAssetPath(config: FleetConfig, field: AssetField, name: string): string | undefined {
  return config.shared[field][name];
}

/** The declared shared names for one field, in declaration order. */
export function sharedAssetNames(config: FleetConfig, field: AssetField): readonly string[] {
  return Object.keys(config.shared[field]);
}

/**
 * The shared name a path carries for one field, or `undefined` when the path is not declared.
 *
 * Exported because it answers a question a caller has in the other direction too: before writing a
 * new document to a path, whether that path is one the fleet has already promised to everybody.
 */
export function sharedAssetNameOf(config: FleetConfig, field: AssetField, path: string): string | undefined {
  for (const [name, declared] of Object.entries(config.shared[field])) {
    if (canonicalAssetReference(declared) === canonicalAssetReference(path)) return name;
  }
  return undefined;
}

/** One account's resolved value for each shareable field, with the slot that supplied it. */
interface ResolvedField {
  readonly value: string;
  readonly origin: CompositionOrigin;
}

interface ResolvedSettingsLayer {
  readonly layer: SettingsLayer;
  readonly origin: CompositionOrigin;
}

interface ResolvedSharingSource {
  readonly accountId: string;
  readonly kind: HarnessKind;
  readonly wrapper: string;
  readonly displayName: string;
  readonly fields: ReadonlyMap<LinkableField, ResolvedField>;
  readonly settings: readonly ResolvedSettingsLayer[];
}

/**
 * Reduce one route's composition chain, keeping the slot each winning value came from.
 *
 * The chain itself comes from {@link compositionSlots}, so the precedence this observes is the same
 * one {@link resolveAccounts} materializes rather than a second reading of it.
 */
function resolveWithOrigins(config: FleetConfig): readonly ResolvedSharingSource[] {
  const sources: ResolvedSharingSource[] = [];
  for (const agent of config.agents) {
    for (const [variantName, route] of Object.entries(agent.routes)) {
      const fields = new Map<LinkableField, ResolvedField>();
      const settings: ResolvedSettingsLayer[] = [];
      for (const slot of compositionSlots(config, agent, variantName, route)) {
        const flat = flattenForKind(slot.layer, agent.kind);
        for (const field of LINKABLE_FIELDS) {
          const value = flat[field];
          if (value !== undefined) fields.set(field, { value, origin: slot.origin });
        }
        // Settings accumulate rather than replace, so every slot's layers are kept in merge order.
        for (const layer of settingsLayersOf(flat.settings)) settings.push({ layer, origin: slot.origin });
      }
      sources.push({
        accountId: route.id,
        kind: agent.kind,
        wrapper: route.wrapper,
        displayName: route.displayName ?? route.wrapper,
        fields,
        settings,
      });
    }
  }
  return sources;
}

/** How many accounts resolve one field to one path. Counted over the whole fleet, once. */
function referrerCounts(sources: readonly ResolvedSharingSource[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const bump = (field: string, path: string): void => {
    const key = `${field}:${canonicalAssetReference(path)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const source of sources) {
    for (const [field, resolved] of source.fields) bump(field, resolved.value);
    // A settings document counted twice for one account would report a fleet of one as a fleet of two.
    const documents = new Set(source.settings.flatMap(entry => (typeof entry.layer === 'string' ? [entry.layer] : [])));
    for (const path of documents) bump('settings', path);
  }
  return counts;
}

const referrersOf = (counts: ReadonlyMap<string, number>, field: string, path: string): number =>
  counts.get(`${field}:${canonicalAssetReference(path)}`) ?? 0;

/**
 * The whole sharing picture for one configuration: what is offered, and who uses it.
 *
 * Derived from the configuration alone, so it describes what the *next* apply will materialize rather
 * than what is currently on disk. That is the useful direction for a surface offering a change: the
 * report and the plan it will produce are read from one document.
 */
export function resolveFleetSharing(config: FleetConfig): FleetSharing {
  const sources = resolveWithOrigins(config);
  const counts = referrerCounts(sources);

  const documents: SharedAssetDocument[] = [];
  for (const field of SHAREABLE_FIELDS) {
    for (const [name, path] of Object.entries(config.shared[field])) {
      const accounts = sources
        .filter(source =>
          field === 'settings'
            ? source.settings.some(entry => typeof entry.layer === 'string' && sameReference(entry.layer, path))
            : sameReference(source.fields.get(field)?.value, path),
        )
        .map(source => source.accountId);
      documents.push({ field, name, path, accounts });
    }
  }

  const accounts = sources.map(source => {
    const unsupported = new Set(unsupportedAssetFields(HARNESS_ASSETS, source.kind));
    const sharingOf = (field: LinkableField): AssetSharing => {
      const resolved = source.fields.get(field);
      if (resolved === undefined) return { state: 'absent' };
      const name = sharedAssetNameOf(config, field, resolved.value);
      const referrers = referrersOf(counts, field, resolved.value);
      return name === undefined
        ? { state: 'local', path: resolved.value, origin: resolved.origin, referrers }
        : { state: 'shared', name, path: resolved.value, origin: resolved.origin, referrers };
    };
    // Annotated and spelled out, so a newly added linkable field is a compile error here rather than
    // a field silently missing from every report.
    const fields: Readonly<Record<LinkableField, AssetSharing>> = {
      memory: sharingOf('memory'),
      skills: sharingOf('skills'),
      hooks: sharingOf('hooks'),
      hooksDir: sharingOf('hooksDir'),
      mcp: sharingOf('mcp'),
    };
    return {
      accountId: source.accountId,
      kind: source.kind,
      wrapper: source.wrapper,
      displayName: source.displayName,
      fields,
      settings: source.settings.map((entry, position) =>
        typeof entry.layer === 'string'
          ? {
              position,
              kind: 'document' as const,
              path: entry.layer,
              name: sharedAssetNameOf(config, 'settings', entry.layer),
              origin: entry.origin,
              referrers: referrersOf(counts, 'settings', entry.layer),
            }
          : { position, kind: 'inline' as const, origin: entry.origin },
      ),
      linkable: LINKABLE_FIELDS.filter(field => !unsupported.has(field)),
    };
  });

  return { documents, accounts };
}

/** One account's sharing report, or `undefined` when this fleet declares no such account. */
export function accountSharing(sharing: FleetSharing, accountId: string): AccountSharing | undefined {
  return sharing.accounts.find(account => account.accountId === accountId);
}

/**
 * Where a private copy of a shared document goes when an account unlinks from it.
 *
 * Under the account's own wrapper name, which the configuration schema already proves unique across
 * the fleet — so two accounts unlinking the same document can never compose the same destination and
 * silently share the copy they each asked to own privately.
 */
export function accountAssetPath(wrapper: string, sharedPath: string): string {
  const name = sharedPath.split('/').filter(Boolean).at(-1) ?? sharedPath;
  return `${ACCOUNT_ASSET_PREFIX}/${wrapper}/${name}`;
}

/**
 * Why this field cannot be privately materialized, or `undefined` when it can.
 *
 * A directory is the honest refusal rather than the worked-around one. The reviewed asset surface
 * writes text documents: one path, one body, one expected digest, inside the provisioner's rollback
 * boundary. A skills directory is an unbounded tree, and "copy it" is a plan operation that does not
 * exist — inventing one that writes into the asset tree on every apply would also have to decide what
 * to do when the account has since edited its copy, which is a destructive question nobody asked.
 * So the operation is refused with the manual remedy instead of being half-implemented.
 */
export function unlinkableReason(field: AssetField): string | undefined {
  if (ASSET_FIELD_SHAPES[field] !== 'directory') return undefined;
  return `"${field}" names a directory, and a private copy of a directory is not something the reviewed asset editor can write; copy the shared directory to a new asset path yourself and point this account at it`;
}

/**
 * Why this path cannot be the source of a private copy, or `undefined` when it can.
 *
 * The asset editor reads inside the fleet's own asset tree and nowhere else, so a shared document an
 * operator declared as `~/notes.md` or `/etc/x` can be linked and copied into homes by an apply but
 * cannot be *read* here to seed a private copy. Saying which one it is beats a read that fails later
 * with a path the person did not name.
 */
export function unreadableSourceReason(path: string): string | undefined {
  if (!path.startsWith('/') && !path.startsWith('~') && !path.startsWith('$HOME')) return undefined;
  return `the shared document at "${path}" is outside this fleet's asset tree, so its text cannot be read here; copy it to an asset path yourself and point this account at it`;
}
