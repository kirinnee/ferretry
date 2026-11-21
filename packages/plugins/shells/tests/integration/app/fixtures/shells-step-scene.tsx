/**
 * The browser entry for the Shells onboarding step (r10 O13), over fake data: the REAL `ShellsStep` body inside the shell's
 * frame. The frame (`StepPageFrame`: title, progress, Back, Next, Later) is the SHELL's, so it is wrapped here, in this
 * fixture only; the page never draws it.
 *
 *   ?theme=<family>-<mode>   ?case=missing (default) | unreadable
 */
import { StepPageFrame } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { createRoot } from 'react-dom/client';
import { ShellsStep } from '../../../../app/features/onboarding/shells-step.tsx';
import type { NixCheck } from '../../../../app/features/onboarding/shells-step-model.ts';

const params = new URLSearchParams(window.location.search);
// The look is three root axes (`data-style`, `data-palette`, `data-mode`), not `data-theme` alone: the dark palette
// selectors read `[data-palette=studio][data-mode=dark]`, so a fixture that sets only `data-theme` would draw light.
const theme = params.get('theme') ?? 'studio-light';
const cut = theme.lastIndexOf('-');
const root = document.documentElement;
root.dataset.theme = theme;
root.dataset.style = 'studio';
root.dataset.palette = theme.slice(0, cut);
root.dataset.mode = theme.slice(cut + 1);

declare global {
  interface Window {
    /** Every call the page made on its host that would save something: a `commit` registered, a `done`. */
    __writes: string[];
  }
}
window.__writes = [];

const host: StepHost = {
  phase: 'daemon',
  appliesTo: [],
  segment: {},
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
  commit: save => void (save !== null && window.__writes.push('commit')),
  done: () => void window.__writes.push('done'),
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

const check = async (): Promise<NixCheck> => {
  if (params.get('case') === 'unreadable') throw new Error('offline');
  return {
    kind: 'facts',
    facts: {
      present: false,
      consequence: 'ferrets use the tools already on this machine',
      remedy: 'install nix to give each ferret its own shell',
    },
  };
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StepPageFrame
    title="Shells"
    progress={{
      segments: [
        { id: 'machine', label: 'Machine' },
        { id: 'shells', label: 'Shells' },
        { id: 'device', label: 'This device' },
      ],
      current: 'shells',
      step: 2,
      of: 3,
    }}
    back={{ onClick: () => undefined }}
    next={{ label: 'Next', onClick: () => undefined }}
  >
    <ShellsStep step={host} check={check} />
  </StepPageFrame>,
);
