/**
 * Applies ONE `setup.import` through the ordinary change path (preview, passkey where the machine asks, apply) and answers in
 * the daemon's own sentences: what each owner wrote or refused. A plugin's last import page calls it once per harness.
 */
import { useCallback, useState } from 'react';
import type { AccountChange } from '../../../contract/index.ts';
import type { RuntimesClient } from '../../lib/client.ts';
import { type AccountChanges, useAccountChanges } from '../fleet/shell/apply-change-panel.tsx';
import { resultSentences } from './model.ts';

/** The daemon's own words for an import that has nothing it does not already hold. */
const NOTHING_NEW = /nothing new to import/iu;

/** How an apply ended. A refusal is told through `changes.refusal` and answers `null`. */
export interface ImportApplied {
  readonly kind: 'imported' | 'already-in';
  readonly sentences: readonly string[];
}

export interface ApplyImport {
  readonly changes: AccountChanges;
  readonly applied: ImportApplied | null;
  readonly apply: (change: AccountChange, label: string) => Promise<ImportApplied | null>;
}

export function useApplyImport(client: RuntimesClient): ApplyImport {
  const changes = useAccountChanges({ client });
  const [applied, setApplied] = useState<ImportApplied | null>(null);
  const apply = useCallback(
    async (change: AccountChange, label: string): Promise<ImportApplied | null> => {
      const result = await changes.apply(change);
      // "Nothing new" is not a failure to show: the tool is set up as it was.
      const alreadyIn = result.kind === 'refused' && NOTHING_NEW.test(result.sentence);
      if (result.kind !== 'applied' && !alreadyIn) return null;
      if (alreadyIn) changes.clear();
      const summary =
        result.kind === 'applied' && result.outcome.outcome === 'executed'
          ? result.outcome.summary
          : alreadyIn
            ? `Nothing new to bring in from ${label}: it is already set up.`
            : 'Imported.';
      const done: ImportApplied = { kind: alreadyIn ? 'already-in' : 'imported', sentences: resultSentences(summary) };
      setApplied(done);
      return done;
    },
    [changes],
  );
  return { changes, applied, apply };
}
