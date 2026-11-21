/**
 * THE NEXT PAGE, DRAWN IN ADVANCE WHERE NOBODY SEES IT (r11-1b G6, owner line 4).
 *
 * A step's page is a lazy panel: its first draw suspends, the slot's boundary puts up its fallback, and React then holds
 * that fallback for at least 300 ms before it lets the page in, however fast the module arrives. So the first move onto a
 * page whose module had not been used yet cost 400-1250 ms (Lessons to Appearance, Appearance to Layouts), with the shell's
 * top bar up, on a machine that answers in 1 ms.
 *
 * While the current page is on screen, this draws the pages AFTER it (the next two: one may pass itself over) inside a hidden `Activity`: React pre-renders hidden
 * content at low priority, which loads the lazy module (and settles the load the panel keeps), shows no fallback, and runs
 * no effect of the page, so nothing it would do on a real visit happens (no read, no `ready()`, no `notNeeded()`). When the
 * person moves on, the real page's first draw finds the module already loaded and draws at once.
 *
 * It is drawn into a DETACHED node (a portal into an element that is never attached), so nothing of it is in the document:
 * no query, focus walk, screen reader or style sees a second copy of a page.
 *
 * The host it is handed is inert: reading it is allowed (a page's first render may read `phase` or `segment`), every call
 * on it does nothing.
 */
import type { StepHost } from '@ferretry/kernel/contract';
import { Activity, type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FlowStep } from '../../lib/index.ts';

const nothing = (): void => undefined;

/** A host that answers every read and swallows every call: the page it is given is never the one the person is on. */
const inertHost = (step: FlowStep): StepHost => ({
  phase: step.phase,
  appliesTo: step.appliesTo,
  segment: {},
  remember: nothing,
  ready: nothing,
  skip: nothing,
  notNeeded: nothing,
  done: nothing,
  busy: nothing,
  commit: nothing,
  next: nothing,
  back: nothing,
});

export function NextPagePrefetch({
  steps,
  render,
}: {
  /** The pages the flow would show after this one, in order; none when this is the last. */
  readonly steps: readonly FlowStep[];
  readonly render: (host: StepHost, step: FlowStep) => ReactNode;
}): ReactNode {
  const [offstage] = useState(() => document.createElement('div'));
  return createPortal(
    steps.map(step => (
      <Activity key={step.key} mode="hidden">
        <div data-flow-prefetch={step.key}>{render(inertHost(step), step)}</div>
      </Activity>
    )),
    offstage,
  );
}
