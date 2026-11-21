/**
 * The Claude segment's step pages as the shell's step slot draws them (r11-1b G5): the REAL app half's panels
 * (`app/index.ts`, every view module loaded the way the shell loads it), all of them in ONE `<Suspense>` boundary, each
 * drawing only for its own `claude-code.<step>` subject — the shape of `views.tsx`'s slot. A fake daemon answers at once.
 *
 * `window.__walk(subject)` moves the slot to another step and resolves with what the move cost: the ms from the move to
 * that page's first painted frame, and whether the boundary's fallback (the shell's top bar) was drawn on the way.
 * React holds a freshly shown fallback for at least 300 ms, so a page that suspends on its own draw costs that much
 * however fast its module and its reads are.
 *
 * A page counts as drawn only when ITS OWN panel has content (a page that renders nothing never does), so the timing
 * cannot pass on a page that drew nothing. `?flaky` swaps the real half for the same pages over a loader whose FIRST
 * load fails (a dropped chunk request), each page inside its own error boundary like the shell's, and
 * `window.__loads` counts the loads started.
 */
import type { StepHost } from '@ferretry/kernel/contract';
import { Component, type ReactNode, Suspense, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import claudeCode from '../../../../app/index.ts';
import { onboardingPanels } from '../../../../app/onboarding-panels.ts';
import { importRoutes, scanOf } from '../../../fixtures/onboarding/scan.ts';

const FILE = 'binary: /fake/bin/claude\npermissionMode: skip\nhostHistory: true\n';
const table: Record<string, () => unknown> = {
  'GET /v1/claude-code/update': () => ({ location: { state: 'found', path: '/fake/bin/claude' } }),
  'GET /v1/config/file': () => ({
    path: 'harness-claude-code.yaml',
    text: FILE,
    etag: 'e1',
    exists: true,
    state: 'ok',
  }),
};
for (const [route, answer] of Object.entries(importRoutes(scanOf())))
  table[route] = typeof answer === 'function' ? (answer as () => unknown) : () => answer;
const client = {
  call: async (route: string) => {
    const answer = table[route];
    if (answer === undefined) throw new Error(`no route ${route}`);
    return answer();
  },
  subscribe: () => () => undefined,
} as never;

const step: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment: { importMode: 'choose' },
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
  commit: () => undefined,
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
} as never;

const flaky = new URLSearchParams(window.location.search).has('flaky');
(window as unknown as { __loads: number }).__loads = 0;
const built = (flaky
  ? {
      panels: onboardingPanels(async () => {
        (window as unknown as { __loads: number }).__loads += 1;
        if ((window as unknown as { __loads: number }).__loads === 1) throw new Error('chunk request dropped (503)');
        return await import('../../../../app/views/onboarding-pages.tsx');
      }, client as never),
    }
  : claudeCode.build?.({ client } as never)) as unknown as {
  panels: Record<string, (props: Record<string, unknown>) => unknown>;
};
const panels = Object.entries(built.panels).filter(([id]) => id.startsWith('onboarding-'));

function Panel({ draw, subject }: { draw: (props: Record<string, unknown>) => unknown; subject: string }) {
  return draw({ subject, step }) as never;
}

/** The shell's per-page error boundary: a failed page is contained and marked, nothing else is touched. */
class Contain extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <span data-page-error="">This page failed</span> : this.props.children;
  }
}

function Fallback() {
  (window as unknown as { __fallbacks: number }).__fallbacks += 1;
  return <span data-suspense-fallback="">Loading…</span>;
}
(window as unknown as { __fallbacks: number }).__fallbacks = 0;

let move: (subject: string) => void = () => undefined;
function Slot() {
  const [subject, setSubject] = useState('claude-code.import-choice');
  move = setSubject;
  return (
    <Suspense fallback={<Fallback />}>
      {panels.map(([id, draw]) => (
        <div key={id} data-panel={id}>
          <Contain>
            <Panel draw={draw} subject={subject} />
          </Contain>
        </div>
      ))}
      <span data-subject={subject} />
    </Suspense>
  );
}

/** The panel a subject draws into: `claude-code.<step>` is the plugin's `onboarding-<step>` panel. */
const panelOf = (subject: string): Element | null =>
  document.querySelector(`[data-panel="onboarding-${subject.slice('claude-code.'.length)}"]`);

/** The page's own body: a child of its panel that is not the error boundary's marker (a failed page has no body). */
const hasBody = (subject: string): boolean =>
  panelOf(subject)?.querySelector(':scope > :not([data-page-error])') != null;

/** A page is on screen once the boundary committed its subject, shows no fallback, and ITS OWN panel has a body. */
const shown = (subject: string): boolean =>
  document.querySelector(`[data-subject="${subject}"]`) !== null &&
  document.querySelector('[data-suspense-fallback]') === null &&
  hasBody(subject);
(window as unknown as { __shown: (subject: string) => boolean }).__shown = shown;

(window as unknown as { __walk: (subject: string) => Promise<unknown> }).__walk = subject =>
  new Promise(resolve => {
    const before = (window as unknown as { __fallbacks: number }).__fallbacks;
    const start = performance.now();
    flushSync(() => move(subject));
    const tick = (): void => {
      const failed = panelOf(subject)?.querySelector('[data-page-error]') != null;
      const gaveUp = performance.now() - start > 3_000;
      if (shown(subject) || failed || gaveUp) {
        resolve({
          subject,
          ms: Math.round(performance.now() - start),
          fallback: (window as unknown as { __fallbacks: number }).__fallbacks > before,
          drawn: shown(subject),
          failed,
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Slot />);
