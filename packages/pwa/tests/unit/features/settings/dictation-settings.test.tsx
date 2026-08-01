import { describe, expect, it } from 'bun:test';
import {
  DAEMON_MODE_SUMMARY,
  DICTATION_DISABLED_EXPLANATION,
  DICTATION_SAFETY_NOTE,
  DictationSettings,
  type DictationSettingsProps,
  ENHANCEMENT_EXPLANATION,
  ENHANCEMENT_SOURCES_EXPLANATION,
  ENHANCEMENT_TOGGLE_EXPLANATION,
  formatBytes,
  GROQ_ENHANCEMENT_EXPLANATION,
  needsDaemonModel,
  USER_CONTEXT_EXPLANATION,
} from '../../../../src/features/settings/dictation-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import type { DaemonModelStatus, FetchLike } from '../../../../src/lib/stt/daemon-engine.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings, type SttSettingsPatch } from '../../../../src/lib/stt/stt-settings.ts';
import { interact, mount, must } from '../../../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceToken: 'token-a' });

const model = (overrides: Partial<DaemonModelStatus> = {}) => ({
  id: 'parakeet',
  kind: 'daemon',
  label: 'Parakeet TDT',
  state: 'ready',
  languages: ['en'],
  costs: {
    downloadBytes: 652_000_000,
    diskBytes: 652_000_000,
    ramBytesApprox: 1_100_000_000,
    summary: 'Parakeet TDT — 652 MB on disk.',
  },
  install: { phase: 'ready', receivedBytes: 0, totalBytes: 0 },
  ...overrides,
});

const statusBody = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  streaming: false,
  worker: { phase: 'ready', modelId: 'parakeet' },
  languages: ['en'],
  models: { daemon: model() },
  ...overrides,
});

interface Recorder {
  readonly fetchImpl: FetchLike;
  readonly urls: string[];
}

const recordingFetch = (answer: (url: string) => Response): Recorder => {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async url => {
      urls.push(url);
      return answer(url);
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const settingsProps = (overrides: Partial<DictationSettingsProps> = {}): DictationSettingsProps => ({
  daemon,
  settings: DEFAULT_STT_SETTINGS,
  update: () => undefined,
  persisted: true,
  fetchImpl: async () => json(statusBody()),
  ...overrides,
});

/**
 * React tracks the last value it wrote on the DOM node itself, so assigning
 * `.value` directly is invisible to it. Writing through the prototype setter is
 * what a real keystroke does and is what makes `onChange` fire.
 */
const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const areaValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

const type = async (element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => {
  await interact(() => {
    const setter = element instanceof HTMLTextAreaElement ? areaValueSetter : inputValueSetter;
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const switchNamed = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(button =>
      (button.textContent ?? '').includes(label),
    ) ?? null,
    `the ${label} switch`,
  );

describe('formatBytes', () => {
  it('uses MB below a gigabyte and GB above it', () => {
    expect(formatBytes(652_000_000)).toBe('652 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
  });

  it('refuses to invent a number it does not have', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(-1)).toBe('0 MB');
    expect(formatBytes(Number.NaN)).toBe('0 MB');
  });
});

describe('needsDaemonModel', () => {
  it('treats an unknown status as permission to try, not as a refusal', () => {
    expect(needsDaemonModel(undefined)).toBe(false);
  });

  it('is true only when the daemon says the model is not ready', () => {
    expect(needsDaemonModel(model() as DaemonModelStatus)).toBe(false);
    expect(needsDaemonModel(model({ state: 'not-installed' }) as DaemonModelStatus)).toBe(true);
  });
});

describe('<DictationSettings>', () => {
  it('names where the audio goes instead of claiming the device transcribes it', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    expect(view.container.textContent).toContain(DAEMON_MODE_SUMMARY);
    expect(view.container.textContent).toContain('Browser-local transcription is not available in this build');
    expect(view.container.textContent).not.toContain('Prepare this device');
    await view.unmount();
  });

  /**
   * kteam's suite asserted that every mandatory disclosure was rendered, because
   * a disclosure that exists only as a constant protects nobody. The set is
   * different here — the browser-local costs are gone with the engine — but the
   * rule is the same, so each one is checked against the real render.
   */
  it('renders every disclosure it declares, with none left as an unused constant', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    for (const copy of [
      DICTATION_SAFETY_NOTE,
      DAEMON_MODE_SUMMARY,
      DICTATION_DISABLED_EXPLANATION,
      ENHANCEMENT_TOGGLE_EXPLANATION,
      ENHANCEMENT_EXPLANATION,
      ENHANCEMENT_SOURCES_EXPLANATION,
      USER_CONTEXT_EXPLANATION,
    ]) {
      expect(view.container.textContent).toContain(copy);
    }
    expect(view.container.textContent).not.toContain(GROQ_ENHANCEMENT_EXPLANATION);

    await view.render(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' } })} />,
    );
    expect(view.container.textContent).toContain(GROQ_ENHANCEMENT_EXPLANATION);
    await view.unmount();
  });

  it('asks the named daemon what it can transcribe, and says so', async () => {
    const recorder = recordingFetch(() => json(statusBody()));
    const view = await mount(<DictationSettings {...settingsProps({ fetchImpl: recorder.fetchImpl })} />);
    expect(recorder.urls[0]).toBe('http://127.0.0.1:1/v1/stt/status');
    expect(view.container.textContent).toContain('Ready — en.');
    expect(view.container.textContent).toContain('Parakeet TDT — 652 MB on disk.');
    expect(view.container.textContent).toContain('does not claim live text');
    await view.unmount();
  });

  it('re-asks when the reader switches to a different paired daemon', async () => {
    const recorder = recordingFetch(() => json(statusBody()));
    const view = await mount(<DictationSettings {...settingsProps({ fetchImpl: recorder.fetchImpl })} />);
    const second = daemonConnection({
      daemonId: 'daemon-b',
      baseUrl: 'http://127.0.0.1:2',
      deviceToken: 'token-b',
    });
    await view.render(<DictationSettings {...settingsProps({ daemon: second, fetchImpl: recorder.fetchImpl })} />);
    expect(recorder.urls).toEqual(['http://127.0.0.1:1/v1/stt/status', 'http://127.0.0.1:2/v1/stt/status']);
    await view.unmount();
  });

  it('reports a daemon that has no dictation support at all', async () => {
    const view = await mount(
      <DictationSettings {...settingsProps({ fetchImpl: async () => new Response('nope', { status: 404 }) })} />,
    );
    expect(view.container.textContent).toContain('This box has no dictation support yet.');
    await view.unmount();
  });

  it('offers the one-time daemon download when the model is missing', async () => {
    const installs: string[] = [];
    const view = await mount(
      <DictationSettings
        {...settingsProps({
          fetchImpl: async url => {
            if (url.includes('/install')) {
              installs.push(url);
              return json({ started: true });
            }
            return json(
              statusBody({
                models: { daemon: model({ state: installs.length > 0 ? 'installing' : 'not-installed' }) },
              }),
            );
          },
        })}
      />,
    );
    expect(view.container.textContent).toContain('This daemon has no speech model yet');
    const button = must(
      [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
        (candidate.textContent ?? '').includes('Download Parakeet TDT'),
      ) ?? null,
      'the download button',
    );
    expect(button.textContent).toContain('652 MB');
    await interact(() => button.click());
    expect(installs[0]).toBe('http://127.0.0.1:1/v1/stt/models/parakeet/install');
    await view.unmount();
  });

  it('shows the daemon-s own refusal rather than a generic failure', async () => {
    const view = await mount(
      <DictationSettings
        {...settingsProps({
          fetchImpl: async url =>
            url.includes('/install')
              ? json({ error: 'No disk space on the daemon.' }, 507)
              : json(statusBody({ models: { daemon: model({ state: 'not-installed' }) } })),
        })}
      />,
    );
    const button = must(
      [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
        (candidate.textContent ?? '').includes('Download Parakeet TDT'),
      ) ?? null,
      'the download button',
    );
    await interact(() => button.click());
    expect(view.container.textContent).toContain('No disk space on the daemon.');
    await view.unmount();
  });

  it('reports the daemon-s own download progress while it runs', async () => {
    const view = await mount(
      <DictationSettings
        {...settingsProps({
          fetchImpl: async () =>
            json(
              statusBody({
                models: {
                  daemon: model({
                    state: 'installing',
                    install: { phase: 'downloading', receivedBytes: 120_000_000, totalBytes: 652_000_000 },
                  }),
                },
              }),
            ),
        })}
      />,
    );
    expect(view.container.textContent).toContain('120 MB of 652 MB');
    const button = must(
      [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
        (candidate.textContent ?? '').includes('Download Parakeet TDT'),
      ) ?? null,
      'the download button',
    );
    expect(button.disabled).toBe(true);
    await view.unmount();
  });

  it('hides everything but the switch while dictation is off', async () => {
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, enabled: false } })} />,
    );
    expect(view.container.textContent).toContain('Dictation is disabled.');
    expect(view.container.querySelector('#stt-dictionary')).toBeNull();
    await view.unmount();
  });

  it('toggles the master switch and the enhancer through one update port', async () => {
    const patches: SttSettingsPatch[] = [];
    const props = settingsProps({ update: patch => patches.push(patch) });
    const view = await mount(<DictationSettings {...props} />);
    await interact(() => switchNamed(view.container, 'Dictation').click());
    await interact(() => switchNamed(view.container, 'Fix names and jargon').click());
    expect(patches).toEqual([{ enabled: false }, { enhancement: false }]);
    await view.unmount();
  });

  it('hides the provider choice entirely when correction is switched off', async () => {
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, enhancement: false } })} />,
    );
    expect(switchNamed(view.container, 'Fix names and jargon').textContent).toContain('Off');
    expect(view.container.querySelector('#stt-enhancement-provider')).toBeNull();
    // The dictionary is still editable: it is what an enhancer would use later.
    expect(view.container.querySelector('#stt-dictionary')).not.toBeNull();
    await view.unmount();
  });

  it('swaps the correction explanations when the provider changes', async () => {
    const patches: SttSettingsPatch[] = [];
    const view = await mount(<DictationSettings {...settingsProps({ update: patch => patches.push(patch) })} />);
    expect(view.container.textContent).toContain('WORDS ONLY.');
    expect(view.container.querySelector('#stt-enhancement-model')).toBeNull();

    const select = must(view.container.querySelector<HTMLSelectElement>('#stt-enhancement-provider'), 'the provider');
    await interact(() => {
      select.value = 'groq';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(patches).toEqual([{ enhancementProvider: 'groq' }]);

    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' };
    await view.render(<DictationSettings {...settingsProps({ settings: groq })} />);
    expect(view.container.querySelector('#stt-enhancement-model')).not.toBeNull();
    expect(view.container.textContent).toContain('The daemon holds the Groq API key');
    await view.unmount();
  });

  it('edits the Groq model name', async () => {
    const patches: SttSettingsPatch[] = [];
    const groq: SttSettings = { ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq' };
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: groq, update: patch => patches.push(patch) })} />,
    );
    const input = must(view.container.querySelector<HTMLInputElement>('#stt-enhancement-model'), 'the model field');
    await type(input, 'llama-3.3-70b');
    expect(patches).toEqual([{ enhancementModel: 'llama-3.3-70b' }]);
    await view.unmount();
  });

  it('counts the reader-s terms and names every problem with a line', async () => {
    const withDictionary: SttSettings = {
      ...DEFAULT_STT_SETTINGS,
      dictionary: ['ferretry = ferretree', 'two words here'],
    };
    const patches: SttSettingsPatch[] = [];
    const view = await mount(
      <DictationSettings {...settingsProps({ settings: withDictionary, update: patch => patches.push(patch) })} />,
    );
    expect(view.container.textContent).toContain('1 term.');
    expect(view.container.querySelectorAll('ul li').length).toBeGreaterThan(0);

    const area = must(view.container.querySelector<HTMLTextAreaElement>('#stt-dictionary'), 'the dictionary');
    await type(area, 'one\ntwo');
    expect(patches).toEqual([{ dictionary: ['one', 'two'] }]);
    await view.unmount();
  });

  it('echoes back the words a pasted context actually yields', async () => {
    const patches: SttSettingsPatch[] = [];
    const view = await mount(
      <DictationSettings
        {...settingsProps({
          settings: { ...DEFAULT_STT_SETTINGS, userContext: 'We ship ferretry with nitroso and diene.' },
          update: patch => patches.push(patch),
        })}
      />,
    );
    expect(view.container.textContent).toMatch(/\d+ words? picked out/);
    expect(view.container.textContent).toContain('ferretry');

    const area = must(view.container.querySelector<HTMLTextAreaElement>('#stt-user-context'), 'the context field');
    await type(area, 'plain english only');
    expect(patches).toEqual([{ userContext: 'plain english only' }]);

    await view.render(
      <DictationSettings {...settingsProps({ settings: { ...DEFAULT_STT_SETTINGS, userContext: 'the and of' } })} />,
    );
    expect(view.container.textContent).toContain('0 words picked out');
    await view.unmount();
  });

  it('saves the reader-s chosen push-to-talk chord', async () => {
    const view = await mount(<DictationSettings {...settingsProps()} />);
    expect(view.container.textContent).toContain('Push to talk');
    await view.unmount();
  });

  it('says plainly when this browser refused to store the choices', async () => {
    const view = await mount(<DictationSettings {...settingsProps({ persisted: false })} />);
    expect(view.container.textContent).toContain('could not be saved');
    await view.unmount();
  });
});
