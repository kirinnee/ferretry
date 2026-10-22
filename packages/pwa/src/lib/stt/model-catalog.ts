/**
 * THE ON-DEVICE SPEECH MODEL CATALOG — every model this app can install and run in the browser, named
 * here once, with everything a person needs to choose between them before a byte is downloaded.
 *
 * Each entry pins its files the way Parakeet always has (`parakeet-model.ts`): an immutable
 * `https://huggingface.co/<repo>/resolve/<40-hex commit>/<file>` URL, the exact byte count, and the
 * SHA-256 the bytes must hash to. {@link validateModelCatalog} holds every entry to that, and the unit
 * suite runs it over the shipped catalog, so an entry that points at `main`, guesses a size or drops a
 * digest fails before it can ship.
 *
 * A model runs on a RUNTIME (`SpeechRuntimeId`): the WebAssembly program that turns its files into
 * text. A runtime's binary is the app's own build output — self-hosted, never from a CDN — and is
 * downloaded, pinned and verified exactly like a model file, on the same Install press.
 *
 * Nothing in this file downloads anything. It is data: the store (`model-store.ts`) does the work, and
 * only when the person presses Install.
 */

import { formatMegabytes, type PinnedBundle, type PinnedFile } from './model-store.ts';
import {
  ORT_RUNTIME_FILE,
  ORT_RUNTIME_VERSION,
  PARAKEET_CACHE,
  PARAKEET_MODEL_FILES,
  PARAKEET_MODEL_ORIGIN,
  PARAKEET_REPOSITORY,
  PARAKEET_REVISION,
  PARAKEET_VERSION_LABEL,
} from './parakeet-model.ts';
import { SHERPA_MODELS, SHERPA_RUNTIME, type SherpaCatalogModel } from './sherpa-models.ts';

/** Every on-device model id, in the order Settings lists them (sherpa first, as the owner asked). Each is also a dictation engine id. */
export const ON_DEVICE_MODEL_IDS = ['sherpa-zipformer-en', 'sherpa-zipformer-en-20m', 'parakeet'] as const;
export type OnDeviceModelId = (typeof ON_DEVICE_MODEL_IDS)[number];

/** The programs a model can run on. */
export type SpeechRuntimeId = 'onnxruntime-web' | 'sherpa-onnx';

export type SpeechModelFamily = 'parakeet' | 'zipformer' | 'moonshine' | 'whisper' | 'vosk';

/** A runtime's one binary: pinned like a model file, its URL known only once the build has run. */
export interface SpeechRuntime {
  readonly id: SpeechRuntimeId;
  readonly label: string;
  /** The npm package version the binary comes from, pinned exactly. */
  readonly version: string;
  readonly licence: string;
  readonly file: Omit<PinnedFile, 'url'>;
  /**
   * `null` when the binary lives inside its model's own bundle (Parakeet, which predates the catalog);
   * otherwise the bundle every model on this runtime shares, so it is downloaded once.
   */
  readonly shared: { readonly cache: string; readonly keyRoot: string } | null;
}

export const SPEECH_RUNTIMES: Readonly<Record<SpeechRuntimeId, SpeechRuntime>> = {
  'onnxruntime-web': {
    id: 'onnxruntime-web',
    label: `ONNX Runtime Web ${ORT_RUNTIME_VERSION}`,
    version: ORT_RUNTIME_VERSION,
    licence: 'MIT',
    file: ORT_RUNTIME_FILE,
    shared: null,
  },
  'sherpa-onnx': SHERPA_RUNTIME,
};

/**
 * What has been measured for a model, said with where it was measured. Settings shows these beside
 * the model so the person can compare without installing everything first.
 */
interface MeasuredNumbers {
  /** Where and on what: "Bun on x64, LibriSpeech clips". */
  readonly where: string;
  /** Word error rate, as published or measured, e.g. "6.1% (LibriSpeech test-clean)". */
  readonly accuracy?: string;
  /** How fast, e.g. "6.6 s of audio in 0.5 s". */
  readonly speed?: string;
}

export interface OnDeviceModelBase {
  readonly id: OnDeviceModelId;
  /** The full name: "Parakeet TDT 0.6B v3". */
  readonly label: string;
  /** Used in sentences: "Parakeet is still downloading". */
  readonly shortName: string;
  readonly family: SpeechModelFamily;
  /** SPDX-style licence of the model weights. */
  readonly licence: string;
  /** BCP 47 language tags the model understands. */
  readonly languages: readonly string[];
  readonly runtime: SpeechRuntimeId;
  /** True when it hears words as they are spoken (true streaming), not after Stop. */
  readonly streaming: boolean;
  /** True when it can show Parakeet-style near-live words (`near-live.ts`) by re-reading a window. */
  readonly nearLive: boolean;
  /** Where the files come from: the repository and the one commit they are pinned at. */
  readonly source: { readonly repository: string; readonly revision: string };
  /** The model's own files. The runtime's binary is {@link SpeechRuntime.file}. */
  readonly files: readonly PinnedFile[];
  /** The model's Cache Storage bundle. */
  readonly cache: string;
  readonly keyRoot: string;
  /** What Settings shows once installed. */
  readonly versionLabel: string;
  /** One or two sentences on speed, accuracy and memory, for the engine list. */
  readonly summary: string;
  readonly measured?: MeasuredNumbers;
}

/** Parakeet 0.6B v3 on ONNX Runtime + parakeet.js (`parakeet-voice.ts`). */
export interface ParakeetCatalogModel extends OnDeviceModelBase {
  readonly runtime: 'onnxruntime-web';
  readonly family: 'parakeet';
}

export type OnDeviceModel = ParakeetCatalogModel | SherpaCatalogModel;

export const PARAKEET_CATALOG_MODEL: ParakeetCatalogModel = {
  id: 'parakeet',
  label: 'Parakeet TDT 0.6B v3',
  shortName: 'Parakeet',
  family: 'parakeet',
  licence: 'CC-BY-4.0',
  languages: ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk'],
  runtime: 'onnxruntime-web',
  streaming: false,
  nearLive: true,
  source: { repository: PARAKEET_REPOSITORY, revision: PARAKEET_REVISION },
  files: PARAKEET_MODEL_FILES,
  cache: PARAKEET_CACHE,
  keyRoot: '/fy-stt/parakeet',
  versionLabel: PARAKEET_VERSION_LABEL,
  summary:
    'The most accurate model here, and the largest: about 1 GB of memory while it transcribes, so it suits a laptop better than a phone. Words appear after Stop, or near-live with Live words on.',
};

/** Every model, in {@link ON_DEVICE_MODEL_IDS} order. */
export const ON_DEVICE_MODELS: readonly OnDeviceModel[] = [...SHERPA_MODELS, PARAKEET_CATALOG_MODEL];

/** The catalog entry for an id, or `null` for anything else (including `browser`). */
export const onDeviceModel = (id: string | null | undefined): OnDeviceModel | null =>
  ON_DEVICE_MODELS.find(model => model.id === id) ?? null;

/** Every byte a model needs on a device that has nothing yet: its files and its runtime. */
export const modelDownloadBytes = (model: OnDeviceModel): number =>
  model.files.reduce((total, file) => total + file.bytes, 0) + SPEECH_RUNTIMES[model.runtime].file.bytes;

/** The download, said the way storage settings say it. */
export const modelDownloadSize = (model: OnDeviceModel): string => formatMegabytes(modelDownloadBytes(model));

/** The model's own files as a store bundle. */
export const modelBundle = (model: OnDeviceModel): PinnedBundle => ({
  name: model.shortName,
  cache: model.cache,
  keyRoot: model.keyRoot,
  versionLabel: model.versionLabel,
  files: model.files,
});

/** A shared runtime's binary as a store bundle, at the URL this build emitted it under. */
export const runtimeBundle = (runtime: SpeechRuntime, url: string): PinnedBundle | null =>
  runtime.shared === null
    ? null
    : {
        name: runtime.label,
        cache: runtime.shared.cache,
        keyRoot: runtime.shared.keyRoot,
        versionLabel: runtime.label,
        files: [{ ...runtime.file, url }],
      };

const MODEL_ID = /^[a-z0-9][a-z0-9-]{1,39}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CACHE = /^fy-stt-[a-z0-9-]+-v\d+$/u;

/**
 * Every rule a catalog entry must keep, as sentences naming the entry. Empty means the catalog is
 * sound. Pure: the unit suite runs it over {@link ON_DEVICE_MODELS} and over broken copies.
 */
export function validateModelCatalog(
  models: readonly OnDeviceModel[],
  runtimes: Readonly<Record<string, SpeechRuntime>> = SPEECH_RUNTIMES,
): string[] {
  const problems: string[] = [];
  const seen = { ids: new Set<string>(), caches: new Set<string>(), roots: new Set<string>() };
  const once = (set: Set<string>, value: string, what: string, id: string): void => {
    if (set.has(value)) problems.push(`${id}: ${what} ${value} is used twice.`);
    set.add(value);
  };
  for (const runtime of Object.values(runtimes)) {
    if (!SHA256.test(runtime.file.sha256)) problems.push(`${runtime.id}: the runtime's SHA-256 is not 64 hex digits.`);
    if (!Number.isSafeInteger(runtime.file.bytes) || runtime.file.bytes <= 0)
      problems.push(`${runtime.id}: the runtime's size is not a positive whole number of bytes.`);
    if (runtime.shared !== null) {
      if (!CACHE.test(runtime.shared.cache))
        problems.push(`${runtime.id}: cache ${runtime.shared.cache} is not fy-stt-<name>-v<n>.`);
      once(seen.caches, runtime.shared.cache, 'cache', runtime.id);
      once(seen.roots, runtime.shared.keyRoot, 'key root', runtime.id);
    }
  }
  for (const model of models) {
    const id: string = model.id;
    if (!MODEL_ID.test(id) || id === 'browser')
      problems.push(`${id}: the id is not a lowercase slug other than "browser".`);
    once(seen.ids, id, 'id', id);
    if (!CACHE.test(model.cache)) problems.push(`${id}: cache ${model.cache} is not fy-stt-<name>-v<n>.`);
    once(seen.caches, model.cache, 'cache', id);
    once(seen.roots, model.keyRoot, 'key root', id);
    if (runtimes[model.runtime] === undefined) problems.push(`${id}: runtime ${model.runtime} is not in the catalog.`);
    if (!COMMIT.test(model.source.revision)) problems.push(`${id}: the revision is not a 40-hex commit.`);
    if (model.languages.length === 0) problems.push(`${id}: it names no language.`);
    if (model.files.length === 0) problems.push(`${id}: it pins no files.`);
    const roles = new Set<string>();
    const pinnedBase = `https://huggingface.co/${model.source.repository}/resolve/${model.source.revision}/`;
    for (const file of model.files) {
      if (roles.has(file.role)) problems.push(`${id}: role ${file.role} is used twice.`);
      roles.add(file.role);
      if (!file.url.startsWith(pinnedBase) || file.url.length === pinnedBase.length)
        problems.push(`${id}: ${file.role} is not pinned at ${model.source.repository}@${model.source.revision}.`);
      if (!SHA256.test(file.sha256)) problems.push(`${id}: ${file.role}'s SHA-256 is not 64 hex digits.`);
      if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0)
        problems.push(`${id}: ${file.role}'s size is not a positive whole number of bytes.`);
    }
  }
  return problems;
}

/** Where a model's files come from, for the copy that names it. */
export const modelSourceUrl = (model: OnDeviceModel): string =>
  `${PARAKEET_MODEL_ORIGIN}/${model.source.repository}/tree/${model.source.revision}`;
