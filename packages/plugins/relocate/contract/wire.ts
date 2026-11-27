import { InstantSchema } from '@ferretry/std';
import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * Move a ferret to another machine (C-45): the wire of the SOURCE end. The app holds a session on both daemons and
 * carries ciphertext between them; no daemon talks to another, and no secret value, credential file or ignored file is
 * in what is sealed (the table below is the whole of what moves, as data).
 */

export const RELOCATE_FORMAT = 1;
/** Plaintext bytes per sealed chunk. A chunk is one request over a phone's relay, so it stays small. */
export const RELOCATE_CHUNK_BYTES = 1024 * 1024;
/** A bundle over this is refused at preflight, naming what is large (owner-ruled estimate; a bigger move is a later unit). */
export const RELOCATE_MAX_BUNDLE_BYTES = 500 * 1024 * 1024;
/** One file over this is refused at preflight and named; the whole is read into memory a file at a time. */
export const RELOCATE_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** How long a sealed export waits to be fetched and completed before it is forgotten. */
export const RELOCATE_EXPORT_TTL_MS = 15 * 60 * 1000;
/** The source never holds more than this many sealed exports at once: each one is a whole bundle in memory. */
export const RELOCATE_MAX_OPEN_EXPORTS = 1;

/** The kinds of entry a sealed bundle holds, in the order it holds them. */
export const BundleEntryKindSchema = z.enum([
  'ferret-record',
  'journal',
  'session',
  'conversation',
  'worktree-commits',
  'worktree-changes',
  'worktree-file',
]);
export type BundleEntryKind = z.infer<typeof BundleEntryKindSchema>;

/** One row of the table a person reads before agreeing: what moves, or what stays and why. */
export interface MoveRow {
  readonly id: string;
  readonly label: string;
  readonly why?: string;
}

/**
 * WHAT MOVES. Everything here is hashed per file and sealed to the target's key.
 */
export const MOVES = [
  { id: 'ferret-record', label: 'Its name, role, harness, runtime name, model and effort' },
  { id: 'journal', label: 'Its history (`history.jsonl`)' },
  { id: 'turns', label: 'Every turn document it was given' },
  { id: 'channel', label: 'The long messages that were queued to it' },
  { id: 'attachments', label: 'The files it was handed' },
  { id: 'conversation', label: 'Its conversation, byte for byte, in its own harness’s format' },
  { id: 'worktree-commits', label: 'Its branch, as the commits the project’s remote does not have' },
  { id: 'worktree-changes', label: 'Uncommitted changes to tracked files' },
  { id: 'worktree-untracked', label: 'New files git does not ignore' },
] as const satisfies readonly MoveRow[];

/**
 * WHAT DOES NOT MOVE, and why. A row here is also a promise: `snapshot.ts` has a test per row that proves it is absent
 * from the sealed bundle (the manifest is read back after opening it with the test key).
 */
export const STAYS = [
  {
    id: 'session-credential',
    label: 'The ferret’s own sign-in to this machine',
    why: '`environment.json` and `tokens.json` are credentials: the other machine mints its own.',
  },
  {
    id: 'harness-secrets',
    label: 'The harness’s sign-in and caches',
    why: '`auth.json`, `session-env`, `paste-cache` and `shell-snapshots` can hold secrets. The other machine uses its own login for the same harness.',
  },
  {
    id: 'ignored-files',
    label: 'Files git ignores (`node_modules`, `.env`, build output)',
    why: '`.env` is a secret and the rest is rebuilt. They are listed by name so you see what stays.',
  },
  {
    id: 'secret-named-files',
    label: 'Any new file named like a secret (`.env`, `*.pem`, `id_*`, `auth.json`)',
    why: 'A name that says secret never travels, even when git does not ignore it.',
  },
  {
    id: 'secret-values',
    label: 'Secrets and logins',
    why: 'No secret value crosses. The other machine uses its own by name; copy a missing one with “Copy secrets”.',
  },
  {
    id: 'browser',
    label: 'Browser pages, identities and cookies',
    why: 'Logins live where their profile is.',
  },
  {
    id: 'jobs',
    label: 'Background jobs and terminals',
    why: 'A move refuses while one is running.',
  },
  {
    id: 'ledger',
    label: 'Conversation’s delivery record, agenda items and board tasks',
    why: 'They stay here with the stub; the conversation carries the words.',
  },
] as const satisfies readonly MoveRow[];

// ─── the offer the target opened, and the bundle sealed to it ──────────────────────────────────────────────────────────

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
export const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u);
export const OfferIdSchema = z.string().regex(/^fy_relocate_offer_[A-Za-z0-9_-]{16,64}$/u);

/** What the TARGET opens: a one-time X25519 key, signed with its daemon identity. The source only checks and uses it. */
export const RelocateOfferSchema = z.strictObject({
  v: z.literal(RELOCATE_FORMAT),
  offerId: OfferIdSchema,
  daemonId: DaemonIdSchema,
  /** The target's Ed25519 identity key (SPKI, base64url): it must fingerprint to `daemonId`. */
  identityKey: Base64UrlSchema,
  /** The one-time X25519 public key the bundle is sealed to. */
  publicKey: Base64UrlSchema,
  expiresAt: InstantSchema,
  /** The identity's signature over the other fields. */
  signature: Base64UrlSchema,
});
export type RelocateOffer = z.infer<typeof RelocateOfferSchema>;

/** The header every chunk's AEAD tag authenticates (with the chunk's index): nothing here is secret. */
export const BundleHeaderSchema = z.strictObject({
  v: z.literal(RELOCATE_FORMAT),
  offerId: OfferIdSchema,
  sourceDaemonId: DaemonIdSchema,
  targetDaemonId: DaemonIdSchema,
  expiresAt: InstantSchema,
  /** The source's one-time X25519 public key. */
  ephemeralKey: Base64UrlSchema,
  chunks: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
});
export type BundleHeader = z.infer<typeof BundleHeaderSchema>;

/** The first thing inside the sealed bundle: every entry, its size and its SHA-256, so the target verifies before it writes. */
export const BundleManifestSchema = z.strictObject({
  v: z.literal(RELOCATE_FORMAT),
  ferret: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }),
  worktree: z
    .strictObject({
      branch: z.string().min(1).optional(),
      head: z.string().regex(/^[0-9a-f]{40,64}$/u),
    })
    .optional(),
  entries: z.array(
    z.strictObject({
      kind: BundleEntryKindSchema,
      /** A plain relative path (below the area it came from); never absolute, never `..`. */
      path: z.string().min(1).max(1024),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  ),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

// ─── the four routes ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PreflightRequestSchema = z.strictObject({ to: DaemonIdSchema });
export type PreflightRequest = z.infer<typeof PreflightRequestSchema>;

export const MoveRowSchema = z.strictObject({ id: z.string(), label: z.string(), why: z.string().optional() });

export const PreflightResponseSchema = z.strictObject({
  /** Whether a move could start now. `refusals` says why not, in sentences. */
  ok: z.boolean(),
  refusals: z.array(z.string()),
  moves: z.array(MoveRowSchema),
  stays: z.array(MoveRowSchema),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** The largest files, when the bundle is over the cap or a file is over the file cap. */
  largest: z.array(z.strictObject({ path: z.string(), size: z.number().int().nonnegative() })),
  /** The top-level names git ignores in the working tree: what stays, so the person sees it. */
  ignored: z.array(z.string()),
  /** New files whose NAME says secret: they stay too. */
  withheld: z.array(z.string()),
  branch: z.string().optional(),
  head: z.string().optional(),
});
export type PreflightResponse = z.infer<typeof PreflightResponseSchema>;

export const ExportRequestSchema = z.strictObject({ offer: RelocateOfferSchema });
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const ExportResponseSchema = z.strictObject({
  exportId: z.string().regex(/^fy_relocate_export_[A-Za-z0-9_-]{16,64}$/u),
  header: BundleHeaderSchema,
});
export type ExportResponse = z.infer<typeof ExportResponseSchema>;

export const CompleteRequestSchema = z.strictObject({
  to: z.strictObject({ daemonId: DaemonIdSchema, ferretId: z.string().min(1).max(128) }),
});
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;

/** `state/relocate/moved.json`: the ferrets this machine has handed to another, so each is a read-only stub that says where it went. */
export const MovedDocumentSchema = z.strictObject({
  moved: z.record(
    z.string(),
    z.strictObject({ daemonId: DaemonIdSchema, ferretId: z.string().min(1), at: InstantSchema }),
  ),
});
export type MovedDocument = z.infer<typeof MovedDocumentSchema>;

export const MOVED_STATE = defineState({
  name: 'moved',
  path: 'moved.json',
  store: 'json',
  format: 1,
  schema: MovedDocumentSchema,
  mode: 0o600,
});

export const CompleteResponseSchema = z.strictObject({
  ferretId: z.string(),
  movedTo: z.strictObject({ daemonId: DaemonIdSchema, ferretId: z.string(), at: InstantSchema }),
});
export type CompleteResponse = z.infer<typeof CompleteResponseSchema>;
