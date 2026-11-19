/**
 * "What to bring over" — the pre-screen of the import. Three cards: everything, choose, start fresh. The choice is
 * written to the segment (`importMode`), which the import pages (O7b) read to skip themselves: "everything" skips the
 * one-by-one pages and lets the final page do the lot, "fresh" skips them all. Nothing is read or written here.
 */
import { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import { ChoiceCards, type ChoiceOption, type StepPageProps } from './kit.tsx';

export type ImportMode = 'everything' | 'choose' | 'fresh';

const modeOf = (value: unknown): ImportMode =>
  value === 'choose' || value === 'fresh' || value === 'everything' ? value : 'everything';

const OPTIONS: readonly ChoiceOption<ImportMode>[] = [
  {
    id: 'everything',
    title: 'Import everything',
    line: 'Settings, models, CLAUDE.md, skills and MCP servers, in one go.',
  },
  {
    id: 'choose',
    title: 'Choose what to import',
    line: 'Go through them one at a time and leave out what you do not want.',
  },
  { id: 'fresh', title: 'Start fresh', line: 'Bring nothing over. You can import later from Settings.' },
];

export function ImportChoicePage({ step }: StepPageProps<ClaudeCodeClient>) {
  const [mode, setMode] = useState<ImportMode>(modeOf(step?.segment['importMode']));

  const started = useRef(false);
  useEffect(() => {
    if (started.current || step === undefined) return;
    started.current = true;
    // Written at once, so a person who just presses Next has chosen the pre-selected card.
    step.remember({ importMode: mode });
    step.ready();
  }, [step, mode]);

  const pick = (next: ImportMode): void => {
    setMode(next);
    step?.remember({ importMode: next });
    step?.done();
  };

  return (
    <div className="cc-step" data-onboarding-step="claude-code.import-choice">
      <p className="cc-step__line">
        Claude Code on your computer already has settings, a CLAUDE.md, skills and MCP servers. Bring them to this
        machine? Hooks are never imported.
      </p>
      <ChoiceCards legend="What to bring over" name="import-mode" options={OPTIONS} value={mode} onChange={pick} />
    </div>
  );
}
