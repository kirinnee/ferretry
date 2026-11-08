/**
 * The words for the models a local server (Ollama) has installed on the machine — the pure half. The
 * daemon reads Ollama on demand (`POST /v1/models/local/refresh`) and answers with a state, a ready
 * sentence and the exact command that installs a model; this file only turns that answer into the
 * tile's second line and a size (the note under a picker is the app shell's `localNote`). Nothing here reads a
 * clock or a network.
 */

import type { LocalModels } from '../../contract/index.ts';

export type LocalModel = LocalModels['models'][number];
type LocalModelsState = LocalModels['state'];

/** The provider tile that runs Codex on Ollama (the `ollama-codex` runtime). */
export const OLLAMA_PRESET_ID = 'ollama-codex';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** A size the way Ollama prints it (decimal units): `13.8 GB`, `274 MB`, `2 GB`. */
export const sizeWords = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${SIZE_UNITS[unit]}`;
};

/** What one installed model is, beside its name: `20.9B · MXFP4 · 13.8 GB`. Empty when nothing is known. */
export const modelDetailWords = (model: LocalModel): string =>
  [model.parameterSize, model.quantization, model.sizeBytes === undefined ? undefined : sizeWords(model.sizeBytes)]
    .filter(part => part !== undefined)
    .join(' · ');

/** What one read of the local server has come to, in the shape the surfaces hold it. */
export interface LocalModelsRead {
  /** The last answer; `null` until the first read lands. */
  readonly snapshot: LocalModels | null;
  readonly checking: boolean;
  /** One sentence when the read itself failed (the daemon could not be asked). */
  readonly error: string | null;
}

export type LocalTone = 'ok' | 'warn' | 'muted';

/** The tile's second line and how it is toned; `null` while there is nothing to say yet. */
export interface LocalTileWords {
  readonly text: string;
  readonly tone: LocalTone;
}

const STATE_WORDS: Readonly<Record<Exclude<LocalModelsState, 'found'>, LocalTileWords>> = {
  'none-pulled': { text: 'No model pulled yet', tone: 'warn' },
  'not-running': { text: 'Not running', tone: 'warn' },
  unreadable: { text: 'Not answering as Ollama', tone: 'warn' },
  refused: { text: 'Address is not this machine', tone: 'warn' },
  disabled: { text: 'Detection is switched off', tone: 'muted' },
};

export const installedCount = (count: number): string => `${String(count)} model${count === 1 ? '' : 's'} installed`;

export const tileWords = (read: LocalModelsRead): LocalTileWords | null => {
  const { snapshot } = read;
  if (snapshot === null) {
    if (read.checking) return { text: 'Checking Ollama…', tone: 'muted' };
    return read.error === null ? null : { text: 'Could not check Ollama', tone: 'warn' };
  }
  return snapshot.state === 'found'
    ? { text: installedCount(snapshot.models.length), tone: 'ok' }
    : STATE_WORDS[snapshot.state];
};

/** Whole class names, so Tailwind's scan finds them. */
export const LOCAL_TONE_CLASS: Readonly<Record<LocalTone, string>> = {
  ok: 'text-ok',
  warn: 'text-warn',
  muted: 'text-muted',
};
