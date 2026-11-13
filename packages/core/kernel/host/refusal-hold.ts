/** `launchd` sets `XPC_SERVICE_NAME` to the job's label; a shell that is not a job has it `0` (or unset). */
export function startedByLaunchd(env: Readonly<Record<string, string | undefined>>): boolean {
  const name = env.XPC_SERVICE_NAME;
  return name !== undefined && name !== '' && name !== '0';
}

/** The process's signal and timer seams, so a test drives the hold without signalling itself. */
export interface HoldProcess {
  once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
  /** Keeps the event loop alive until the returned function is called. */
  keepAlive(): () => void;
}

const realProcess: HoldProcess = {
  once: (signal, handler) => void process.once(signal, handler),
  keepAlive: () => {
    const timer = setInterval(() => {}, 2 ** 30);
    return () => clearInterval(timer);
  },
};

/**
 * Stay alive and idle until the first SIGTERM or SIGINT, then resolve `exitCode`. Opens no port, no lock and no file.
 *
 * Why not just exit: a launchd job with `KeepAlive` is respawned every `ThrottleInterval` (10 s) whatever its exit code,
 * so a daemon that refuses a home it must not use would refuse again, and write its refusal into that home's log, for as
 * long as the job is loaded. Held idle, the sentence is said once, the job looks started, and the owner's `bootout` (a
 * SIGTERM) ends it with the code a plain refusal has.
 */
export async function holdUntilStopped(exitCode: number, proc: HoldProcess = realProcess): Promise<number> {
  const release = proc.keepAlive();
  await new Promise<void>(resolve => {
    proc.once('SIGTERM', resolve);
    proc.once('SIGINT', resolve);
  });
  release();
  return exitCode;
}
