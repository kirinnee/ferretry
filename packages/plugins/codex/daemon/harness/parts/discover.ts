import type { HarnessInstall, HarnessMissing } from '@ferretry/core-ferrets/contract';
import { HarnessUpdateRefusal } from '../../lib/update/index.ts';
import type { HarnessPart } from './context.ts';

/** Finding the binary and its version, and updating it. */
export const discoverPart: HarnessPart<'discover' | 'update'> = ({ locate, probe, update }) => {
  return {
    async discover(): Promise<HarnessInstall | HarnessMissing> {
      const location = await locate();
      if (location.outcome === 'absent') return { found: false, reason: 'codex was not found on this machine' };
      if (location.outcome === 'override-absent') return { found: false, reason: location.reason };
      const installed = await probe.version(location.path);
      return installed.state === 'ok'
        ? { found: true, binary: location.path, version: installed.version }
        : { found: false, reason: `codex at ${location.path} did not report a version (${installed.reason})` };
    },

    async update() {
      try {
        await update.start({});
        await update.settled();
        const job = (await update.view()).job;
        if (job?.state !== 'finished') return { updated: false, sentence: 'the update did not finish' };
        const report = job.report;
        return {
          updated: report.outcome === 'succeeded',
          ...(report.to === undefined ? {} : { version: report.to }),
          sentence: report.message,
        };
      } catch (error) {
        if (error instanceof HarnessUpdateRefusal) return { updated: false, sentence: error.message };
        throw error;
      }
    },
  };
};
