/**
 * THE SPEECH ENGINE ON THIS MACHINE: WHAT CAN BE INSTALLED, WHAT IS, AND WHAT INSTALLING IS DOING.
 *
 * `docs/design/voice-modes.md` §2.2–§2.3 and `docs/voice.md` › "On my machine: models and Install". The
 * daemon owns the catalog's DATA (`packages/daemon/src/lib/voice-install/catalog.ts` — the URLs, sizes and
 * hashes are facts about someone else's release assets, so one module owns them); this file owns its SHAPE,
 * so the app can render a row it has never seen and the CLI and the daemon cannot disagree about a field.
 *
 * Nothing here performs IO. Every figure on the wire is a byte count or a count of bytes done, never a
 * rendered size: the reader decides how to say "487 MB".
 */

import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

/** `batch`: transcribes a finished take (voice chat, dictation after Stop). `streaming`: words as they are said. */
export const VOICE_MODEL_ROLES = ['batch', 'streaming'] as const;
export const VoiceModelRoleSchema = z.enum(VOICE_MODEL_ROLES);
export type VoiceModelRole = z.infer<typeof VoiceModelRoleSchema>;

/** The machines the native runtime is published for (`sherpa-onnx-<target>` on npm). */
export const VOICE_RUNTIME_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64'] as const;
export const VoiceRuntimeTargetSchema = z.enum(VOICE_RUNTIME_TARGETS);
export type VoiceRuntimeTarget = z.infer<typeof VoiceRuntimeTargetSchema>;

/**
 * How the recognizer slice builds a sherpa-onnx config from a row. A row is a catalog entry, not new native
 * code, so a model is added by naming which of these it is and which archive file plays which part.
 */
export const VOICE_SHERPA_MODEL_TYPES = [
  /** Offline transducer: `encoder`, `decoder`, `joiner`, `tokens` (Parakeet TDT). */
  'nemo-transducer',
  /** Offline Canary: `encoder`, `decoder`, `tokens`. */
  'nemo-canary',
  /** Offline Whisper: `encoder`, `decoder`, `tokens`. */
  'whisper',
  /** Offline Qwen3-ASR. */
  'qwen3-asr',
  /** Offline Cohere Transcribe. */
  'cohere-transcribe',
  /** Online (streaming) transducer: `encoder`, `decoder`, `joiner`, `tokens` (Nemotron, Parakeet unified). */
  'online-transducer',
] as const;
export const VoiceSherpaModelTypeSchema = z.enum(VOICE_SHERPA_MODEL_TYPES);
export type VoiceSherpaModelType = z.infer<typeof VoiceSherpaModelTypeSchema>;

/** `estimate`: a conservative figure the bench (§2.2.1) replaces. `measured`: a peak seen on a real machine. */
export const VOICE_MEMORY_BASES = ['estimate', 'measured'] as const;
export const VoiceMemoryBasisSchema = z.enum(VOICE_MEMORY_BASES);
export type VoiceMemoryBasis = z.infer<typeof VoiceMemoryBasisSchema>;

export const VOICE_ARCHIVE_FORMATS = ['tar.bz2', 'tgz'] as const;
export const VoiceArchiveFormatSchema = z.enum(VOICE_ARCHIVE_FORMATS);
export type VoiceArchiveFormat = z.infer<typeof VoiceArchiveFormatSchema>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'a lower-case hex SHA-256');

/** One pinned download: where it is, how big, and the digest it must have. */
export const VoiceArchiveSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  format: VoiceArchiveFormatSchema,
  /** The archive's exact byte count — the download is refused if the server sends another. */
  bytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
  /**
   * The bytes the archive unpacks to — also the extraction's size cap, so an archive that grows past it is
   * refused rather than filling the disk.
   */
  extractedBytes: PositiveIntegerSchema,
});
export type VoiceArchive = z.infer<typeof VoiceArchiveSchema>;

/** One row of the model chooser. */
export const VoiceModelSchema = z.strictObject({
  /** The id `fy voice install <id>` and `voice.yaml` name; also the directory under `voice/models/`. */
  id: NonEmptyStringSchema.regex(/^[a-z0-9][a-z0-9.-]*$/, 'lower-case letters, digits, "." and "-"'),
  name: NonEmptyStringSchema,
  role: VoiceModelRoleSchema,
  /** The chooser's one-line reason to pick it. */
  summary: NonEmptyStringSchema,
  /** `light` suits a small machine; `heavy` and `heaviest` want a strong CPU and memory to spare. */
  weight: z.enum(['light', 'standard', 'heavy', 'heaviest']),
  sherpaType: VoiceSherpaModelTypeSchema,
  /** Which file inside the archive plays which part (`encoder`, `decoder`, `joiner`, `tokens`, …), relative to the model directory. */
  files: z.record(NonEmptyStringSchema, NonEmptyStringSchema),
  /** The languages the model card names, for the row to show. */
  languages: z.array(NonEmptyStringSchema).min(1),
  archive: VoiceArchiveSchema,
  /** The memory a loaded model needs. `estimate` until the bench measures it on a real machine. */
  peakMemory: z.strictObject({ bytes: PositiveIntegerSchema, basis: VoiceMemoryBasisSchema }),
  recommended: z.boolean(),
});
export type VoiceModel = z.infer<typeof VoiceModelSchema>;

/** How a native runtime finds its sibling shared libraries, as read from the prebuilds (never by loading them). */
export const VOICE_LIBRARY_LOOKUPS = ['origin', 'loader-path', 'library-path-env'] as const;
export const VoiceLibraryLookupSchema = z.enum(VOICE_LIBRARY_LOOKUPS);
export type VoiceLibraryLookup = z.infer<typeof VoiceLibraryLookupSchema>;

/** The native runtime for one target: a published npm tarball, pinned by the SHA-256 of the tarball. */
export const VoiceRuntimeSchema = z.strictObject({
  target: VoiceRuntimeTargetSchema,
  /** The npm package (`sherpa-onnx-<target>`). */
  packageName: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  archive: VoiceArchiveSchema,
  /** The `.node` addon, relative to the runtime directory. */
  addon: NonEmptyStringSchema,
  /** The shared libraries the addon links, relative to the runtime directory. */
  libraries: z.array(NonEmptyStringSchema).min(1),
  /** How the addon and its libraries find each other: in-tree, so no library path variable is needed. */
  libraryLookup: VoiceLibraryLookupSchema,
});
export type VoiceRuntime = z.infer<typeof VoiceRuntimeSchema>;

/** What one piece (the runtime, or a model) looks like on this machine's disk. */
export const VoiceInstallStateSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not-installed'),
    /** Bytes of a cancelled or interrupted download that Install will resume from. */
    partialBytes: NonNegativeIntegerSchema,
  }),
  z.strictObject({
    state: z.literal('installed'),
    /** Absent for a runtime the owner supplied (`engine.runtimePath`): Install did not put it there. */
    installedAt: InstantSchema.optional(),
    bytes: NonNegativeIntegerSchema,
  }),
]);
export type VoiceInstallState = z.infer<typeof VoiceInstallStateSchema>;

export const VOICE_INSTALL_PHASES = ['starting', 'downloading', 'verifying', 'unpacking', 'finishing'] as const;
export const VoiceInstallPhaseSchema = z.enum(VOICE_INSTALL_PHASES);
export type VoiceInstallPhase = z.infer<typeof VoiceInstallPhaseSchema>;

export const VOICE_INSTALL_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export const VoiceInstallStatusSchema = z.enum(VOICE_INSTALL_STATUSES);
export type VoiceInstallStatus = z.infer<typeof VoiceInstallStatusSchema>;

/**
 * The install under way, or the last one that finished (held in memory until the next starts — a poll that
 * arrives a second after it ended still sees how it ended).
 */
export const VoiceInstallProgressSchema = z.strictObject({
  /** The model being installed; the runtime it needs is installed first, under the same id. */
  modelId: NonEmptyStringSchema,
  status: VoiceInstallStatusSchema,
  /** What is being fetched right now. */
  component: z.enum(['runtime', 'model']),
  phase: VoiceInstallPhaseSchema,
  bytesDone: NonNegativeIntegerSchema,
  bytesTotal: NonNegativeIntegerSchema,
  /** A sentence for a person: why it failed or was cancelled. Absent while running or after success. */
  message: z.string().optional(),
  /** The stable code of a failure (`VOICE_ENGINE_CODES`), when `status` is `failed`. */
  code: z.string().optional(),
  startedAt: InstantSchema,
  finishedAt: InstantSchema.optional(),
});
export type VoiceInstallProgress = z.infer<typeof VoiceInstallProgressSchema>;

/** A catalog row with what this machine holds of it. */
export const VoiceModelEntrySchema = VoiceModelSchema.extend({
  install: VoiceInstallStateSchema,
  /** Whether it is the active model for its role. */
  active: z.boolean(),
});
export type VoiceModelEntry = z.infer<typeof VoiceModelEntrySchema>;

/** `GET /v1/voice/engine`: the catalog, each row's install state, the runtime, and the install in flight. */
export const VoiceEngineViewSchema = z.strictObject({
  /** This machine's target, or `null` where no prebuilt runtime is published. */
  target: VoiceRuntimeTargetSchema.nullable(),
  /** A sentence saying why there is no runtime for this machine, when `target` is `null`. */
  unsupported: z.string().optional(),
  runtime: z.strictObject({
    /** `downloaded`: fetched on Install into the state home. `override`: `voice.yaml` › `engine.runtimePath`. */
    source: z.enum(['downloaded', 'override']),
    /** The pinned version for this target; absent where there is no target. */
    version: NonEmptyStringSchema.optional(),
    /** The `sherpa-onnx-node` JavaScript wrapper version the recognizer is built against. */
    wrapperVersion: NonEmptyStringSchema,
    install: VoiceInstallStateSchema,
    /** Where it lives: the override path, or the directory under the state home. */
    path: z.string().optional(),
  }),
  models: z.array(VoiceModelEntrySchema),
  /** The model each role uses: the one `voice.yaml` names, else the recommended one if installed, else `null`. */
  active: z.strictObject({
    batch: z.string().nullable(),
    streaming: z.string().nullable(),
  }),
  /** Free bytes where the state home lives, so a chooser can say "needs 975 MB free" truthfully. */
  freeBytes: NonNegativeIntegerSchema.optional(),
  install: VoiceInstallProgressSchema.nullable(),
  /** Things a person should know: a model `voice.yaml` names that is not in the catalog or not installed. */
  warnings: z.array(z.string()),
});
export type VoiceEngineView = z.infer<typeof VoiceEngineViewSchema>;

/** `POST /v1/voice/engine/install`, `…/remove` and `…/use`: which model. */
export const VoiceModelRequestSchema = z.strictObject({ id: NonEmptyStringSchema });
export type VoiceModelRequest = z.infer<typeof VoiceModelRequestSchema>;

/** The error codes the engine routes answer with, so the app and `fy` say the right sentence. */
export const VOICE_ENGINE_CODES = {
  /** Another install is running: one at a time. */
  busy: 'voice_install_busy',
  unknownModel: 'voice_unknown_model',
  /** Free disk is under twice the archive. */
  noDisk: 'voice_no_disk',
  /** No prebuilt runtime is published for this machine. */
  unsupportedPlatform: 'voice_unsupported_platform',
  /** The download did not match its pinned size or SHA-256 and was deleted. */
  hashMismatch: 'voice_hash_mismatch',
  /** An archive entry tried to leave its directory, was a link or a device, or the archive outgrew its cap. */
  unsafeArchive: 'voice_unsafe_archive',
  /** The network failed or the server refused. */
  download: 'voice_download_failed',
  /** The tool that unpacks `.tar.bz2` is missing from this machine. */
  noDecompressor: 'voice_no_decompressor',
  notInstalled: 'voice_model_not_installed',
  /** Remove was asked for a model the engine is using right now, or while an install runs. */
  inUse: 'voice_model_in_use',
  /** The install was cancelled by a person. */
  cancelled: 'voice_install_cancelled',
  /** The install failed for a reason that is not one of the above (disk write, rename). */
  failed: 'voice_install_failed',
} as const;
export type VoiceEngineCode = (typeof VOICE_ENGINE_CODES)[keyof typeof VOICE_ENGINE_CODES];
