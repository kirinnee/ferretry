import { describe, expect, it } from 'bun:test';
import { SpeedLine } from '../../../../../app/features/settings/speed-line.tsx';
import { SpeedMemoryStore } from '../../../../../app/lib/stt/speed-memory.ts';
import { NO_SIGNALS } from '../../../../../app/lib/stt/speed-plan.ts';
import { flatSpeedPlanner, SpeedPlanner } from '../../../../../app/lib/stt/speed-planner.ts';
import { mount } from '../../../../support/app/dom.ts';

const ISOLATED = { ...NO_SIGNALS, crossOriginIsolated: true, hardwareConcurrency: 8, deviceMemoryGb: 8 };

describe('<SpeedLine>', () => {
  it('says how fast the chosen engine runs, what that means, and why, as plain read-only text', async () => {
    const view = await mount(<SpeedLine engine="parakeet" planner={flatSpeedPlanner()} />);
    const section = view.container.querySelector('section[aria-label="Speed"]');
    expect(section?.textContent).toContain('Speech speed: standard (one core)');
    expect(section?.textContent).toContain('Your words appear a moment after you stop talking.');
    expect(section?.textContent).toContain('A faster mode (several cores) is not available on this site yet');
    expect(view.container.querySelector('button, input, [role="switch"]')).toBeNull();
  });

  it('says fast when the device is isolated and the engine can use threads', async () => {
    const planner = new SpeedPlanner({ signals: ISOLATED, memory: new SpeedMemoryStore(null), now: () => 1 });
    const view = await mount(<SpeedLine engine="whisper-base-en" planner={planner} />);
    expect(view.container.textContent).toContain('Speech speed: fast (several cores)');
    expect(view.container.textContent).toContain('about 2–3 times faster than standard');
    expect(view.container.textContent).toContain('This is the fastest mode this device offers.');
  });

  it('says why an engine stays on one thread when it has nothing faster', async () => {
    const planner = new SpeedPlanner({ signals: ISOLATED, memory: new SpeedMemoryStore(null), now: () => 1 });
    const view = await mount(<SpeedLine engine="vosk-small-en" planner={planner} />);
    expect(view.container.textContent).toContain('Speech speed: standard (one core)');
    expect(view.container.textContent).toContain('This voice has no faster mode.');
  });

  it('says a failed path is skipped, after one failed', async () => {
    const planner = new SpeedPlanner({ signals: ISOLATED, memory: new SpeedMemoryStore(null), now: () => 1 });
    planner.threadsFailed('parakeet');
    const view = await mount(<SpeedLine engine="parakeet" planner={planner} />);
    expect(view.container.textContent).toContain('Speech speed: standard (one core)');
    expect(view.container.textContent).toContain(
      'A faster mode (several cores) is available on this device but turned off for now, because it did not work here last time.',
    );
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
    const { DictationSettings } = await import('../../../../../app/features/settings/dictation-settings.tsx');
    const { DEFAULT_STT_SETTINGS } = await import('../../../../../app/lib/stt/stt-settings.ts');
    const { AVAILABLE_RECOGNITION } = await import('../../../../support/app/browser-recognition.ts');
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
      'Speech speed: standard (one core)',
    );
  });
});
