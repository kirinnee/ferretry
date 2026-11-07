/**
 * Shells' wire schemas. Shells are NEW in 5.0 (today ferrets inherit the project's direnv), so there is nothing to
 * copy: these follow design §3.2 (every executable input resolved and pinned at install), §4.9 (the `shell` item) and
 * §9.2 (the files). Strict objects throughout.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A shell's name: also the file name under `config/shells/` and `state/shells/locks/`. */
export const ShellNameSchema = z.string().max(64).regex(NAME);
export type ShellName = z.infer<typeof ShellNameSchema>;

/** A nix store hash of a fetched input, `sha256-<base64>` (SRI). The cache key. */
export const NarHashSchema = z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/u);
export type NarHash = z.infer<typeof NarHashSchema>;

const PackageAttrSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u);

/** A nixpkgs pinned by revision and hash: what a package list builds against. */
export const PinnedNixpkgsSchema = z.strictObject({ rev: z.string().regex(/^[0-9a-f]{40}$/u), narHash: NarHashSchema });
export type PinnedNixpkgs = z.infer<typeof PinnedNixpkgsSchema>;

/**
 * `config/shells/<name>.yaml`: either a flake reference (`github:me/shells/<rev>#web`) or a package list on a pinned
 * nixpkgs. A flake reference must be locked (carry a revision) unless the item says `floating: true`; a floating one is
 * resolved at install, shown with what it resolved to, and asks again whenever it resolves differently (§3.2).
 */
export const ShellItemSchema = z
  .strictObject({
    description: z.string().max(300).optional(),
    flake: z.string().min(1).optional(),
    packages: z.array(PackageAttrSchema).min(1).optional(),
    /** A package list builds on this nixpkgs; absent means the one Ferretry pinned at install. */
    nixpkgs: PinnedNixpkgsSchema.optional(),
    floating: z.boolean().default(false),
    /** Effective only after the config door obtains owner approval for these bytes. */
    approvedHash: NarHashSchema.optional(),
  })
  .refine(item => (item.flake === undefined) !== (item.packages === undefined), {
    message: 'a shell is a flake reference or a package list, not both and not neither',
  })
  .refine(item => item.flake === undefined || item.nixpkgs === undefined, {
    message: 'a flake reference brings its own inputs; nixpkgs is for a package list',
  });
export type ShellItem = z.infer<typeof ShellItemSchema>;

/** What an install resolved a shell to (`state/shells/locks/<name>.json`). */
export const ShellLockSchema = z.strictObject({
  format: z.literal(1),
  name: ShellNameSchema,
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('flake'),
      ref: z.string().min(1),
      rev: z.string().min(1),
      narHash: NarHashSchema,
    }),
    z.strictObject({
      kind: z.literal('packages'),
      packages: z.array(PackageAttrSchema).min(1),
      nixpkgs: PinnedNixpkgsSchema,
    }),
  ]),
  resolvedAt: InstantSchema,
  /** A floating source asks again whenever it resolves to another hash. */
  floating: z.boolean(),
});
export type ShellLock = z.infer<typeof ShellLockSchema>;

export const ShellBuildStateSchema = z.enum(['not-built', 'building', 'built', 'failed']);
export type ShellBuildState = z.infer<typeof ShellBuildStateSchema>;

export const ShellSummarySchema = z.strictObject({
  name: ShellNameSchema,
  description: z.string().optional(),
  kind: z.enum(['flake', 'packages']),
  locked: z.boolean(),
  floating: z.boolean(),
  narHash: NarHashSchema.optional(),
  build: ShellBuildStateSchema,
  /** The runtimes and projects that name this shell as their default. */
  usedBy: z.array(z.string()),
});
export type ShellSummary = z.infer<typeof ShellSummarySchema>;

export const ShellListSchema = z.strictObject({ shells: z.array(ShellSummarySchema) });

/** `GET /v1/shells/nix`: whether nix is on this machine. Without it ferrets use the machine's tools, and onboarding says so. */
export const NixFactsSchema = z.discriminatedUnion('present', [
  z.strictObject({ present: z.literal(true), version: z.string().min(1), path: z.string().min(1) }),
  z.strictObject({ present: z.literal(false), consequence: z.string().min(1), remedy: z.string().min(1) }),
]);
export type NixFacts = z.infer<typeof NixFactsSchema>;

/** `POST /v1/shells/preview` and `POST /v1/shells`: the item to resolve. Preview writes nothing. */
export const ShellAddRequestSchema = z.strictObject({ name: ShellNameSchema, item: ShellItemSchema });
export type ShellAddRequest = z.infer<typeof ShellAddRequestSchema>;

/** Must match preview exactly. This request does not itself grant owner approval. */
export const ShellRelockRequestSchema = z.strictObject({ expectedHash: NarHashSchema });
export type ShellRelockRequest = z.infer<typeof ShellRelockRequestSchema>;

/** What resolving shows the owner before the yes: the locked reference and hash, and whether it differs from the last lock. */
export const ShellPreviewSchema = z.strictObject({
  name: ShellNameSchema,
  lock: ShellLockSchema,
  /** Present when a lock already exists and the resolved hash differs: the owner must say yes again. */
  changedFrom: NarHashSchema.optional(),
  /** Candidate only: confirm the held config edit, then retry relock. The active lock stays in effect. */
  held: z.array(z.string()).optional(),
});
export type ShellPreview = z.infer<typeof ShellPreviewSchema>;

/** `GET /v1/shells/:name`: the item, what it was locked to (if it was), and its summary. */
export const ShellDetailSchema = z.strictObject({
  name: ShellNameSchema,
  item: ShellItemSchema,
  lock: ShellLockSchema.optional(),
  summary: ShellSummarySchema,
});
export type ShellDetail = z.infer<typeof ShellDetailSchema>;

/**
 * `POST /v1/shells`: what was pinned. `held` is present while the owner's yes is still to come: a new shell will run
 * a nix build, so its item waits in the held list until it is confirmed (§3.2).
 */
export const ShellAddedSchema = z.strictObject({
  name: ShellNameSchema,
  lock: ShellLockSchema,
  held: z.array(z.string()).optional(),
});
export type ShellAdded = z.infer<typeof ShellAddedSchema>;
export const ShellRemovedSchema = z.strictObject({ name: ShellNameSchema, removed: z.literal(true) });

export const ShellBuildResultSchema = z.strictObject({
  name: ShellNameSchema,
  narHash: NarHashSchema,
  /** `cached` when the build was already in `state/shells/cache/<narHash>/`. */
  outcome: z.enum(['built', 'cached']),
  builtAt: InstantSchema,
});
export type ShellBuildResult = z.infer<typeof ShellBuildResultSchema>;

/** The refusal codes the shell routes answer with. */
export const SHELL_CODES = {
  unknown: 'shell_unknown',
  noNix: 'shell_no_nix',
  unlocked: 'shell_unlocked',
  hashChanged: 'shell_hash_changed',
  buildFailed: 'shell_build_failed',
  exists: 'shell_exists',
  invalid: 'shell_invalid',
  /** The daemon has no door to write `config/` with, so it can show shells but not change them. */
  noConfigDoor: 'shell_config_unavailable',
} as const;

/** `state/shells/cache/<narHash>/`: a built shell's environment; dropped and rebuilt freely. */
export const ShellCacheKeySchema = NarHashSchema;
