/**
 * THE LAYOUT STEP (O14): first run's client page about how this device is arranged: navigation Left / Bottom and
 * density Comfortable / Compact, each a short row of cards with a demo that plays once when it is picked.
 *
 * It writes THIS device only, through the shell's `DeviceLayout.set` (`fy:app:layout`), and tells its host `done()` after
 * each save so the device ledger knows the question was answered; the setup flow draws the title, the footer and the
 * loading cover. Outside a shell there is no device to write to, so it skips as `not-needed` and draws nothing. Its
 * memory is the saved device layout itself: nothing is kept in step memory or in any storage by this page.
 */
import { ChoiceCards, type DeviceLayout, type Viewport } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { useEffect, useState } from 'react';
import { DensityDemo, NavDemo } from './layout-step-demos.tsx';
import { answerOf, keysFor, LAYOUT_QUESTIONS, type LayoutQuestion } from './layout-step-model.ts';
import './layout-step.css';

export interface LayoutStepProps {
  readonly step: StepHost | undefined;
  /** This device's layout choice; absent outside the shell. */
  readonly device: DeviceLayout | undefined;
  /** Which width the shell draws this device for; absent outside the shell. */
  readonly viewport: Viewport | undefined;
}

const demoOf = (question: LayoutQuestion, answer: string) =>
  question.id === 'nav' ? <NavDemo side={answer} /> : <DensityDemo density={answer} />;

export function LayoutStep({ step, device, viewport }: LayoutStepProps) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const absent = device === undefined || viewport === undefined;
  useEffect(() => {
    if (absent) step?.skip('not-needed');
    else step?.ready();
  }, [absent, step]);
  if (device === undefined || viewport === undefined) return null;

  const choose = (question: LayoutQuestion, answer: string): void => {
    for (const path of keysFor(device.inForce, question)) {
      const refused = device.set(path, answer);
      if (refused !== undefined) {
        setProblem(refused);
        return;
      }
    }
    setProblem(undefined);
    step?.done();
  };

  return (
    <div className="fy-lstep" data-layout-step="">
      {LAYOUT_QUESTIONS.map(question => (
        <section key={question.id} className="fy-lstep__row" aria-labelledby={`fy-lstep-${question.id}`}>
          <h2 id={`fy-lstep-${question.id}`} className="fy-lstep__name">
            {question.name}
          </h2>
          <ChoiceCards
            label={question.name}
            value={answerOf(device.inForce, question, viewport)}
            onChange={answer => choose(question, answer)}
            options={question.answers.map(answer => ({
              id: answer.id,
              title: answer.title,
              line: answer.line,
              demo: demoOf(question, answer.id),
            }))}
          />
        </section>
      ))}
      {problem === undefined ? null : (
        <p role="alert" className="fy-lstep__problem">
          {problem}
        </p>
      )}
      <p className="fy-lstep__note">Just this device. Change it any time in Settings › Layout.</p>
    </div>
  );
}
