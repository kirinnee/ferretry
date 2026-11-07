/**
 * What the daemon last read from a local model server (Ollama), as far as a picker reads it: the state, the daemon's
 * own sentence for it and the command that installs a model. `localModelsFixture('found')` is a machine with models.
 */

import type { LocalModelsSnapshot } from '../../src/ui/local-models-note.tsx';

export const PULL = 'ollama pull gpt-oss:20b';

type State = LocalModelsSnapshot['state'];

const MESSAGE: Readonly<Record<State, string>> = {
  found: 'Ollama has 2 models installed on this machine.',
  'none-pulled': `Ollama is running, but no model is installed yet. Run: ${PULL}`,
  'not-running':
    'Ollama is not running at http://127.0.0.1:11434. Start it (open the Ollama app, or run: ollama serve), then check again.',
  unreadable:
    'Something answered at http://127.0.0.1:11434, but not as Ollama does. Check that the address is an Ollama server.',
  refused:
    'Ferretry only reads an Ollama server on this machine, and OLLAMA_HOST names another address. Point it at localhost, or unset it.',
  disabled: 'Reading the models Ollama has installed is switched off on this daemon (FY_LOCAL_MODELS=off).',
};

export const localModelsFixture = (
  state: State = 'found',
  overrides: Partial<LocalModelsSnapshot> = {},
): LocalModelsSnapshot => ({ state, message: MESSAGE[state], pullCommand: PULL, ...overrides });
