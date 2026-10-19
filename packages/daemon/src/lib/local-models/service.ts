import type { LocalModels } from '@ferretry/protocol';
import type { ProviderProbePort } from '../provider-probe/ports.ts';
import { describeOllama, OLLAMA_MAX_BYTES, OLLAMA_TIMEOUT_MS, ollamaAddress } from './ollama.ts';

export interface LocalModelsServiceDeps {
  /** The one boundary a keyless read of this machine crosses; it refuses any address that is not loopback. */
  readonly probe: ProviderProbePort;
  /** `OLLAMA_HOST` (or the override that replaces it); `undefined` reads the default address. */
  readonly address: string | undefined;
  /** `false` reads nothing at all (`FY_LOCAL_MODELS=off`, which every test tier sets). */
  readonly enabled: boolean;
  /** The model the catalog suggests, named in the command that installs one. */
  readonly suggested: () => Promise<string>;
  readonly now: () => string;
  /** Run when a read changed what the machine has, so the fleet can offer it. It must never throw. */
  readonly onChanged?: () => Promise<void>;
}

/** What a read came to, reduced to what a runtime's model list depends on: only a server with models changes it. */
const fingerprint = (view: LocalModels | undefined): string =>
  view?.state === 'found' ? view.models.map(model => model.id).join(',') : '';

/**
 * The models installed on this machine, read from Ollama (docs/model-catalog.md § Local models).
 *
 * NOTHING HERE RUNS ON ITS OWN. A read happens when somebody asks (`refresh`): the daemon on boot, and a
 * person opening Settings or a login's setup. There is no timer, no retry and no inference, so a machine
 * nobody is looking at asks Ollama nothing. `snapshot` is the last answer, held in memory only — a
 * restart forgets it and the next read restores it.
 *
 * It never throws: Ollama not running is an answer (`not-running`), with a sentence a person can act on.
 */
export class LocalModelsService {
  #held: LocalModels | undefined;
  #reading: Promise<LocalModels> | undefined;

  constructor(private readonly deps: LocalModelsServiceDeps) {}

  /** The last answer, or `undefined` before anything has been read. No IO. */
  snapshot(): LocalModels | undefined {
    return this.#held;
  }

  /** Read Ollama now. Callers that arrive while a read is under way share its answer. */
  refresh(): Promise<LocalModels> {
    this.#reading ??= this.#read().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  async #read(): Promise<LocalModels> {
    const address = ollamaAddress(this.deps.address);
    const outcome =
      address.ok && this.deps.enabled
        ? await this.deps.probe.probe({
            kind: 'local',
            spends: 'nothing',
            request: {
              method: 'GET',
              url: `${address.baseUrl}/api/tags`,
              headers: { accept: 'application/json' },
              timeoutMs: OLLAMA_TIMEOUT_MS,
              maxResponseBytes: OLLAMA_MAX_BYTES,
            },
          })
        : undefined;
    const view = describeOllama({
      address,
      outcome,
      disabled: !this.deps.enabled,
      suggested: await this.deps.suggested(),
      at: this.deps.now(),
    });
    const previous = this.#held;
    this.#held = view;
    if (fingerprint(previous) !== fingerprint(view)) await this.deps.onChanged?.();
    return view;
  }
}
