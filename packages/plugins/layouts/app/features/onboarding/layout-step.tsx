/**
 * THE LAYOUT STEP (r11 O11): first run's client page about how this device is arranged: how the places at the side bar's foot
 * are drawn (icons or words) and how close the rows sit (comfortable or compact). Two short stacked lists on the left and ONE
 * picture on the right (`StepDemo`) that shows both answers and moves once when one is picked.
 *
 * It writes THIS device only, through the shell's `DeviceLayout.set` (`fy:app:layout`), and only when the footer's Next is
 * pressed: a pick registers what Next must save (`host.commit`, contract rule 8) and writes nothing by itself, so there is no
 * Save button and no per-pick `done()` (the shell records the step when the save was accepted). A pick back to the answer the
 * device already shows clears the write. A refusal is thrown to the shell, which says it in the footer and keeps Next ready.
 * The setup flow draws the title, the footer and the loading cover. Outside a shell there is no device to write to, so the
 * page skips as `not-needed` and draws nothing. Its memory is the saved device layout itself: nothing is kept in step memory
 * or in any storage by this page.
 *
 * The bottom bar is not offered here: owner answer C2 keeps it a switch in Settings › Layout only.
 */
import { ChoiceCards, type DeviceLayout, StepDemo, type Viewport } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { useEffect, useRef, useState } from 'react';
import { LayoutDemo, type LayoutDemoProps } from './layout-step-demos.tsx';
import { answerOf, keysFor, LAYOUT_QUESTIONS, type LayoutQuestion } from './layout-step-model.ts';
import './layout-step.css';

export interface LayoutStepProps {
  readonly step: StepHost | undefined;
  /** This device's layout choice; absent outside the shell. */
  readonly device: DeviceLayout | undefined;
  /** Which width the shell draws this device for; absent outside the shell. */
  readonly viewport: Viewport | undefined;
}

type Picks = Readonly<Partial<Record<LayoutQuestion['id'], string>>>;

export function LayoutStep({ step, device, viewport }: LayoutStepProps) {
  const [picks, setPicks] = useState<Picks>({});
  const [moved, setMoved] = useState<LayoutDemoProps['moved']>(undefined);
  // True from the moment Next starts the write until it answers: the picks the footer captured are the ones written.
  const [saving, setSaving] = useState(false);
  // The host and the device are read through refs: a shell that hands new objects each render never re-runs the page.
  const host = useRef(step);
  host.current = step;
  const live = useRef({ device, viewport });
  live.current = { device, viewport };
  const absent = device === undefined || viewport === undefined;
  useEffect(() => {
    if (absent) host.current?.skip('not-needed');
    else host.current?.ready();
  }, [absent]);
  if (device === undefined || viewport === undefined) return null;

  const shown = (question: LayoutQuestion): string =>
    picks[question.id] ?? answerOf(device.inForce, question, viewport);

  const choose = (question: LayoutQuestion, answer: string): void => {
    // A pick equal to what the device already shows is no pick at all.
    const next: Record<string, string> = { ...picks, [question.id]: answer };
    if (answer === answerOf(device.inForce, question, viewport)) delete next[question.id];
    setPicks(next);
    setMoved({ question: question.id, count: (moved?.count ?? 0) + 1 });
    const changed = LAYOUT_QUESTIONS.filter(entry => next[entry.id] !== undefined);
    if (changed.length === 0) {
      host.current?.commit(null);
      return;
    }
    host.current?.commit(async () => {
      setSaving(true);
      try {
        for (const entry of changed)
          for (const path of keysFor(live.current.device?.inForce ?? device.inForce, entry)) {
            const refused = (live.current.device ?? device).set(path, next[entry.id] as string);
            if (refused !== undefined) throw new Error(refused);
          }
      } finally {
        setSaving(false);
      }
    });
  };

  const [navQuestion, densityQuestion] = LAYOUT_QUESTIONS;
  return (
    <div className="fy-lstep" data-layout-step="">
      {LAYOUT_QUESTIONS.map(question => (
        <section key={question.id} className="fy-lstep__row" aria-labelledby={`fy-lstep-${question.id}`}>
          <h2 id={`fy-lstep-${question.id}`} className="fy-lstep__name">
            {question.name}
          </h2>
          <ChoiceCards
            label={question.name}
            layout="stack"
            value={shown(question)}
            onChange={answer => choose(question, answer)}
            disabled={saving}
            options={question.answers.map(answer => ({ id: answer.id, title: answer.title, line: answer.line }))}
          />
        </section>
      ))}
      <p className="fy-lstep__note">This device only.</p>
      <StepDemo>
        <LayoutDemo
          labels={shown(navQuestion as LayoutQuestion)}
          density={shown(densityQuestion as LayoutQuestion)}
          moved={moved}
        />
      </StepDemo>
    </div>
  );
}
