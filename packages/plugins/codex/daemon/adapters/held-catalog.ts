import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { RuntimeModelChoice } from '../lib/models.ts';
import type { HarnessLocation } from '../lib/update/index.ts';
import { probeEnvironment } from './probe.ts';

/**
 * The Codex model catalog a fast start is judged against, HELD so a start never waits for it.
 *
 * A start asks `start.decide` in the kernel's default 200 ms, so the answer has to come from a catalog already in hand.
 * This holds the last good read and refreshes it from a job of its own (once at boot, then on a timer); the read is a
 * child bounded at 10 s, and that bound lives in the job, never in the start. Before the first read lands, or when no
 * read has ever worked, {@link HeldFastCatalog.held} is `undefined` and the start is let through (GAP(codex), declared
 * in `ports-pending.json`).
 *
 * THE CHILD HAS ITS OWN PLACE AND NO LOGIN. It runs in a folder this class creates under the plugin's own `agent-homes`
 * root, with the scrubbed {@link probeEnvironment} (a throwaway `HOME` and `CODEX_HOME` inside that folder, every proxy
 * pointed at nothing). It never gets the daemon user's real `HOME`, so it never reads `~/.codex` or any sign-in, and it
 * cannot reach a provider with one. The catalog it reads is therefore the login-less one, not any account's own.
 */
export interface HeldFastCatalogPorts {
  /** The plugin's own `agent-homes` root, scoped to the folder this catalog's child lives in. */
  readonly workspace: RootHandle;
  /** The one environment each of `PATH` and `LANG` is read from (the daemon's, never `HOME`). */
  readonly environment: (name: 'PATH' | 'LANG') => Promise<string | undefined>;
  /** Where the Codex binary is, or that it is not. */
  readonly locate: () => Promise<HarnessLocation>;
  /** One `model/list` exchange: the binary, the child's cwd and its (scrubbed) environment. */
  readonly read: (
    binary: string,
    cwd: FencedPath,
    env: Readonly<Record<string, string>>,
  ) => Promise<readonly RuntimeModelChoice[]>;
}

export class HeldFastCatalog {
  #held: readonly RuntimeModelChoice[] | undefined;
  #pending: Promise<void> | undefined;

  constructor(private readonly ports: HeldFastCatalogPorts) {}

  /** The catalog the last refresh read, or nothing when none has worked yet. Never waits, never spawns. */
  held(): readonly RuntimeModelChoice[] | undefined {
    return this.#held;
  }

  /**
   * Read the catalog once and hold it. A failed read keeps what was held (nothing, the first time) and rethrows so the
   * job that called this is told; two refreshes at once share one child.
   */
  async refresh(): Promise<void> {
    this.#pending ??= this.#read().finally(() => {
      this.#pending = undefined;
    });
    await this.#pending;
  }

  async #read(): Promise<void> {
    const location = await this.ports.locate();
    if (location.outcome !== 'located') return;
    const home = this.ports.workspace.resolve('home');
    const work = this.ports.workspace.resolve('work');
    if (!home.ok) throw new Error(`Codex's catalog home could not be placed: ${home.error}`);
    if (!work.ok) throw new Error(`Codex's catalog folder could not be placed: ${work.error}`);
    // Created here, because a child started in a folder that is not there does not start at all.
    await this.ports.workspace.makeDirectory(home.value);
    await this.ports.workspace.makeDirectory(work.value);
    const [path, lang] = await Promise.all([this.ports.environment('PATH'), this.ports.environment('LANG')]);
    const env = probeEnvironment(location.path, home.value, { PATH: path, LANG: lang });
    this.#held = await this.ports.read(location.path, work.value, env);
  }
}
