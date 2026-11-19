/**
 * "What to bring over" — the pre-screen of the import. Three cards: everything, choose, start fresh. The choice is
 * written to the segment (`importMode`), which the import pages (O7b) read to skip themselves: "everything" skips the
 * one-by-one pages and lets the final page do the lot, "fresh" skips them all. Nothing is read or written here.
 *
 * THE SEGMENT IS MEMORY OF THIS RUN ONLY (O1: never stored). After a reload mid-segment the shell resumes at the first
 * unanswered step, this one is already answered, and the memory is empty. So a MISSING `importMode` means "the person has
 * not chosen in this run", never "everything": see {@link importModeOf}, which every import page must use.
 */
import { ChoiceCards, type ChoiceOption } from '@ferretry/app';
import type { StepSegmentMemory } from '@ferretry/kernel/contract';
import { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import type { StepPageProps } from './props.ts';

export type ImportMode = 'everything' | 'choose' | 'fresh';

const isMode = (value: unknown): value is ImportMode =>
  value === 'choose' || value === 'fresh' || value === 'everything';

/**
 * The choice this run holds, or `undefined` when it holds none (a reload, or the step was never shown). An import page
 * treats `undefined` as "ask again": it is NOT skippable for the person's choice (never `everything`, never `fresh`).
 * It shows its own checklist, and the final page imports only what the person ticked.
 */
export const importModeOf = (segment: StepSegmentMemory): ImportMode | undefined => {
  const { importMode: value } = segment;
  return isMode(value) ? value : undefined;
};

const OPTIONS: readonly ChoiceOption[] = [
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
  const [mode, setMode] = useState<ImportMode>(importModeOf(step?.segment ?? {}) ?? 'everything');

  const started = useRef(false);
  useEffect(() => {
    if (started.current || step === undefined) return;
    started.current = true;
    // Written at once, so a person who just presses Next has chosen the pre-selected card.
    step.remember({ importMode: mode });
    step.ready();
  }, [step, mode]);

  const pick = (next: string): void => {
    if (!isMode(next)) return;
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
      <ChoiceCards label="What to bring over" options={OPTIONS} value={mode} onChange={pick} />
    </div>
  );
}
