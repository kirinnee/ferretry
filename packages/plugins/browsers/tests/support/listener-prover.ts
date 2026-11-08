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

/** Who holds a taken port: nobody known. */
export const noHolder = async (): Promise<number | undefined> => undefined;
