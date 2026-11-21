/**
 * THE SAME PROGRESS BAR the setup pages draw (`StepProgress`), so the first screens are steps of the same run, not a
 * different thing. Which segment is current depends on the pairing stage; a stage with no entry draws no bar.
 */
import { StepProgress } from '@ferretry/app';

const PAIR_SEGMENTS = [
  { id: 'pair', label: 'Pair' },
  { id: 'connected', label: 'Connected' },
  { id: 'setup', label: 'Set up' },
] as const;

const PROGRESS_AT: Readonly<Record<string, string | undefined>> = {
  // The first screen (scan, paste and the /pair browse state are all this one stage) is step 1 of the same run.
  browse: 'pair',
  // The first screen (scan, paste and the /pair browse state are all this one stage) is step 1 of the same run.
  confirm: 'pair',
  pairing: 'pair',
  failed: 'pair',
  paired: 'connected',
};

export function PairProgress({ stage }: { readonly stage: string }) {
  const current = PROGRESS_AT[stage];
  if (current === undefined) return null;
  return (
    <StepProgress
      segments={PAIR_SEGMENTS}
      current={current}
      step={PAIR_SEGMENTS.findIndex(segment => segment.id === current) + 1}
      of={PAIR_SEGMENTS.length}
    />
  );
}
