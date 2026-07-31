import type { SttInstallStatus, SttModelKind, SttModelStatus, SttWorkerModel } from '@ferretry/protocol';
import { join } from 'node:path';
import { SttError } from './errors.ts';
import { sttModelDirectory, type SttPaths } from './paths.ts';

export const DAEMON_STT_MODEL_ID = 'parakeet-tdt-0.6b-v2-int8';
export const BROWSER_STT_MODEL_ID = 'parakeet-browser-v3';
export const STT_MODEL_MANIFEST = '.stt-model.json';
export const STT_MODEL_MANIFEST_SCHEMA = 1;

export interface SttModelFileDefinition {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Absent for archive members, which arrive inside the archive instead. */
  readonly url?: string;
  readonly mime: string;
  /** Whether the daemon may serve this file to a browser client. */
  readonly public: boolean;
}

export interface SttModelArchive {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rootDirectory: string;
}

export interface SttModelDefinition {
  readonly id: string;
  readonly kind: SttModelKind;
  readonly label: string;
  readonly languages: readonly string[];
  readonly costs: SttModelStatus['costs'];
  readonly files: readonly SttModelFileDefinition[];
  readonly archive?: SttModelArchive;
}

const DAEMON_FILES = [
  {
    name: 'encoder.int8.onnx',
    bytes: 652_184_296,
    sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab',
    mime: 'application/octet-stream',
    public: false,
  },
  {
    name: 'decoder.int8.onnx',
    bytes: 7_257_753,
    sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e',
    mime: 'application/octet-stream',
    public: false,
  },
  {
    name: 'joiner.int8.onnx',
    bytes: 1_739_080,
    sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2',
    mime: 'application/octet-stream',
    public: false,
  },
  {
    name: 'tokens.txt',
    bytes: 9_384,
    sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d',
    mime: 'text/plain; charset=utf-8',
    public: false,
  },
] as const satisfies readonly SttModelFileDefinition[];

const BROWSER_REVISION = 'f88260fa0777fe0868dda6df85d1a98f012a4a7a';
const BROWSER_BASE = `https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx/resolve/${BROWSER_REVISION}`;

const BROWSER_FILES = [
  {
    name: 'encoder-model.int8.onnx',
    bytes: 652_183_999,
    sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09',
    url: `${BROWSER_BASE}/encoder-model.int8.onnx`,
    mime: 'application/octet-stream',
    public: true,
  },
  {
    name: 'decoder_joint-model.int8.onnx',
    bytes: 18_202_004,
    sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70',
    url: `${BROWSER_BASE}/decoder_joint-model.int8.onnx`,
    mime: 'application/octet-stream',
    public: true,
  },
  {
    name: 'vocab.txt',
    bytes: 102_132,
    sha256: 'ba8e4007c65f4bb4358ffe2ecc13d9ccc7a10351151065242b5c3a943e685742',
    url: `${BROWSER_BASE}/vocab.txt`,
    mime: 'text/plain; charset=utf-8',
    public: true,
  },
] as const satisfies readonly SttModelFileDefinition[];

/**
 * Pinned, measured production manifests. Nothing here starts a download: the
 * installer is the only code that touches the network, and only when asked.
 */
export const DEFAULT_STT_MODELS = [
  {
    id: DAEMON_STT_MODEL_ID,
    kind: 'daemon',
    label: 'Parakeet TDT 0.6B v2 int8 (English, daemon batch)',
    languages: ['en'],
    costs: {
      downloadBytes: 482_468_385,
      diskBytes: 661_428_477,
      ramBytesApprox: 1_073_741_824,
      summary: '460 MB download, 631 MB extracted, about 1 GB RAM while the batch worker is loaded.',
    },
    archive: {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
      bytes: 482_468_385,
      sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
      rootDirectory: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    },
    files: DAEMON_FILES,
  },
  {
    id: BROWSER_STT_MODEL_ID,
    kind: 'browser',
    label: 'Parakeet TDT 0.6B v3 int8 (browser batch)',
    languages: ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ja', 'ko', 'zh'],
    costs: {
      downloadBytes: 670_488_135,
      diskBytes: 670_488_135,
      ramBytesApprox: 1_073_741_824,
      summary: '640 MB download per browser model; about 1 GB+ RAM, with WebGPU expansion near 2.4 GB.',
    },
    files: BROWSER_FILES,
  },
] as const satisfies readonly SttModelDefinition[];

/** The catalog is immutable and total: every lookup either answers or throws. */
export class SttModelCatalog {
  private readonly byId: ReadonlyMap<string, SttModelDefinition>;

  constructor(readonly definitions: readonly SttModelDefinition[] = DEFAULT_STT_MODELS) {
    this.byId = new Map(definitions.map(definition => [definition.id, definition]));
    if (this.byId.size !== definitions.length) throw new Error('STT model ids must be unique');
    for (const kind of ['daemon', 'browser'] as const) {
      if (definitions.filter(definition => definition.kind === kind).length !== 1) {
        throw new Error(`exactly one ${kind} STT model is required`);
      }
    }
  }

  definition(modelId: string): SttModelDefinition {
    const definition = this.byId.get(modelId);
    if (definition === undefined) throw new SttError('model_not_found', `unknown STT model: ${modelId}`);
    return definition;
  }

  find(modelId: string): SttModelDefinition | undefined {
    return this.byId.get(modelId);
  }

  definitionFor(kind: SttModelKind): SttModelDefinition {
    const definition = this.definitions.find(candidate => candidate.kind === kind);
    if (definition === undefined) throw new SttError('model_not_found', `no ${kind} STT model is defined`);
    return definition;
  }
}

/** The manifest written into a model directory once every file is verified. */
export interface InstalledModelManifest {
  readonly schema: typeof STT_MODEL_MANIFEST_SCHEMA;
  readonly modelId: string;
  readonly kind: SttModelKind;
  readonly installedAt: string;
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[];
}

export function buildInstalledManifest(definition: SttModelDefinition, installedAt: string): InstalledModelManifest {
  return {
    schema: STT_MODEL_MANIFEST_SCHEMA,
    modelId: definition.id,
    kind: definition.kind,
    installedAt,
    files: definition.files.map(file => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Files are matched by name rather than by position. The source compared index
 * by index, so a manifest that listed the same files in a different order was
 * read as a mismatch and triggered a needless multi-hundred-megabyte reinstall.
 */
function manifestMatchesDefinition(
  files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[],
  definition: SttModelDefinition,
): boolean {
  if (files.length !== definition.files.length) return false;
  const byName = new Map(files.map(file => [file.name, file]));
  return definition.files.every(file => {
    const installed = byName.get(file.name);
    return installed !== undefined && installed.bytes === file.bytes && installed.sha256 === file.sha256;
  });
}

/** Parse a manifest read from disk. Anything unrecognized means "not installed". */
export function parseInstalledManifest(
  text: string,
  definition: SttModelDefinition,
): InstalledModelManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.schema !== STT_MODEL_MANIFEST_SCHEMA) return undefined;
  if (parsed.modelId !== definition.id || parsed.kind !== definition.kind) return undefined;
  const installedAt = parsed.installedAt;
  if (typeof installedAt !== 'string' || !Number.isFinite(Date.parse(installedAt))) return undefined;
  if (!Array.isArray(parsed.files)) return undefined;
  const files: { name: string; bytes: number; sha256: string }[] = [];
  for (const entry of parsed.files) {
    if (!isRecord(entry)) return undefined;
    const { name, bytes, sha256 } = entry;
    if (typeof name !== 'string' || typeof bytes !== 'number' || typeof sha256 !== 'string') return undefined;
    files.push({ name, bytes, sha256 });
  }
  if (!manifestMatchesDefinition(files, definition)) return undefined;
  return { schema: STT_MODEL_MANIFEST_SCHEMA, modelId: definition.id, kind: definition.kind, installedAt, files };
}

export function idleInstall(definition: SttModelDefinition): IdleSttInstall {
  return { modelId: definition.id, phase: 'idle', receivedBytes: 0, totalBytes: definition.costs.downloadBytes };
}

export type IdleSttInstall = Extract<SttInstallStatus, { phase: 'idle' }>;

export type InstallProgress =
  | { readonly phase: 'downloading' | 'extracting' | 'verifying'; readonly receivedBytes: number }
  | { readonly phase: 'ready' }
  | { readonly phase: 'failed'; readonly message: string; readonly code: SttError['code'] };

/**
 * Advance an install status. Each phase produces exactly the fields the wire
 * union allows for it, so an impossible status (a `failed` phase still carrying
 * progress-only fields, say) cannot be constructed by accident.
 */
export function advanceInstall(
  definition: SttModelDefinition,
  previous: SttInstallStatus,
  progress: InstallProgress,
  at: string,
): SttInstallStatus {
  const totalBytes = definition.costs.downloadBytes;
  const startedAt = previous.phase === 'idle' ? at : (previous.startedAt ?? at);
  if (progress.phase === 'failed') {
    return {
      modelId: definition.id,
      phase: 'failed',
      receivedBytes: previous.receivedBytes,
      totalBytes,
      startedAt,
      finishedAt: at,
      message: progress.message,
      code: progress.code,
    };
  }
  if (progress.phase === 'ready') {
    return {
      modelId: definition.id,
      phase: 'ready',
      receivedBytes: totalBytes,
      totalBytes,
      startedAt,
      finishedAt: at,
    };
  }
  return {
    modelId: definition.id,
    phase: progress.phase,
    receivedBytes: Math.min(progress.receivedBytes, totalBytes),
    totalBytes,
    startedAt: previous.phase === 'downloading' ? previous.startedAt : startedAt,
  };
}

export interface InstalledSttModel {
  readonly definition: SttModelDefinition;
  readonly directory: string;
  readonly installedAt: string;
}

/**
 * Project the model's state for the wire. The state is derived from the facts —
 * an installed model is ready, an in-flight install is installing, a recorded
 * failure is an error — so `available` in the parent status can never disagree
 * with the install phase.
 */
export function projectModelStatus(
  definition: SttModelDefinition,
  install: SttInstallStatus,
  installed: InstalledSttModel | undefined,
  installing: boolean,
): SttModelStatus {
  const shared = {
    id: definition.id,
    kind: definition.kind,
    label: definition.label,
    languages: [...definition.languages],
    costs: { ...definition.costs },
  };
  if (installed !== undefined) {
    return {
      ...shared,
      state: 'ready',
      installedAt: installed.installedAt,
      files: definition.files.map(file => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
      install: {
        modelId: definition.id,
        phase: 'ready',
        receivedBytes: definition.costs.downloadBytes,
        totalBytes: definition.costs.downloadBytes,
        ...(install.phase === 'ready' && install.startedAt !== undefined ? { startedAt: install.startedAt } : {}),
        finishedAt: installed.installedAt,
      },
    };
  }
  if (
    installing &&
    (install.phase === 'downloading' || install.phase === 'extracting' || install.phase === 'verifying')
  ) {
    return { ...shared, state: 'installing', install };
  }
  if (install.phase === 'failed') return { ...shared, state: 'error', install };
  return { ...shared, state: 'not-installed', install: install.phase === 'idle' ? install : idleInstall(definition) };
}

/** One download the installer must perform, already bound to its target path. */
export interface InstallDownload {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Path relative to the staging directory. */
  readonly target: string;
  /** Bytes already accounted for by earlier downloads in the same install. */
  readonly receivedBefore: number;
}

export interface InstallPlan {
  readonly kind: 'archive' | 'files';
  readonly downloads: readonly InstallDownload[];
  /** Directory inside the archive that becomes the model directory. */
  readonly archiveRoot?: string;
}

export function planInstall(definition: SttModelDefinition): InstallPlan {
  if (definition.archive !== undefined) {
    return {
      kind: 'archive',
      archiveRoot: definition.archive.rootDirectory,
      downloads: [
        {
          url: definition.archive.url,
          bytes: definition.archive.bytes,
          sha256: definition.archive.sha256,
          target: 'model.tar.bz2',
          receivedBefore: 0,
        },
      ],
    };
  }
  const downloads: InstallDownload[] = [];
  let receivedBefore = 0;
  for (const file of definition.files) {
    if (file.url === undefined) {
      throw new SttError('install_failed', `no source URL for ${file.name}`);
    }
    downloads.push({ url: file.url, bytes: file.bytes, sha256: file.sha256, target: file.name, receivedBefore });
    receivedBefore += file.bytes;
  }
  return { kind: 'files', downloads };
}

/** The four artifacts the batch recognizer needs, resolved inside a directory. */
export function workerModelFor(definition: SttModelDefinition, directory: string): SttWorkerModel {
  return {
    id: definition.id,
    directory,
    encoder: join(directory, 'encoder.int8.onnx'),
    decoder: join(directory, 'decoder.int8.onnx'),
    joiner: join(directory, 'joiner.int8.onnx'),
    tokens: join(directory, 'tokens.txt'),
  };
}

/** Only files a browser model marks public may ever be served to a client. */
export function publicModelFile(definition: SttModelDefinition, fileName: string): SttModelFileDefinition | undefined {
  if (definition.kind !== 'browser') return undefined;
  return definition.files.find(candidate => candidate.public && candidate.name === fileName);
}

export function modelDirectoryFor(paths: SttPaths, definition: SttModelDefinition): string {
  return sttModelDirectory(paths, definition.id);
}

/** A declared size that contradicts the pinned manifest ends the download. */
export function declaredSizeMatches(declared: string | null, bytes: number): boolean {
  if (declared === null) return true;
  return /^\d+$/u.test(declared.trim()) && Number(declared.trim()) === bytes;
}
