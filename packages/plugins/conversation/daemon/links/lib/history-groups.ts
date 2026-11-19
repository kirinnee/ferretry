import type { HarnessHistoryFiles, HarnessHistorySource } from '@ferretry/core-ferrets/contract';
import type { TranscriptHarness } from '../../reader/lib/transcript/types.ts';
import type { IndexSource } from './conversation-index.ts';

/** A tree that holds nothing: it lists no folder, finds no file and reads no byte. */
const NOTHING: HarnessHistoryFiles = {
  entries: async () => [],
  stat: async () => undefined,
  read: async () => undefined,
};

/** What Ferrets hands over for each harness that ANSWERED (a harness that failed is not in it). */
export interface HistoryGroup {
  readonly harness: string;
  readonly sources: readonly HarnessHistorySource[];
}

/**
 * The trees the index reads, one per source each harness offers. A harness that answered with NO source at all (its
 * owner-history switch is off and it holds nothing else) is given one empty tree: the index judges only a harness that
 * answered, so without it that harness's rows from the computer would stay indexed after it stopped offering them. The empty
 * tree is the answer "nothing here now", and the index's own rule then removes what it had read from there.
 */
export function indexSourcesOf(
  groups: readonly HistoryGroup[],
  familyOf: (harness: string) => TranscriptHarness | undefined,
): readonly IndexSource[] {
  return groups.flatMap(group => {
    const parser = familyOf(group.harness);
    if (parser === undefined) return [];
    const offered: readonly HarnessHistorySource[] =
      group.sources.length > 0 ? group.sources : [{ kind: 'computer', label: 'owner', files: NOTHING }];
    return offered.map(source => ({
      harness: group.harness,
      parser,
      kind: source.kind,
      label: source.label,
      files: source.files,
    }));
  });
}
