/**
 * `LocalModels` as the daemon answers `POST /v1/models/local/refresh`, parsed through the real schema so
 * a wire change fails here first. `localModelsFixture('found')` is a machine with two models pulled.
 */

import { type LocalModel, type LocalModels, LocalModelsSchema, type LocalModelsState } from '@ferretry/protocol';

export const PULL = 'ollama pull gpt-oss:20b';

export const GPT_OSS: LocalModel = {
  id: 'gpt-oss:20b',
  label: 'gpt-oss:20b',
  sizeBytes: 13_800_000_000,
  parameterSize: '20.9B',
  quantization: 'MXFP4',
  family: 'gptoss',
  modifiedAt: '2026-10-18T09:00:00.000Z',
};

export const QWEN: LocalModel = { id: 'qwen3-coder:30b', label: 'qwen3-coder:30b', sizeBytes: 18_600_000_000 };

const BY_STATE: Readonly<Record<LocalModelsState, Pick<LocalModels, 'message' | 'models'>>> = {
  found: { message: 'Ollama has 2 models installed on this machine.', models: [GPT_OSS, QWEN] },
  'none-pulled': { message: `Ollama is running, but no model is installed yet. Run: ${PULL}`, models: [] },
  'not-running': {
    message:
      'Ollama is not running at http://127.0.0.1:11434. Start it (open the Ollama app, or run: ollama serve), then check again.',
    models: [],
  },
  unreadable: {
    message:
      'Something answered at http://127.0.0.1:11434, but not as Ollama does. Check that the address is an Ollama server.',
    models: [],
  },
  refused: {
    message:
      'Ferretry only reads an Ollama server on this machine, and OLLAMA_HOST names another address. Point it at localhost, or unset it.',
    models: [],
  },
  disabled: {
    message: 'Reading the models Ollama has installed is switched off on this daemon (FY_LOCAL_MODELS=off).',
    models: [],
  },
};

export const localModelsFixture = (
  state: LocalModelsState = 'found',
  overrides: Partial<LocalModels> = {},
): LocalModels =>
  LocalModelsSchema.parse({
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    state,
    checkedAt: '2026-10-19T08:00:00.000Z',
    pullCommand: PULL,
    ...BY_STATE[state],
    ...overrides,
  });
