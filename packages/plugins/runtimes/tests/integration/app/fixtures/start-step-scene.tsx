/**
 * The browser entry for the first-run Start page (r11 O14): the REAL "Start fresh / Copy from another machine" step body,
 * drawn inside the real StepPageFrame the way the setup flow draws it, over one fake machine that answers from memory.
 * No daemon, no network. Every name is made up.
 *
 *   ?view=page   the page as the flow draws it (Start fresh chosen on arrival)
 *   ?theme=<family>-<mode>
 *
 * Every call the page makes is recorded on `window.__calls` (the route key), and the footer's Next counts a press on
 * `window.__nextPresses`, so a test can prove "choosing a card writes nothing, and Next writes nothing either".
 */

import { StepPageFrame } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent } from 'react';
import { createRoot } from 'react-dom/client';
import { createStartStep } from '../../../../app/views/setup-transfer.tsx';
import { type Call, READS, scripted } from '../../../unit/app/features/fleet/account-support.ts';

declare global {
  interface Window {
    __calls: string[];
    __hostCalls: string[];
    __nextPresses: number;
  }
}

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
window.__hostCalls = [];
window.__nextPresses = 0;

const calls: Call[] = [];
const client = scripted(READS(), calls);
// The page's calls are read live: `calls` is the scripted client's own log.
Object.defineProperty(window, '__calls', { get: () => calls.map(call => call.route) });

const told = (what: string) => () => void window.__hostCalls.push(what);
const host: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment: {},
  remember: () => undefined,
  ready: told('ready'),
  skip: told('skip'),
  notNeeded: told('notNeeded'),
  done: told('done'),
  busy: told('busy'),
  commit: told('commit'),
  next: told('next'),
  back: told('back'),
};

const pressNext = (): void => {
  window.__nextPresses = window.__nextPresses + 1;
};

const Start = createStartStep(client) as unknown as FunctionComponent<PanelProps>;

createRoot(document.getElementById('root') as HTMLElement).render(
  // The shell draws the frame around a step's body; this fixture stands in for it.
  <div style={{ height: '100vh', overflow: 'auto' }}>
    <StepPageFrame
      title="Start from"
      back={{ onClick: () => undefined }}
      later={{ onClick: () => undefined }}
      next={{ label: 'Next', onClick: pressNext }}
    >
      {createElement(Start, { step: host })}
    </StepPageFrame>
  </div>,
);
requestAnimationFrame(() => {
  document.body.dataset.scene = 'ready';
});
