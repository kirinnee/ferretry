import type { PluginClient } from '@ferretry/kernel/manifest';

/** The one way to the daemon: declared routes, through the plugin's client. */
export type IJobGateway = Pick<PluginClient, 'call'>;

/** The attachment's own process, as the verbs need it. The adapter reads the real one; tests hand in a fake. */
export interface IJobProcess {
  readonly pid: number;
  /** The folder this command was typed in (a job starts there). */
  cwd(): string;
  /** Where this process's stdout points when that is a file (Linux: `/proc/self/fd/1`); undefined otherwise. */
  stdoutFile(): string | undefined;
}

/** SIGTERM, SIGHUP and SIGINT, as the attachment hears them. Returns how to stop listening. */
export interface IJobSignals {
  listen(onSignal: (name: string) => void): () => void;
}

export interface IJobTimers {
  nowMs(): number;
  /** Waits; resolves early (never rejects) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
