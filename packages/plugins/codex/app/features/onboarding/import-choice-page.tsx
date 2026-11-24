/**
 * Step `import-choice`, the pre-screen: bring everything over from the Codex on this computer, choose what to bring, or
 * start fresh. The answer is this plugin's segment memory (`importMode`), which the import pages read to decide whether
 * to show. Nothing is imported here: that happens once, at `import-run`.
 *
 * The demo beside the cards shows what the run's scan REALLY found (read quietly, never asking for the passkey here); until it is
 * read it shows generic example words, so an empty machine never looks like it has things to bring.
 *
 * The memory lasts only this run (no browser storage), so after a reload the segment has no `importMode` while this step is
 * already answered. The import pages do NOT bring this page back: a kind page then shows its checklist exactly as in Customize
 * (every item ticked as Import everything would bring it), and the run page proposes what the pages answered.
 */
import { ChoiceCards, StepDemo } from '@ferretry/app';
import { ImportDemo } from './demos.tsx';
import { IMPORT_KINDS, kindFound, StepBody, StepLine } from '@ferretry/plugin-runtimes/import-kit';
import { useRunScan } from './import/use-run-scan.ts';
import type { OnboardingClient, StepHost } from './onboarding-api.ts';
import { useEffect, useRef, useState } from 'react';

const IMPORT_MODES = ['everything', 'choose', 'fresh'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

const OPTIONS = [
  {
    id: 'everything',
    title: 'Import everything',
    line: 'Settings, models, AGENTS.md, skills, MCP.',
  },
  {
    id: 'choose',
    title: 'Choose what to import',
    line: 'One kind at a time.',
  },
  { id: 'fresh', title: 'Start fresh', line: 'Bring nothing. Import later in Settings.' },
] as const;

/** The mode an earlier visit left in the segment memory; `everything` when there is none. */
const importModeOf = (step: StepHost): ImportMode => {
  const said = step.segment.importMode;
  return IMPORT_MODES.find(mode => mode === said) ?? 'everything';
};

export function ImportChoicePage({ client, step }: { readonly client: OnboardingClient; readonly step: StepHost }) {
  const { model } = useRunScan(client, step);
  const found = model === null ? null : IMPORT_KINDS.filter(kind => kindFound(model, kind));
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
    <StepBody step="codex.import-choice" label="Import from Codex" data-codex-step="import-choice">
      <ChoiceCards
        label="What to bring over"
        layout="stack"
        options={OPTIONS}
        value={mode}
        onChange={next => {
          const chosen = IMPORT_MODES.find(candidate => candidate === next) ?? 'everything';
          setMode(chosen);
          // Remembered only: nothing is saved here, and the shell records the step on Next (never `done()` for a mere choice).
          step.remember({ importMode: chosen });
        }}
      />
      <StepLine>Bring your Codex setup here? Hooks are never imported.</StepLine>
      <StepDemo>
        <ImportDemo mode={mode} found={found} />
      </StepDemo>
    </StepBody>
  );
}
