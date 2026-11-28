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
/** How long an offer the target opened stays good: five minutes, spent on its first import (the source checks the same bound). */
export const RELOCATE_OFFER_TTL_MS = 5 * 60 * 1000;
/** A target keeps at most this many open offers: each can buffer a whole bundle. */
export const RELOCATE_MAX_OPEN_OFFERS = 1;
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

/** A secret's NAME as the Vault spells it. Names only ever cross a move, never a value. */
export const SecretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);

/**
 * What the target must have for a ferret to run there, in names and facts only: the harness it runs on (and the runtime name
 * it had), the project's remote (credentials stripped) and the `${secret:NAME}` names its launch refers to.
 */
export const NeedsSchema = z.strictObject({
  harness: z.string().min(1).max(128),
  runtime: z.string().min(1).max(256).optional(),
  /** `https://<host>/<path>`, never the remote as written: it may carry a token. Absent: the folder has no remote. */
  remote: z.string().min(1).max(2048).optional(),
  secrets: z.array(SecretNameSchema).max(256),
});
export type Needs = z.infer<typeof NeedsSchema>;

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
  identityKey: Base64UrlSchema,
  signature: Base64UrlSchema,
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
  needs: NeedsSchema,
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
  /** What the other machine must have to run this ferret: the same facts the target's preflight is asked with. */
  needs: NeedsSchema,
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
  to: z.strictObject({
    daemonId: DaemonIdSchema,
    ferretId: z.string().min(1).max(128),
    machine: z.string().min(1).max(256).optional(),
  }),
});
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;

/** Explicitly discard a source's abandoned export, leaving that source stopped or fenced. */
export const ReleaseRequestSchema = z.strictObject({ ferretId: z.string().min(1).max(128) });

/** `state/relocate/moved.json`: the ferrets this machine has handed to another, so each is a read-only stub that says where it went. */
export const MovedDocumentSchema = z.strictObject({
  moved: z.record(
    z.string(),
    z.strictObject({
      daemonId: DaemonIdSchema,
      ferretId: z.string().min(1),
      at: InstantSchema,
      machine: z.string().min(1).max(256).optional(),
      exportId: z.string().optional(),
    }),
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

// ─── the TARGET end: open an offer, check, receive the chunks, import ────────────────────────────────────────────────────

/** An absolute folder the person named; never relative, so it cannot resolve against the daemon's own directory. */
const AbsoluteFolderSchema = z
  .string()
  .min(2)
  .max(4096)
  .refine(path => path.startsWith('/') && !/[\p{Cc}]/u.test(path) && !path.split('/').includes('..'), {
    message: 'a folder is an absolute path with no .. in it',
  });

/** `POST /v1/relocate/offers/:offerId/preflight`: what the source's preflight said the ferret needs, and where a clone may go. */
export const TargetPreflightRequestSchema = z.strictObject({
  needs: NeedsSchema,
  /** The folder a clone of the project would be made in, when no registered project has the remote. */
  cloneInto: AbsoluteFolderSchema.optional(),
});
export type TargetPreflightRequest = z.infer<typeof TargetPreflightRequestSchema>;

export const ProjectResolutionSchema = z.enum(['found', 'clone', 'none']);

export const TargetPreflightResponseSchema = z.strictObject({
  ok: z.boolean(),
  refusals: z.array(z.string()),
  /** `found`: a registered project has this remote. `clone`: none has, and this machine may clone it. `none`: refused. */
  project: ProjectResolutionSchema,
  /** The runtime a start here would use, when one could be resolved for the harness. */
  runtime: z.string().optional(),
  /** Secret NAMES this machine does not hold. A move refuses until each exists (copying them is the secrets copy). */
  missingSecrets: z.array(SecretNameSchema),
});
export type TargetPreflightResponse = z.infer<typeof TargetPreflightResponseSchema>;

/** `PUT /v1/relocate/offers/:offerId/chunks/:index`: one sealed chunk as base64url (a request body here is text). */
export const ChunkUploadSchema = z.strictObject({ chunk: Base64UrlSchema });
export type ChunkUpload = z.infer<typeof ChunkUploadSchema>;
/** The most base64url characters one chunk upload carries: a chunk plus its nonce and tag, encoded. */
export const RELOCATE_MAX_CHUNK_TEXT = Math.ceil(((RELOCATE_CHUNK_BYTES + 64) * 4) / 3) + 64;

export const ChunkReceivedSchema = z.strictObject({ index: z.number().int().nonnegative() });

/** `POST /v1/relocate/offers/:offerId/import`: the header the source sealed with, and where a clone may go. */
export const ImportRequestSchema = z.strictObject({
  header: BundleHeaderSchema,
  /** The SOURCE chosen through the owner's paired-machine list, independently of the uploaded header. */
  sourceDaemonId: DaemonIdSchema,
  cloneInto: AbsoluteFolderSchema.optional(),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const ImportResponseSchema = z.strictObject({
  ferretId: z.string(),
  folder: z.string(),
  movedFrom: z.strictObject({ daemonId: DaemonIdSchema, ferretId: z.string().min(1) }),
  /** A launch succeeded but its origin could not be saved, or its turns and attachments were not all restored. The ferret and its files are kept. */
  recovery: z
    .strictObject({
      code: z.enum([
        'provenance_unrecorded',
        'session_unrestored',
        'source_unconfirmed',
        'start_unconfirmed',
        'move_released',
      ]),
      state: z.enum(['running', 'stopped', 'unknown']),
      message: z.string(),
    })
    .optional(),
});
export type ImportResponse = z.infer<typeof ImportResponseSchema>;

/** `state/relocate/received.json`: the ferrets this machine took from another, so each says where it came from. */
export const ReceivedDocumentSchema = z.strictObject({
  received: z.record(
    z.string(),
    z.strictObject({ daemonId: DaemonIdSchema, ferretId: z.string().min(1), at: InstantSchema }),
  ),
});
export type ReceivedDocument = z.infer<typeof ReceivedDocumentSchema>;

export const RECEIVED_STATE = defineState({
  name: 'received',
  path: 'received.json',
  store: 'json',
  format: 1,
  schema: ReceivedDocumentSchema,
  mode: 0o600,
});
