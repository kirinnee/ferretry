import type { CompactionHistorySource, CompactionRecord } from '@ferretry/core-ferrets/contract';
import type { StatePort } from '@ferretry/kernel/contract';
import { COMPACTION_HISTORY_STATE, KEPT_COMPACTION_ENTRIES } from '../../../contract/index.ts';

/** How many of the newest matching entries the median is taken over. */
const MEDIAN_WINDOW = 20;
/** A model with fewer watched compactions than this borrows its harness's. */
const MIN_MODEL_ENTRIES = 3;

/**
 * How long this daemon's compactions have taken, kept in Usage's state folder so an estimate survives a restart
 * (F-0130, v4's `FileCompactionHistory`).
 *
 * A file that is absent or damaged is an EMPTY history, never an error: the only cost of losing it is that the next
 * estimate says `typical` again. The file declares the kernel's narrower damage policy, so a damaged one costs Usage
 * nothing else; and the kernel never writes over a damaged file, so a `record` made while it is damaged keeps nothing
 * (and says nothing: a lost estimate sample is not a failure) until the file is repaired or removed. Writes are
 * serialized, so two sessions finishing at once cannot lose one another's entry.
 */
export class StateCompactionHistory implements CompactionHistorySource {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: StatePort) {}

  async durations(harness: CompactionRecord['harness'], model: string | undefined): Promise<readonly number[]> {
    const entries = (await this.read()).filter(entry => entry.harness === harness);
    const sameModel = model === undefined ? [] : entries.filter(entry => entry.model === model);
    return (sameModel.length >= MIN_MODEL_ENTRIES ? sameModel : entries)
      .slice(-MEDIAN_WINDOW)
      .map(entry => entry.durationMs);
  }

  record(entry: CompactionRecord): Promise<void> {
    const write = this.pending.then(async () => {
      const entries = [...(await this.read()), entry].slice(-KEPT_COMPACTION_ENTRIES);
      await this.state.write(COMPACTION_HISTORY_STATE, { entries }).catch(error => {
        // The kernel refuses to write over a damaged file (the owner may want to look at it): the sample is dropped.
        if (!(error instanceof Error && error.name === 'StoreDamagedError')) throw error;
      });
    });
    this.pending = write.catch(() => undefined);
    return write;
  }

  private async read(): Promise<readonly CompactionRecord[]> {
    const read = await this.state.read(COMPACTION_HISTORY_STATE).catch(() => undefined);
    return read?.ok === true ? (read.value?.entries ?? []) : [];
  }
}
