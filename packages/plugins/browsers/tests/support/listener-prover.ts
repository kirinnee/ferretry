import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type ListenerHostFacts, ProcListenerProver } from '../../daemon/worker/control/adapters/listener-prover.ts';

const NO_EVIDENCE = async (): Promise<never> => {
  throw new Error('no /proc evidence in this test');
};

/** Host facts that refuse every read: a prover over them can prove nothing, and answers `unknown`. */
export const REFUSING_FACTS: ListenerHostFacts = {
  pids: NO_EVIDENCE,
  procFile: NO_EVIDENCE,
  procSystemFile: NO_EVIDENCE,
  procFds: NO_EVIDENCE,
  procFdLink: NO_EVIDENCE,
};

/** A listener prover a test hands in on purpose, because the code under test no longer builds one itself. */
export function unprovenListenerProver(): ProcListenerProver {
  return new ProcListenerProver(REFUSING_FACTS);
}

/**
 * A listener prover over THIS host's real `/proc`, for the cases that are about a real socket: a port another program
 * holds is judged `foreign` from the kernel's own tables, as the daemon's does. Linux only; a case that needs it
 * is `it.if(process.platform === 'linux')`. Unlike {@link unprovenListenerProver} it CAN prove, so it must not stand
 * in for a case that is about something else.
 */
export function hostListenerProver(proc = '/proc'): ProcListenerProver {
  return new ProcListenerProver({
    pids: async () => (await readdir(proc)).filter(name => /^\d+$/u.test(name)).map(Number),
    procFile: async (pid, file) => await readFile(join(proc, String(pid), file), 'utf8'),
    procSystemFile: async file => await readFile(join(proc, file), 'utf8'),
    procFds: async pid => await readdir(join(proc, String(pid), 'fd')),
    procFdLink: async (pid, fd) => await readlink(join(proc, String(pid), 'fd', fd)),
  });
}

/** Who holds a taken port: nobody known. */
export const noHolder = async (): Promise<number | undefined> => undefined;
