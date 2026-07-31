import { join } from 'node:path';
import type { FoundationPaths } from '../paths.ts';
import { SttError } from './errors.ts';

/** Paths owned exclusively by the speech-to-text subsystem. */
export interface SttPaths {
  /** Shared model weights; only ever populated by an explicit install. */
  readonly models: string;
  /** Small subsystem state and diagnostics directory. */
  readonly directory: string;
  /** Cached native runtime discovery state. */
  readonly state: string;
  /** Worker stderr transcript, kept for post-mortem diagnostics. */
  readonly workerLog: string;
}

const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/u;

export function createSttPaths(paths: FoundationPaths): SttPaths {
  const directory = join(paths.state, 'stt');
  return {
    models: join(paths.home, 'models'),
    directory,
    state: join(directory, 'state.json'),
    workerLog: join(directory, 'worker.log'),
  };
}

/**
 * A model id becomes a directory name, so it is validated rather than trusted:
 * an id of `../../..` would otherwise escape the models directory entirely.
 */
export function sttModelDirectory(paths: SttPaths, modelId: string): string {
  if (!SAFE_MODEL_ID.test(modelId)) throw new SttError('model_not_found', `model id is not path safe: ${modelId}`);
  return join(paths.models, modelId);
}

export function requiredSttDirectories(paths: SttPaths): readonly string[] {
  return [paths.models, paths.directory];
}
