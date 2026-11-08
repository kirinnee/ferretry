import type { FerretId, FerretSummary } from '../../../contract/index.ts';
import type { LaunchInstructionSectionId } from '../protocol/session.ts';

/**
 * THE OUTDATED MARK ON THE FLEET LIST (today's `session/restart/outdated-view.ts` `withOutdated`, mounted at `fyd.ts`
 * with a 5 s window): puts `outdated: { sections }` on a running ferret's summary while a launch now would word its
 * instructions differently, and leaves every other summary as it is — the same object.
 *
 * It is a layer over the list and the view rather than a field the registry keeps, because working it out reads the
 * ferret's launch record and the snapshot's instructions, and nothing about either moves faster than a person looks:
 * each ferret's answer is kept for `ttlMs`.
 *
 * FAIL SAFE: the mark is advice. An answer that throws (a damaged launch record, a read that fails) is "not outdated",
 * so a list never fails to load because of it, and the mark is never shown on a guess. Restarts themselves never read
 * this cache: `POST /v1/restarts` and the drain ask afresh.
 *
 * IDENTITY: the list route recognises an unchanged fleet by the identity of each summary
 * (`conditional.ts`), so the same input summary with the same sections answers the same marked object.
 */

export interface OutdatedMarkPorts {
  /** The sections a launch now would change for this ferret (`[]` = current, or nothing proves otherwise). */
  readonly outdated: (ferret: FerretId) => Promise<readonly LaunchInstructionSectionId[]>;
  /** Milliseconds now (the kernel clock). */
  readonly nowMs: () => number;
  /** How long one ferret's answer is kept. */
  readonly ttlMs: number;
}

export interface OutdatedMark {
  /** The list with each running outdated ferret marked, in the same order. */
  list(summaries: readonly FerretSummary[]): Promise<readonly FerretSummary[]>;
  /** One summary, marked when it is running and outdated. */
  one(summary: FerretSummary): Promise<FerretSummary>;
}

const sameSections = (left: readonly LaunchInstructionSectionId[], right: readonly LaunchInstructionSectionId[]) =>
  left.length === right.length && left.every((section, at) => section === right[at]);

export function outdatedMark(ports: OutdatedMarkPorts): OutdatedMark {
  const answers = new Map<
    FerretId,
    { readonly atMs: number; readonly sections: readonly LaunchInstructionSectionId[] }
  >();
  const made = new WeakMap<
    FerretSummary,
    { readonly sections: readonly LaunchInstructionSectionId[]; readonly summary: FerretSummary }
  >();

  const sectionsOf = async (ferret: FerretId): Promise<readonly LaunchInstructionSectionId[]> => {
    const known = answers.get(ferret);
    if (known !== undefined && ports.nowMs() - known.atMs < ports.ttlMs) return known.sections;
    const sections = await ports.outdated(ferret).catch((): readonly LaunchInstructionSectionId[] => []);
    answers.set(ferret, { atMs: ports.nowMs(), sections });
    return sections;
  };

  const one = async (summary: FerretSummary): Promise<FerretSummary> => {
    // A stopped ferret has no instructions to be out of date with, and is not asked about: its answer is forgotten.
    if (summary.state === 'stopped') {
      answers.delete(summary.id);
      return summary;
    }
    const sections = await sectionsOf(summary.id);
    if (sections.length === 0) return summary;
    const known = made.get(summary);
    if (known !== undefined && sameSections(known.sections, sections)) return known.summary;
    const marked: FerretSummary = { ...summary, outdated: { sections: [...sections] } };
    made.set(summary, { sections, summary: marked });
    return marked;
  };

  return {
    list: async summaries => await Promise.all(summaries.map(one)),
    one,
  };
}
