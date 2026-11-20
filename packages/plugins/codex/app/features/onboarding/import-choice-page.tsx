/**
 * Step `import-choice`, the pre-screen: bring everything over from the Codex on this computer, choose what to bring, or
 * start fresh. The answer is this plugin's segment memory (`importMode`), which the import pages read to decide whether
 * to show. Nothing is imported here: that happens once, at `import-run`.
 *
 * The memory lasts only this run (no browser storage), so after a reload the segment has no `importMode` while this step is
 * already answered. The import pages do NOT bring this page back: a kind page then shows its checklist exactly as in Customize
 * (every item ticked as Import everything would bring it), and the run page proposes what the pages answered.
 */
import { ChoiceCards } from '@ferretry/app';
import type { StepHost } from './onboarding-api.ts';
import { useEffect, useRef, useState } from 'react';

const IMPORT_MODES = ['everything', 'choose', 'fresh'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

const OPTIONS = [
  {
    id: 'everything',
    title: 'Import everything',
    line: 'Settings, models, AGENTS.md, skills and servers from your Codex',
  },
  { id: 'choose', title: 'Choose what to import', line: 'One short page for each kind' },
  { id: 'fresh', title: 'Start fresh', line: 'Nothing is copied' },
] as const;

/** The mode an earlier visit left in the segment memory; `everything` when there is none. */
const importModeOf = (step: StepHost): ImportMode => {
  const said = step.segment.importMode;
  return IMPORT_MODES.find(mode => mode === said) ?? 'everything';
};

export function ImportChoicePage({ step }: { readonly step: StepHost }) {
  const [mode, setMode] = useState<ImportMode>(() => importModeOf(step));
  const opened = useRef(false);
  useEffect(() => {
    // Once, on opening: the default stands even if the person only presses Next, so the later pages can read it.
    if (opened.current) return;
    opened.current = true;
    step.remember({ importMode: mode });
    step.ready();
  }, [step, mode]);
  return (
    <section aria-label="Import from Codex" data-codex-step="import-choice">
      <ChoiceCards
        label="What to import from your Codex"
        options={OPTIONS}
        value={mode}
        onChange={next => {
          const chosen = IMPORT_MODES.find(candidate => candidate === next) ?? 'everything';
          setMode(chosen);
          // Remembered only: nothing is saved here, and the shell records the step on Next (never `done()` for a mere choice).
          step.remember({ importMode: chosen });
        }}
      />
    </section>
  );
}
