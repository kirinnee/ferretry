/**
 * What a runtime's profile stack names, and the one act that edits a profile's layers. MCP and Skills read the layers
 * to know which of their items a runtime launches with, and add or remove ONE `mcp/<name>` or `skills/<name>` layer
 * when an item is installed or removed. The item is the owner's to write first; Runtimes only edits the profile files
 * that name it, through its own config writer, so no plugin ever writes another plugin's file.
 */
import type { RuntimeId } from './index.ts';

/** What a runtime's profile stack names, resolved through `profile/<base>` layers, in layer order (oldest first). */
export interface RuntimeLayers {
  readonly runtime: RuntimeId;
  readonly profile: string;
  readonly mcp: readonly string[];
  readonly skills: readonly string[];
}

/** One profile: the layers it names as written (oldest first) and the etag of its file right now. */
export interface ProfileSummary {
  readonly name: string;
  readonly layers: readonly string[];
  readonly etag: string;
}

/** A layer a caller may add or remove: an MCP server or a skill, named `mcp/<name>` or `skills/<name>`. */
export type ProfileLayerName = `mcp/${string}` | `skills/${string}`;

export type ProfileLayerChange =
  | {
      readonly kind: 'add';
      readonly profile: string;
      readonly layer: ProfileLayerName;
      /** The etag the caller read the profile at; a profile that moved since is a `conflict` and nothing is written. */
      readonly ifMatch?: string;
    }
  /** Every profile that names the layer loses it, and no other file is touched. */
  | { readonly kind: 'remove-everywhere'; readonly layer: ProfileLayerName };

export type ProfileLayerOutcome =
  | { readonly kind: 'written'; readonly profiles: readonly string[] }
  | { readonly kind: 'held'; readonly sentence: string }
  | { readonly kind: 'conflict'; readonly profile: string }
  | {
      readonly kind: 'refused';
      readonly code: 'fleet_change_unknown' | 'fleet_change_refused';
      readonly sentence: string;
    };

export interface RuntimeLayersApi {
  /** Every profile with the layers it names and its file's etag, in name order. Read live. */
  profiles(): Promise<readonly ProfileSummary[]>;
  /**
   * What this runtime's profile stack names, or `undefined` for a runtime that does not exist. A profile stack that
   * cannot be resolved (a base that does not exist, a loop of bases) rejects with a sentence: never a guess.
   */
  layers(runtime: RuntimeId): Promise<RuntimeLayers | undefined>;
  /**
   * ONE profile write (`add`), or one write per profile naming the layer (`remove-everywhere`), through the config
   * writer. `governance` is the caller's standing (`CallerGovernance`); a caller whose standing is unknown or may not
   * change the fleet is refused, as `apply` refuses it, with nothing written.
   */
  changeProfileLayers(change: ProfileLayerChange, governance?: unknown): Promise<ProfileLayerOutcome>;
}

/** The read models of {@link RuntimeLayersApi}; `changeProfileLayers` is an act, never a read model. */
export const RUNTIME_LAYER_READ_MODELS = ['profiles', 'layers'] as const;
