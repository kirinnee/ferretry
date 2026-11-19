/**
 * Step `import-choice`, the pre-screen: bring everything over from the Codex on this computer, choose what to bring, or
 * start fresh. The answer is this plugin's segment memory (`importMode`), which the import pages read to decide whether
 * to show. Nothing is imported here: that happens once, at `import-run`.
 *
 * The memory lasts only this run (no browser storage), so after a reload the segment has no `importMode` while this step is
 * already answered. A MISSING mode therefore means "ask again": every import step puts this page back in front of itself
 * (`returned`) and does not run, skip-by-choice or answer itself until the person has chosen. In that form nothing is chosen
 * for the person (no default is remembered) and the step is `busy` until they press a card, so Next cannot answer it either.
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

/** The mode the segment memory holds, or `undefined` when there is none (a fresh run, or a reload). */
export const rememberedImportMode = (step: StepHost): ImportMode | undefined =>
  IMPORT_MODES.find(mode => mode === step.segment.importMode);

/** The mode an earlier visit left in the segment memory; `everything` when there is none. */
const importModeOf = (step: StepHost): ImportMode => {
  const said = step.segment.importMode;
  return IMPORT_MODES.find(mode => mode === said) ?? 'everything';
};

const ASK_AGAIN = 'Choose what to bring over first';

/** The choice put back in front of an import step whose memory is empty: nothing is pre-chosen, nothing is answered by default. */
function ReturnedChoice({
  step,
  onChosen,
}: {
  readonly step: StepHost;
  readonly onChosen: (mode: ImportMode) => void;
}) {
  useEffect(() => {
    step.ready();
    step.busy(ASK_AGAIN);
  }, [step]);
  return (
    <section
      aria-label="Import from Codex"
      className="flex flex-col gap-3"
      data-codex-step="import-choice"
      data-returned=""
    >
      <p className="m-0 max-w-xl text-cell text-muted">
        Your earlier answer was not kept, so choose again what to bring over from Codex.
      </p>
      <ChoiceCards
        label="What to import from your Codex"
        options={OPTIONS}
        value={null}
        onChange={next => {
          const chosen = IMPORT_MODES.find(candidate => candidate === next);
          if (chosen === undefined) return;
          step.remember({ importMode: chosen });
          step.busy(null);
          onChosen(chosen);
        }}
      />
    </section>
  );
}

export function ImportChoicePage({
  step,
  returned,
}: {
  readonly step: StepHost;
  /** Set when an import step shows this page because the memory was empty: the step carries on once a mode is chosen. */
  readonly returned?: { readonly onChosen: (mode: ImportMode) => void };
}) {
  if (returned !== undefined) return <ReturnedChoice step={step} onChosen={returned.onChosen} />;
  return <FirstChoice step={step} />;
}

function FirstChoice({ step }: { readonly step: StepHost }) {
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
