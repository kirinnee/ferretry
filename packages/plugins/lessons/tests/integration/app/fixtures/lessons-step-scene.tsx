/**
 * The browser entry for the first-run Lessons page (r11 O8), over a fake daemon: every answer is a fixed fake. No network.
 *
 *   ?view=page    the page as the setup flow draws it, inside the real StepPageFrame (neither card chosen)
 *   ?theme=<family>-<mode>
 *
 * The frame's Next runs the page's registered `commit` the way the shell does, and counts every PATCH on
 * `window.__patches`, so a test can prove "Next writes once".
 */

import { createRoot } from 'react-dom/client';
import { StepPageFrame } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { LessonsStep } from '../../../../app/features/onboarding/lessons-step.tsx';
import type { LessonsConnection } from '../../../../app/src/api.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

declare global {
  interface Window {
    __patches: unknown[];
  }
}
window.__patches = [];

const connection: LessonsConnection = {
  key: 'fake',
  client: {
    call: async <Value,>(route: string, init: { readonly body?: unknown } = {}): Promise<Value> => {
      if (route === 'PATCH /v1/lessons/config') window.__patches.push(init.body);
      return {
        enabled: true,
        agent: 'claude-default',
        intervalMinutes: 60,
        batchSize: 10,
        maxMinersPerRun: 2,
        maxFerretsPerRun: 20,
        minSpawnGapMinutes: 5,
        passiveDefault: true,
      } as Value;
    },
  },
};

let save: (() => Promise<void>) | null = null;
const host: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment: {},
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
  done: () => undefined,
  busy: () => undefined,
  commit: next => {
    save = next;
  },
  next: () => undefined,
  back: () => undefined,
};

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(
  // The shell draws the frame around a step's body; this fixture stands in for it.
  <div style={{ height: '100vh', overflow: 'auto' }}>
    <StepPageFrame
      title="Lessons"
      back={{ onClick: () => undefined }}
      later={{ onClick: () => undefined }}
      next={{ label: 'Next', onClick: () => void save?.() }}
    >
      <LessonsStep connection={connection} step={host} />
    </StepPageFrame>
  </div>,
);
requestAnimationFrame(() => {
  document.body.dataset.scene = 'ready';
});
