import { describe, expect, it } from 'bun:test';
import { SpeedLine } from '../../../../src/features/settings/speed-line.tsx';
import { SpeedMemoryStore } from '../../../../src/lib/stt/speed-memory.ts';
import { NO_SIGNALS } from '../../../../src/lib/stt/speed-plan.ts';
import { flatSpeedPlanner, SpeedPlanner } from '../../../../src/lib/stt/speed-planner.ts';
import { mount } from '../../../support/dom.ts';

const ISOLATED = { ...NO_SIGNALS, crossOriginIsolated: true, hardwareConcurrency: 8, deviceMemoryGb: 8 };

describe('<SpeedLine>', () => {
  it('says which path the chosen engine runs on, and why, as plain read-only text', async () => {
    const view = await mount(<SpeedLine engine="parakeet" planner={flatSpeedPlanner()} />);
    const section = view.container.querySelector('section[aria-label="Speed"]');
    expect(section?.textContent).toContain('Using: single-thread WebAssembly');
    expect(section?.textContent).toContain('More threads need a browser feature this page does not turn on.');
    expect(view.container.querySelector('button, input, [role="switch"]')).toBeNull();
  });

  it('says multi-thread when the device is isolated and the engine can use threads', async () => {
    const planner = new SpeedPlanner({ signals: ISOLATED, memory: new SpeedMemoryStore(null), now: () => 1 });
    const view = await mount(<SpeedLine engine="whisper-base-en" planner={planner} />);
    expect(view.container.textContent).toContain('Using: multi-thread WebAssembly');
    expect(view.container.textContent).toContain('The fastest option this device offers.');
  });

  it('says why an engine stays on one thread when it has nothing faster', async () => {
    const planner = new SpeedPlanner({ signals: ISOLATED, memory: new SpeedMemoryStore(null), now: () => 1 });
    const view = await mount(<SpeedLine engine="vosk-small-en" planner={planner} />);
    expect(view.container.textContent).toContain('Using: single-thread WebAssembly');
    expect(view.container.textContent).toContain('This engine runs on one thread.');
  });

  it('says a failed path is skipped, after one failed', async () => {
    const planner = new SpeedPlanner({ signals: ISOLATED, memory: new SpeedMemoryStore(null), now: () => 1 });
    planner.threadsFailed('parakeet');
    const view = await mount(<SpeedLine engine="parakeet" planner={planner} />);
    expect(view.container.textContent).toContain('A faster option failed on this device, so it is skipped for now.');
  });

  it('draws nothing for Browser voice or an engine it does not know', async () => {
    for (const engine of ['browser', 'nothing-like-it']) {
      const view = await mount(<SpeedLine engine={engine} planner={flatSpeedPlanner()} />);
      expect(view.container.querySelector('section')).toBeNull();
    }
  });
});

describe('<SpeedLine> inside Settings', () => {
  it('is on the Voice settings page beside the engine list, for the engine in use', async () => {
    const { DictationSettings } = await import('../../../../src/features/settings/dictation-settings.tsx');
    const { DEFAULT_STT_SETTINGS } = await import('../../../../src/lib/stt/stt-settings.ts');
    const { AVAILABLE_RECOGNITION } = await import('../../../support/browser-recognition.ts');
    const view = await mount(
      <DictationSettings
        settings={{ ...DEFAULT_STT_SETTINGS, enabled: true, engine: 'parakeet-tdt-110m' }}
        update={() => undefined}
        persisted
        recognitionSupport={AVAILABLE_RECOGNITION}
        speedPlanner={flatSpeedPlanner()}
      />,
    );
    expect(view.container.querySelector('section[aria-label="Speed"]')?.textContent).toContain(
      'Using: single-thread WebAssembly',
    );
  });
});
