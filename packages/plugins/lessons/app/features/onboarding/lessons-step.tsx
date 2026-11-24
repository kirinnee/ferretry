/**
 * FIRST RUN › THIS MACHINE › "Learn rules from your ferrets?" — one daemon step, two stacked cards, the demo on the right.
 *
 * This is the step's BODY only: the shell wraps it in the step frame (title from the manifest, progress, Back / Next,
 * Later, the loading cover), so the page draws no title or footer of its own and talks to the footer through the host.
 *
 * It answers one setting: `lessons.yaml`'s `passiveDefault`, whether NEW ferrets are told to file a lesson when you
 * correct them (Settings › Lessons has the same switch; nothing else changes here, and a running ferret keeps its own
 * switch). Every lesson still waits for the person's own verdict before anything is written.
 *
 *   - The page reads the machine's current setting first, then lifts the shell's loading cover (`ready()`), so there is
 *     one draw and no pop-in. A read that fails still lifts the cover and says why, with a way to try again.
 *   - Neither card is chosen on arrival, even though the machine already has a default: the person answers.
 *   - A pick only REGISTERS the write (`host.commit`, contract rule 8): nothing is written by a click or an arrow key. The
 *     footer's Next runs it under its own "Saving…" and records the step when the daemon accepted it; a refusal is said in
 *     the footer line by the shell and Next stays ready to try again. The page has no Save / Use / Keep button.
 *   - While that write is in flight the cards are locked: the footer already captured the pick it is saving, so a later
 *     click would change the card and the picture but not what is written. A refusal unlocks them again.
 *   - The picture on the right (`StepDemo`) follows the card on screen: a rule filed on the Lessons shelf, or nothing filed;
 *     before a pick it says nothing is chosen yet.
 *   - Next with neither card picked answers nothing, so the page says it is unfinished (`remember({ unfinished: true })`, read
 *     by the closing page, which then leaves Lessons for later instead of ticking it); a pick says it is not.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChoiceCards, StepDemo } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { fetchLessonsConfig, type LessonsConnection, lessonsErrorMessage, patchLessonsConfig } from '../../src/api.ts';
import { LessonDemo } from './lessons-step-demo.tsx';
import './lessons-step.css';

const LESSONS_STEP_LINE = 'Rules are kept in Lessons, where you read each one before it is used.';

type Answer = 'on' | 'off';

export interface LessonsStepProps {
  readonly connection: LessonsConnection;
  /** The host the setup flow gave the page; absent when the page is drawn by itself. */
  readonly step?: StepHost | undefined;
}

export function LessonsStep({ connection, step }: LessonsStepProps) {
  const [read, setRead] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // True from the moment Next starts the write until the daemon answers: the pick the footer captured is the one saved.
  const [saving, setSaving] = useState(false);
  // The loading cover lifts once, however many times the read is retried.
  const lifted = useRef(false);
  // The host is read through a ref, so a shell that hands a new host object each render never re-reads the setting.
  const host = useRef(step);
  host.current = step;

  // The machine's current setting is read before the page shows, then the loading cover lifts, whatever the answer was.
  const load = useCallback(() => {
    const lift = () => {
      if (lifted.current) return;
      lifted.current = true;
      host.current?.ready();
    };
    fetchLessonsConfig(connection).then(
      () => {
        setRead(true);
        setProblem(null);
        // Nothing is picked yet: moving on now would answer nothing (the closing page reads this, see the header).
        host.current?.remember({ unfinished: true });
        lift();
      },
      (reason: unknown) => {
        setProblem(lessonsErrorMessage(reason));
        lift();
      },
    );
  }, [connection]);
  useEffect(load, [load]);

  // A pick registers what Next writes; it never writes by itself.
  const choose = useCallback(
    (next: string) => {
      const chosen: Answer = next === 'on' ? 'on' : 'off';
      setAnswer(chosen);
      host.current?.remember({ unfinished: false });
      host.current?.commit(async () => {
        setSaving(true);
        try {
          await patchLessonsConfig(connection, { passiveDefault: chosen === 'on' });
        } catch (reason: unknown) {
          throw new Error(lessonsErrorMessage(reason));
        } finally {
          setSaving(false);
        }
      });
    },
    [connection],
  );

  return (
    <div className="fy-lessons-step" data-lessons-step="">
      {read ? (
        <ChoiceCards
          label="Learn from my corrections"
          layout="stack"
          value={answer}
          onChange={choose}
          disabled={saving}
          options={[
            { id: 'on', title: 'Learn', line: 'Corrections become rules.' },
            { id: 'off', title: 'Don’t learn', line: 'No rules. Change it in Settings.' },
          ]}
        />
      ) : null}
      <p className="fy-lessons-step-line">{LESSONS_STEP_LINE}</p>
      {read ? (
        <StepDemo>
          <LessonDemo kept={answer === null ? null : answer === 'on'} />
        </StepDemo>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="fy-lessons-step-problem" data-lessons-problem="">
          {problem}
        </p>
      )}
      {read || problem === null ? null : (
        <div>
          <button type="button" className="fy-lessons-step-retry" onClick={load}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
