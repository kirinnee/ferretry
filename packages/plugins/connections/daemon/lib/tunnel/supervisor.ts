/**
 * THE `cloudflared` CHILD, KEPT RUNNING — `docs/relay-protocol.md` §15 "The daemon end".
 *
 * One connector at a time, started with the token the hosted service provisioned, restarted with a
 * capped, jittered backoff whenever it exits, killed and restarted when the token changes, and stopped
 * with the daemon. Whether the tunnel is REACHABLE is read from what the child logs — a registered edge
 * connection — never assumed from the child merely running: a connector that cannot reach the edge is a
 * running process serving nobody, and publishing its hostname would send devices to a dead address.
 *
 * GENERATIONS, NOT FLAGS. Every child is spawned under a generation number, and a line or an exit from
 * any generation but the current one is ignored. That is what makes a token swap safe: the old child's
 * dying words cannot withdraw the new child's registration, and its exit cannot schedule a restart of a
 * connector nobody wants.
 */

import { CLOUDFLARED_ARGUMENTS, connectorEnvironment, connectorEvent } from './connector.ts';
import {
  type BackoffPolicy,
  backoffDelayMs,
  type ScheduledAction,
  secondsPhrase,
  type TunnelScheduler,
} from './schedule.ts';

/** What the process adapter is asked to run. The token is in `environment` and nowhere else. */
export interface ConnectorCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** ADDITIONS to the daemon's own environment, for this child only. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface ConnectorProcess {
  /** Settles once with the exit code, or `null` when a signal ended it. Never rejects. */
  readonly exited: Promise<number | null>;
  /** Asks the child to stop, escalating if it does not. Idempotent. */
  terminate(): void;
}

/** Starts a child and hands each line of its log to `onLine`. Throws when it cannot start one. */
export interface ConnectorProcessPort {
  spawn(command: ConnectorCommand, onLine: (line: string) => void): ConnectorProcess;
}

/** A connector that exits is restarted after 1 s, doubling to a one-minute ceiling, jittered. */
export const CONNECTOR_RESTART_BACKOFF: BackoffPolicy = Object.freeze({ baseMs: 1_000, capMs: 60_000 });

export interface ConnectorSupervisorDependencies {
  readonly executable: string;
  readonly processes: ConnectorProcessPort;
  readonly scheduler: TunnelScheduler;
  readonly random: () => number;
  /** A line for the boot trail. Never given the token: nothing here has a sentence that holds it. */
  readonly notice: (line: string) => void;
  /** Called on every change between "an edge connection is registered" and "none is". */
  readonly registration: (registered: boolean) => void;
}

export class ConnectorSupervisor {
  #token: string | undefined;
  #child: ConnectorProcess | undefined;
  /** The exit of a child being replaced; the next one starts only after it has gone. */
  #dying: Promise<unknown> | undefined;
  #generation = 0;
  #attempt = 0;
  #restart: ScheduledAction | undefined;
  #stopped = false;
  readonly #connections = new Set<string>();

  constructor(private readonly deps: ConnectorSupervisorDependencies) {}

  /** Whether at least one edge connection is registered right now. */
  get registered(): boolean {
    return this.#connections.size > 0;
  }

  /**
   * Runs the connector with this token. The same token again changes nothing — a running or
   * restarting connector already has it. A DIFFERENT token kills the running child first: two
   * connectors on two tokens would be two claims on one hostname.
   */
  run(token: string): void {
    if (this.#stopped || token === this.#token) return;
    this.#token = token;
    this.#attempt = 0;
    this.#cancelRestart();
    const old = this.#child;
    if (old !== undefined) {
      this.#generation += 1;
      this.#child = undefined;
      this.#lose();
      old.terminate();
      this.#dying = old.exited;
    }
    this.#spawnWhenClear();
  }

  /** Stops the connector for good and waits for it to go. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelRestart();
    this.#generation += 1;
    const child = this.#child;
    this.#child = undefined;
    this.#lose();
    if (child === undefined) return;
    child.terminate();
    await child.exited;
  }

  #spawnWhenClear(): void {
    const generation = ++this.#generation;
    const dying = this.#dying;
    if (dying === undefined) {
      this.#spawn(generation);
      return;
    }
    void dying.then(() => {
      if (this.#dying === dying) this.#dying = undefined;
      if (generation === this.#generation && !this.#stopped) this.#spawn(generation);
    });
  }

  #spawn(generation: number): void {
    // `run` set it before any spawn could be asked for, and nothing clears it.
    const token = this.#token as string;
    let child: ConnectorProcess;
    try {
      child = this.deps.processes.spawn(
        { executable: this.deps.executable, args: CLOUDFLARED_ARGUMENTS, environment: connectorEnvironment(token) },
        line => this.#line(generation, line),
      );
    } catch (error) {
      // A message about the executable — never the environment, which is the only place the token is.
      const reason = error instanceof Error ? error.message : String(error);
      this.#scheduleRestart(`cloudflared could not be started (${reason})`);
      return;
    }
    this.#child = child;
    void child.exited.then(code => this.#exited(generation, code));
  }

  #line(generation: number, line: string): void {
    if (generation !== this.#generation) return;
    const event = connectorEvent(line);
    if (event === undefined) return;
    const was = this.registered;
    if (event.kind === 'registered') this.#connections.add(event.connection);
    else this.#connections.delete(event.connection);
    if (was === this.registered) return;
    // A connector that reached the edge has proved the token and the network; the next failure starts
    // its backoff from the beginning rather than from wherever the last outage left it.
    if (this.registered) this.#attempt = 0;
    this.deps.registration(this.registered);
  }

  #exited(generation: number, code: number | null): void {
    if (generation !== this.#generation) return;
    this.#child = undefined;
    this.#lose();
    if (this.#stopped) return;
    this.#scheduleRestart(`cloudflared exited (${code === null ? 'by a signal' : `code ${String(code)}`})`);
  }

  #scheduleRestart(what: string): void {
    const delay = backoffDelayMs(CONNECTOR_RESTART_BACKOFF, this.#attempt, this.deps.random);
    this.#attempt += 1;
    this.deps.notice(`tunnel connector down — ${what}; restarting in ${secondsPhrase(delay)}`);
    this.#restart = this.deps.scheduler.after(delay, () => {
      this.#restart = undefined;
      if (!this.#stopped) this.#spawnWhenClear();
    });
  }

  #cancelRestart(): void {
    this.#restart?.cancel();
    this.#restart = undefined;
  }

  /** Every connection is gone with its child; say so once if any had registered. */
  #lose(): void {
    if (this.#connections.size === 0) return;
    this.#connections.clear();
    this.deps.registration(false);
  }
}
