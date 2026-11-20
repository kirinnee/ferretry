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
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

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
  next: () => undefined,
  back: () => undefined,
};

const check = async (): Promise<NixCheck> => {
  if (params.get('case') === 'unreadable') throw new Error('offline');
  return {
    kind: 'facts',
    facts: {
      present: false,
      consequence: 'Ferrets use the machine’s own tools until nix is installed.',
      remedy: 'Install nix from nixos.org, then open Settings › Shells to add a shell.',
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
