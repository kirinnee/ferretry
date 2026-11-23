import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { epochMs, type Instant } from '@ferretry/std';
import type { HeldCatalogFile } from '../../contract/index.ts';
import type { RuntimeModelChoice } from '../lib/models.ts';
import type { HarnessLocation } from '../lib/update/index.ts';
import { CodexModelCatalogError, type CatalogFailureKind } from '../lib/app-server.ts';
import { probeEnvironment } from './probe.ts';

/**
 * The Codex model catalog a fast start is judged against, HELD so a start never waits for it.
 *
 * A start asks `start.decide` in the kernel's default 200 ms, so the answer has to come from a catalog already in hand.
 * This holds the last good read, KEPT ON DISK (the model list only, in the plugin's own state) so a start right after a
 * boot decides from it at once. It is read again at boot and then only when a fast start finds the held copy older than
 * {@link STALE_AFTER_MS} (or nothing held); that refresh is fire and forget, and the start is answered from what is held.
 * With nothing held — the first boot ever, or no read has ever worked — {@link HeldFastCatalog.held} is `undefined` and
 * the Codex decision REFUSES a fast start (`fast-mode.ts`). Fast is never allowed unverified: the `openai` model catalog's
 * codex half ({@link HeldFastCatalog.fallbackChoices}, the `fallback` port) states no service tier, so it only lets the
 * refusal say whether the model is one Ferretry knows (a retry will work) or not.
 *
 * A read that fails is logged once per failing streak (its allowlisted kind and codes only, never a message: see
 * {@link describeFailure}) and is not asked for again until a backoff has passed: 1 minute, then 5, then 30 ({@link RETRY_BACKOFF_MS}); a read that works resets it.
 *
 * THE CHILD HAS ITS OWN PLACE AND NO LOGIN. It runs in a folder this class creates under the plugin's own `agent-homes`
 * root, with the scrubbed {@link probeEnvironment} (a throwaway `HOME` and `CODEX_HOME` inside that folder, every proxy
 * pointed at nothing). It never gets the daemon user's real `HOME`, so it never reads `~/.codex` or any sign-in, and it
 * cannot reach a provider with one. The catalog it reads is therefore the login-less one, not any account's own.
 * UNVERIFIED: whether `codex app-server` answers `model/list` at all without a login is not checked by any unit test (it
 * needs the real binary); if it never answers, nothing is ever held and every fast Codex start is refused.
 */

/** How old the held copy may get before a fast start asks for a fresh read: Codex's own on-disk model cache lifetime. */
export const STALE_AFTER_MS = 300_000;

/** How long a failed (or binary-less) read waits before a fast start may ask for another: 1 minute, then 5, then 30. */
const RETRY_BACKOFF_MS: readonly number[] = [60_000, 300_000, 1_800_000];

/** What a log says for each kind of failure: a fixed sentence per kind, never anything the failing side wrote. */
const FAILURE_SENTENCE: Readonly<Record<CatalogFailureKind, string>> = {
  'rpc-error': 'the app-server answered the model list request with an error',
  'invalid-response': 'the app-server answered with something that is not a model list',
  'no-models': 'the app-server listed no selectable models',
  'non-json': 'the app-server wrote something that is not JSON',
  timeout: 'the app-server did not answer in time',
  'ended-early': 'the app-server ended before the list was complete',
  stopped: 'the read was stopped',
  setup: "the read's folders could not be set up",
};

/**
 * A failure described for a log from ALLOWLISTED parts only: one fixed sentence for its kind, plus a JSON-RPC error code
 * (an integer) or an operating-system error code (`ENOENT` and the like, matched against a strict shape). The error's
 * own message is NEVER read: it can hold the child's stderr or the server's words (a token in a JSON field, a URL with
 * `?access_token=`), and no amount of masking free text is a promise about it.
 */
function describeFailure(error: unknown): string {
  if (error instanceof CodexModelCatalogError) {
    const code = error.rpcCode === undefined ? '' : ` (RPC code ${error.rpcCode})`;
    return `${FAILURE_SENTENCE[error.kind]}${code}`;
  }
  const errno = (error as { readonly code?: unknown } | null)?.code;
  if (typeof errno === 'string' && /^E[A-Z0-9_]{2,20}$/u.test(errno))
    return `the app-server could not be run (${errno})`;
  return 'the read failed for a reason that is not logged';
}

export interface HeldFastCatalogPorts {
  /** The plugin's own `agent-homes` root, scoped to the folder this catalog's child lives in. */
  readonly workspace: RootHandle;
  /** The one environment each of `PATH` and `LANG` is read from (the daemon's, never `HOME`). */
  readonly environment: (name: 'PATH' | 'LANG') => Promise<string | undefined>;
  /** Where the Codex binary is, or that it is not. */
  readonly locate: () => Promise<HarnessLocation>;
  /** One `model/list` exchange: the binary, the child's cwd, its (scrubbed) environment, and the abort signal. */
  readonly read: (
    binary: string,
    cwd: FencedPath,
    env: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => Promise<readonly RuntimeModelChoice[]>;
  readonly nowMs: () => number;
  readonly now: () => Instant;
  /**
   * The models the `openai` catalog lists for Codex, as choices with `fast` left unset (it says nothing about service
   * tiers), or nothing when no such catalog is in effect. Judged from only while no read has landed.
   */
  readonly fallback: () => Promise<readonly RuntimeModelChoice[] | undefined>;
  /** The last good catalog on disk, or nothing (never written, or not a catalog this version can read). */
  readonly load: () => Promise<HeldCatalogFile | undefined>;
  /** Write the catalog atomically (the state seam does); the model list only. */
  readonly save: (file: HeldCatalogFile) => Promise<void>;
  /** Ask for a refresh on the plugin's worker lane (fire and forget). */
  readonly requestRefresh: () => void;
  /** Said once per failing streak, not on every failed read. */
  readonly warn: (message: string) => void;
}

export class HeldFastCatalog {
  #held: readonly RuntimeModelChoice[] | undefined;
  #readAtMs = 0;
  #pending: Promise<void> | undefined;
  #loaded: Promise<void> | undefined;
  #fallback: readonly RuntimeModelChoice[] | undefined;
  #failing = false;
  #unlocated = false;
  #misses = 0;
  #retryAtMs = 0;

  constructor(private readonly ports: HeldFastCatalogPorts) {}

  /** Load what is on disk, once. Never replaces a catalog a read has already landed. */
  loaded(): Promise<void> {
    this.#loaded ??= this.#load();
    return this.#loaded;
  }

  async #load(): Promise<void> {
    await this.#loadFallback();
    let file: HeldCatalogFile | undefined;
    try {
      file = await this.ports.load();
    } catch {
      return;
    }
    if (file === undefined || this.#held !== undefined) return;
    this.#held = file.choices as readonly RuntimeModelChoice[];
    this.#readAtMs = epochMs(file.readAt);
  }

  async #loadFallback(): Promise<void> {
    try {
      const choices = await this.ports.fallback();
      this.#fallback = choices !== undefined && choices.length > 0 ? choices : undefined;
    } catch {
      this.#fallback = undefined;
    }
  }

  /** The catalog the last read produced (or the disk held), or nothing. Never waits, never spawns. */
  held(): readonly RuntimeModelChoice[] | undefined {
    return this.#held;
  }

  /**
   * The `openai` catalog's Codex models as last looked up (at load, and after a failed read), or nothing. They say nothing
   * about fast mode, so a fast start is never allowed from them; they only tell the refusal what it is refusing. Never
   * waits, never spawns. The model switch does not use them: it needs the labels Codex advertises, which only a read gives.
   */
  fallbackChoices(): readonly RuntimeModelChoice[] | undefined {
    return this.#fallback;
  }

  /**
   * True once a read looked for the Codex binary and did not find it (and nothing is held to say otherwise). It tells a
   * refusal apart: "still loading" is true while a read is yet to come, but a binary that is not there will never load.
   * It is not a catalog wait — it only reports what the last read saw.
   */
  binaryMissing(): boolean {
    return this.#unlocated;
  }

  /**
   * Called when a fast start arrives: if nothing is held, or the held copy is older than {@link STALE_AFTER_MS}, ask for
   * a read. Fire and forget — the start is answered from what is held, now.
   */
  // A read that keeps failing, or finds no binary, waits out {@link RETRY_BACKOFF_MS} before it is asked for again.
  refreshIfStale(): void {
    if (this.#pending !== undefined) return;
    const now = this.ports.nowMs();
    if (this.#held !== undefined && now - this.#readAtMs <= STALE_AFTER_MS) return;
    if (now < this.#retryAtMs) return;
    this.ports.requestRefresh();
  }

  /** Milliseconds until a failed read is next asked for (rounded up to a whole minute by callers); 0 when none is waiting. */
  retryInMs(): number {
    return Math.max(0, this.#retryAtMs - this.ports.nowMs());
  }

  #backOff(): void {
    const wait = RETRY_BACKOFF_MS[Math.min(this.#misses, RETRY_BACKOFF_MS.length - 1)] as number;
    this.#misses += 1;
    this.#retryAtMs = this.ports.nowMs() + wait;
  }

  /**
   * Read the catalog once, hold it and keep it on disk. A failed read keeps what was held and says so once per failing
   * streak (a read that keeps failing is not announced every time); it never throws, so the job that calls it is not
   * restarted. Two refreshes at once share one child.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    // THE READ BOUNDARY. Every caller comes through here (a fast start's kick, and the job that runs once after start), so
    // the backoff is held here and not in whoever asks: a read inside the wait is not made, and does not lengthen it.
    if (this.#pending === undefined && this.ports.nowMs() < this.#retryAtMs) return;
    this.#pending ??= this.#read(signal)
      .then(landed => {
        if (landed) {
          this.#failing = false;
          this.#misses = 0;
          this.#retryAtMs = 0;
        } else this.#backOff();
      })
      .catch(async (error: unknown) => {
        this.#backOff();
        await this.#loadFallback();
        if (this.#failing) return;
        this.#failing = true;
        // The KIND of failure is what makes this warning fixable from the log; the free text never is (it can hold a secret).
        const why = ` (${describeFailure(error)})`;
        const effect =
          this.#held !== undefined
            ? 'fast starts on Codex are judged from the last good read'
            : 'fast starts on Codex are refused until it can be read';
        const wait = `next try in ${Math.round((RETRY_BACKOFF_MS[Math.min(this.#misses, RETRY_BACKOFF_MS.length) - 1] as number) / 60_000)} min`;
        this.ports.warn(`the Codex model catalog could not be read${why}; ${effect} (${wait})`);
      })
      .finally(() => {
        this.#pending = undefined;
      });
    await this.#pending;
  }

  /** True when a catalog landed; false when there was no binary to ask. A failed read throws. */
  async #read(signal: AbortSignal | undefined): Promise<boolean> {
    const location = await this.ports.locate();
    this.#unlocated = location.outcome !== 'located';
    if (location.outcome !== 'located') return false;
    const home = this.ports.workspace.resolve('home');
    // The child's CODEX_HOME (`probeEnvironment`: `<home>/.codex`). Codex refuses to start at all when it is not there
    // ("CODEX_HOME points to ..., but that path does not exist"), which is why no read ever landed before O8-4.
    const codexHome = this.ports.workspace.resolve('home/.codex');
    const work = this.ports.workspace.resolve('work');
    if (!home.ok) throw new CodexModelCatalogError(`Codex's catalog home could not be placed: ${home.error}`, 'setup');
    if (!work.ok)
      throw new CodexModelCatalogError(`Codex's catalog folder could not be placed: ${work.error}`, 'setup');
    if (!codexHome.ok)
      throw new CodexModelCatalogError(`Codex's catalog CODEX_HOME could not be placed: ${codexHome.error}`, 'setup');
    // Created here, because a child started in a folder that is not there does not start at all.
    await this.ports.workspace.makeDirectory(home.value);
    await this.ports.workspace.makeDirectory(codexHome.value);
    await this.ports.workspace.makeDirectory(work.value);
    const [path, lang] = await Promise.all([this.ports.environment('PATH'), this.ports.environment('LANG')]);
    const env = probeEnvironment(location.path, home.value, { PATH: path, LANG: lang });
    const choices = await this.ports.read(location.path, work.value, env, signal);
    this.#held = choices;
    this.#readAtMs = this.ports.nowMs();
    // A save that fails costs only the next boot's head start; the catalog in memory is good.
    await this.ports
      .save({ format: 1, readAt: this.ports.now(), choices: choices as HeldCatalogFile['choices'] })
      .catch(() => undefined);
    return true;
  }
}
