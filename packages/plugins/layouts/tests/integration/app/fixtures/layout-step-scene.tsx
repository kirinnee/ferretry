/**
 * The browser entry for the Layout step over FAKE data (no daemon): the REAL step page in the P1 page frame, with a
 * device that saves into memory through the real override rules.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 */
import {
  applyOverrides,
  DEFAULT_LAYOUT,
  type DeviceLayout,
  type LayoutOverrides,
  setDeviceOverride,
} from '@ferretry/app';
import { StepPageFrame } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutStep } from '../../../../app/features/onboarding/layout-step.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const host: StepHost = {
  phase: 'client',
  appliesTo: [],
  segment: {},
  remember: () => undefined,
  ready: () => undefined,
  skip: () => undefined,
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

function Scene() {
  const [overrides, setOverrides] = useState<LayoutOverrides>({});
  const latest = useRef<LayoutOverrides>(overrides);
  const device: DeviceLayout = {
    overrides,
    base: DEFAULT_LAYOUT,
    inForce: applyOverrides(DEFAULT_LAYOUT, overrides) ?? DEFAULT_LAYOUT,
    set: (path, value) => {
      const edited = setDeviceOverride(DEFAULT_LAYOUT, latest.current, path, value);
      if (!edited.ok) return edited.error;
      latest.current = edited.overrides;
      setOverrides(edited.overrides);
      return undefined;
    },
    reset: () => setOverrides({}),
  };
  return (
    <div className="mx-auto max-w-3xl p-4" data-scene-ready="">
      <StepPageFrame
        title="How should this device look?"
        line="Two quick choices. You can change both later."
        back={{}}
        next={{ label: 'Next' }}
        progress={{
          segments: [
            { id: 'machine', label: 'Machine' },
            { id: 'device', label: 'This device' },
          ],
          current: 'device',
          step: 1,
          of: 3,
        }}
      >
        <LayoutStep step={host} device={device} viewport="wide" />
      </StepPageFrame>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
