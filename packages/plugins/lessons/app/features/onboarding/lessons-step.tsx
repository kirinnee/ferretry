/**
 * FIRST RUN › THIS MACHINE › "Learn rules from your ferrets?" — one daemon step, two cards.
 *
 * It answers one setting: `lessons.yaml`'s `passiveDefault`, whether NEW ferrets are told to file a lesson when you
 * correct them (Settings › Lessons has the same switch; nothing else changes here, and a running ferret keeps its own
 * switch). Every lesson still waits for the person's own verdict before anything is written.
 *
 *   - The page reads the machine's current setting first, then lifts the shell's loading cover (`ready()`), so there is
 *     one draw and no pop-in. A read that fails still lifts the cover and says why, with a way to try again.
 *   - Neither card is chosen on arrival, even though the machine already has a default: the person answers, and only an
 *     answer records the step (`done()`).
 *   - A choice writes `passiveDefault` at once. Next waits while it saves (`busy`); a refusal is said in a sentence and
 *     the card goes back to what it was, and the step is NOT recorded as answered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChoiceCards } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import type { LessonsConfig } from '../../../contract/index.ts';
import { fetchLessonsConfig, type LessonsConnection, lessonsErrorMessage, patchLessonsConfig } from '../../src/api.ts';
import { LessonDemo } from './lessons-step-demo.tsx';
import './lessons-step.css';

export const LESSONS_STEP_TITLE = 'Learn rules from your ferrets?';
const LESSONS_STEP_LINE =
  'When you correct a ferret, Ferretry can keep the correction as a rule for every ferret after. You read each rule and decide before it is used.';

type Answer = 'on' | 'off';

export interface LessonsStepProps {
  readonly connection: LessonsConnection;
  /** The host the setup flow gave the page; absent when the page is drawn by itself. */
  readonly step?: StepHost | undefined;
}

export function LessonsStep({ connection, step }: LessonsStepProps) {
  const [config, setConfig] = useState<LessonsConfig | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [held, setHeld] = useState<readonly string[]>([]);
  // The host is read through a ref, so a shell that hands a new host object each render never re-reads the setting.
  const host = useRef(step);
  host.current = step;

  // The machine's current setting is read before the page shows, then the loading cover lifts, whatever the answer was.
  const load = useCallback(() => {
    fetchLessonsConfig(connection).then(
      next => {
        setConfig(next);
        setProblem(null);
        host.current?.ready();
      },
      (reason: unknown) => {
        setProblem(lessonsErrorMessage(reason));
        host.current?.ready();
      },
    );
  }, [connection]);
  useEffect(load, [load]);

  const choose = useCallback(
    (next: string) => {
      const before = answer;
      const chosen: Answer = next === 'on' ? 'on' : 'off';
      setAnswer(chosen);
      setProblem(null);
      setHeld([]);
      host.current?.busy('Saving…');
      patchLessonsConfig(connection, { passiveDefault: chosen === 'on' }).then(
        ({ held: waiting = [], ...inEffect }) => {
          host.current?.busy(null);
          setConfig(inEffect);
          setHeld(waiting);
          host.current?.done();
        },
        (reason: unknown) => {
          host.current?.busy(null);
          setAnswer(before);
          setProblem(lessonsErrorMessage(reason));
        },
      );
    },
    [answer, connection],
  );

  const unread = config === null;
  return (
    <section className="fy-lessons-step" aria-labelledby="fy-lessons-step-title" data-lessons-step="">
      <h2 id="fy-lessons-step-title" className="fy-lessons-step-title">
        {LESSONS_STEP_TITLE}
      </h2>
      <p className="fy-lessons-step-line">{LESSONS_STEP_LINE}</p>
      {unread ? null : (
        <ChoiceCards
          label="Learn from my corrections"
          value={answer}
          onChange={choose}
          options={[
            {
              id: 'on',
              title: 'Learn',
              line: 'New ferrets are told to file a rule when you correct them.',
              demo: <LessonDemo kept />,
            },
            {
              id: 'off',
              title: 'Don’t learn',
              line: 'No rules are filed. You can switch it on later in Settings › Lessons.',
              demo: <LessonDemo kept={false} />,
            },
          ]}
        />
      )}
      {unread || answer !== null ? null : (
        <p className="fy-lessons-step-note" data-lessons-now="">
          Right now: {config.passiveDefault ? 'on' : 'off'} for new ferrets.
        </p>
      )}
      {held.map(sentence => (
        <p key={sentence} role="status" className="fy-lessons-step-note" data-lessons-held="">
          Waiting for your approval: {sentence}
        </p>
      ))}
      {problem === null ? null : (
        <p role="alert" className="fy-lessons-step-problem" data-lessons-problem="">
          {problem}
        </p>
      )}
      {unread && problem !== null ? (
        <div>
          <button type="button" className="fy-lessons-step-retry" onClick={load}>
            Try again
          </button>
        </div>
      ) : null}
    </section>
  );
}
