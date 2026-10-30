import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  ConfigFileView,
  FleetMachineView,
  LearningConfig,
  PairedDevicesView,
  SpeedupsView,
  WardenConfig,
  WardenConfigView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactElement } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import type { OnboardingDoneRow } from '../../../../../src/features/fleet/setup/onboarding-model.ts';
import {
  OnboardingControlsStep,
  OnboardingDoneStep,
  OnboardingLearningStep,
  OnboardingPairStep,
  OnboardingSpeedupsStep,
  OnboardingStartStep,
  OnboardingVoiceStep,
  OnboardingWardenStep,
  type VoiceCleanupPort,
} from '../../../../../src/features/fleet/setup/onboarding-steps.tsx';
import type { MachineTabProps } from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import type { PairingClientFactory } from '../../../../../src/features/settings/add-device-settings.tsx';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import { DEFAULT_STT_SETTINGS, type SttSettingsPatch } from '../../../../../src/lib/stt/stt-settings.ts';
import { AVAILABLE_RECOGNITION } from '../../../../support/browser-recognition.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../../support/dom.ts';
import { config as learningConfig } from '../../../../support/learning.ts';
import { wardenConfig } from '../../../../support/warden.ts';
import { fileView } from '../../config-files/config-files-support.ts';
import {
  type Call,
  machineAnswer,
  machineView,
  runtimes,
  runtimeView,
  STUDIO,
  scriptedClient,
  WORK,
} from './setup-support.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const DESKTOP_WIDTH = 1_280;
const PHONE_WIDTH = 390;
const ORIGINAL_WIDTH = typeof window === 'undefined' ? DESKTOP_WIDTH : window.innerWidth;

const setViewport = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const speedups = (jev: 'set' | 'missing', vault: SpeedupsView['vault'] = 'ok'): SpeedupsView => {
  const provider = (id: 'jev' | 'groq', label: string, secretName: string, set: boolean) => ({
    provider: id,
    label,
    purpose: `${label} purpose.`,
    costNote: 'Well under a cent.',
    privacyNote: 'Text goes to the vendor.',
    keyUrl: `https://keys.example.test/${id}`,
    testNote: 'One call.',
    secretName,
    set,
    testStale: false,
  });
  return {
    vault,
    providers: [provider('jev', 'Jev', 'JEV_API_KEY', jev === 'set'), provider('groq', 'Groq', 'GROQ_API_KEY', false)],
  };
};

const wardenView = (overrides: Partial<WardenConfig> = {}): WardenConfigView => {
  const config = wardenConfig(overrides);
  return { config, accounts: config.accounts, warnings: [] };
};

const PAIR_DEVICES: PairedDevicesView = { devices: [], hostLocal: false, mayWiden: undefined as never };

const pairingClient: PairingClientFactory = async () => ({
  request: (async (path: string) => {
    if (path === '/v1/pair/devices') return PAIR_DEVICES;
    throw new Error(`unexpected ${path}`);
  }) as never,
});

const record = (connection: typeof STUDIO, label: string): DaemonConnectionRecord => ({
  ...connection,
  label,
  pairedAt: 0,
  lastSelectedAt: 0,
});

/** A GET carries no body; a PATCH does. Lets one path answer both. */
const byMethod =
  (read: unknown, write: unknown) =>
  (call: Call): unknown =>
    call.body === undefined ? read : write;

const refusal = (): Error => new FyHttpError('The machine refused.', 403, 'forbidden');

interface Tab {
  readonly tab: MachineTabProps;
  readonly calls: Call[];
  readonly retried: { count: number };
}

const tabFor = (
  answers: Parameters<typeof scriptedClient>[0] = {},
  overrides: {
    readonly machine?: FleetMachineView | null;
    readonly checking?: boolean;
    /** A request this returns a promise for waits on it before it is answered. */
    readonly hold?: (call: { readonly path: string; readonly write: boolean }) => Promise<void> | undefined;
  } = {},
): Tab => {
  const calls: Call[] = [];
  const retried = { count: 0 };
  const inner: FleetClient = scriptedClient({ '/v1/fleet/machine': machineAnswer(), ...answers }, calls);
  const { hold } = overrides;
  const client: FleetClient =
    hold === undefined
      ? inner
      : {
          request: async (path, schema, init, timeout) => {
            await hold({ path, write: init?.body !== undefined });
            return await inner.request(path, schema, init, timeout);
          },
        };
  return {
    calls,
    retried,
    tab: {
      connection: STUDIO,
      machineName: 'studio-mac',
      machine: overrides.machine === undefined ? machineView() : overrides.machine,
      online: true,
      checking: overrides.checking ?? false,
      onRetry: () => {
        retried.count += 1;
      },
      createClient: async () => client,
    },
  };
};

// ── Driving ──────────────────────────────────────────────────────────────────────────────────────

let view: Mounted | null = null;

beforeEach(() => {
  setViewport(DESKTOP_WIDTH);
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  setViewport(ORIGINAL_WIDTH);
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const show = async (element: ReactElement): Promise<void> => {
  view = await mount(element);
  await settle();
};

const q = (selector: string): Element | null => view?.container.querySelector(selector) ?? null;
const text = (selector?: string): string =>
  (selector === undefined ? view?.container.textContent : q(selector)?.textContent) ?? '';

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const buttonLabelled = (label: string): HTMLButtonElement =>
  must(
    Array.from(view?.container.querySelectorAll('button') ?? []).find(button => button.textContent === label),
    `the ${label} button`,
  );

// ── Pair ─────────────────────────────────────────────────────────────────────────────────────────

describe('OnboardingPairStep', () => {
  it('says this device is already paired, and offers to pair a phone too', async () => {
    await show(<OnboardingPairStep connection={STUDIO} machineName="studio-mac" createPairingClient={pairingClient} />);
    expect(text('[data-setup-note="paired"]')).toContain('This device is paired with studio-mac');
    expect(text('[data-setup-note="paired"]')).toContain('it can never be relayed');
    expect(text('[data-setup-section="pair-another"]')).toContain('Pair a phone now');
    expect(q('[data-pair-phone]')).toBeNull();
  });

  it('opens the pairing surface in a dialog on a desktop, and closes it', async () => {
    await show(<OnboardingPairStep connection={STUDIO} machineName="studio-mac" createPairingClient={pairingClient} />);
    await click(q('[data-onboarding-pair-phone]'), 'Pair a phone too');
    const dialog = must(document.querySelector('[data-pair-phone="dialog"] [role="dialog"]'), 'the dialog');
    expect(dialog.querySelector('[data-pair-phone-body]')).not.toBeNull();
    await click(document.querySelector('[data-pair-phone-close]'), 'Close');
    expect(document.querySelector('[data-pair-phone]')).toBeNull();
  });

  it('opens it as a bottom sheet on a phone', async () => {
    setViewport(PHONE_WIDTH);
    await show(<OnboardingPairStep connection={STUDIO} machineName="studio-mac" createPairingClient={pairingClient} />);
    await click(q('[data-onboarding-pair-phone]'), 'Pair a phone too');
    const sheet = must(document.querySelector('[data-bottom-sheet="pair-phone"]'), 'the sheet');
    expect(sheet.querySelector('[data-pair-phone="sheet"]')).not.toBeNull();
    await interact(() => pressKey(must(sheet.querySelector('[role="dialog"]'), 'the panel'), 'Escape'));
    expect(document.querySelector('[data-pair-phone-body]')).toBeNull();
  });

  it('pairs through the routed client when none is handed in', async () => {
    await show(<OnboardingPairStep connection={STUDIO} machineName="studio-mac" />);
    expect(q('[data-onboarding-step-body="pair"]')).not.toBeNull();
  });
});

// ── Start from ───────────────────────────────────────────────────────────────────────────────────

describe('OnboardingStartStep', () => {
  const startStep = (start: 'fresh' | 'clone', started: string[], extra: Partial<Tab> = {}) => {
    const { tab } =
      extra.tab === undefined ? tabFor({ '/v1/fleet/profiles': { format: 'version-2', profiles: [] } }) : extra;
    return (
      <OnboardingStartStep
        start={start}
        onStart={choice => started.push(choice)}
        sources={[record(WORK, 'work-linux')]}
        tab={tab as MachineTabProps}
        onCloned={() => started.push('cloned')}
        onCopied={source => started.push(`copied ${source}`)}
      />
    );
  };

  it('offers a fresh setup or a clone, and reports the choice', async () => {
    const started: string[] = [];
    await show(startStep('fresh', started));
    expect(q('[data-setup-choice="fresh"] input')).toHaveProperty('checked', true);
    expect(q('[data-clone-step]')).toBeNull();
    expect(text('[data-setup-choice="clone"]')).toContain('Secrets and login tokens are never copied.');
    await click(q('[data-setup-choice="clone"] input'), 'the clone choice');
    expect(started).toEqual(['clone']);
  });

  it('embeds the Copy flow when cloning, with no step list, no “Step n of m” and no title of its own', async () => {
    const started: string[] = [];
    await show(startStep('clone', started));
    expect(q('[data-setup-choice="clone"] input')).toHaveProperty('checked', true);
    expect(q('[data-clone-step="source"]')).not.toBeNull();
    const body = must(q('[data-onboarding-step-body="start"]'), 'the start body');
    expect(body.querySelector('[data-presentation="embedded"]')).not.toBeNull();
    expect(body.textContent).not.toMatch(/Step \d+ of \d+/);
    expect(body.querySelector('#machine-stepper-title')).toBeNull();
    expect(body.querySelector('[data-stepper-back]')).toBeNull();
    expect(body.querySelector('[data-stepper-cancel]')).toBeNull();
    expect(started).toEqual([]);
  });
});

// ── Speed-ups ────────────────────────────────────────────────────────────────────────────────────

describe('OnboardingSpeedupsStep', () => {
  it('renders the Speed-ups surface and says keys are used, never read back', async () => {
    const { tab } = tabFor({ '/v1/speedups': speedups('set') });
    await show(<OnboardingSpeedupsStep tab={tab} />);
    expect(q('[data-onboarding-step-body="speedups"]')).not.toBeNull();
    expect(q('[data-speedup="jev"]')).not.toBeNull();
    expect(q('[data-speedup="groq"]')).not.toBeNull();
    expect(text('[data-speedup="jev"] [data-speedup-set]').toLowerCase()).toContain('set');
    expect(text()).toContain('studio-mac’s secret store: used, never read back.');
  });
});

// ── Voice ────────────────────────────────────────────────────────────────────────────────────────

describe('OnboardingVoiceStep', () => {
  const port = (provider: 'local' | 'groq' | 'cerebras', patches: SttSettingsPatch[]): VoiceCleanupPort => ({
    settings: { ...DEFAULT_STT_SETTINGS, enhancementProvider: provider },
    update: patch => patches.push(patch),
  });

  const VOICE_FILE_PATH = '/v1/config/file?path=voice.yaml';
  const PUT_PATH = '/v1/config/file';
  const voiceFile = (text: string, etag = 'etag-voice-1'): ConfigFileView =>
    fileView({ path: 'voice.yaml', kind: 'voice', schema: 'voice', text, etag });
  const PUT_RESULT = { path: 'voice.yaml', etag: 'etag-voice-2', outcome: 'applied' };
  const engineInput = (engine: 'parakeet' | 'browser') => q(`input[type="radio"][value="${engine}"]`);
  const writes = (calls: readonly Call[]) => calls.filter(call => call.path === PUT_PATH);

  const voiceStep = (tab: MachineTabProps, extra: { cleanup?: VoiceCleanupPort } = {}) => (
    <OnboardingVoiceStep tab={tab} voice={null} browserSupport={AVAILABLE_RECOGNITION} {...extra} />
  );

  it('says it is reading while the machine answers, and offers no engine yet', async () => {
    const never = new Promise<void>(() => undefined);
    const { tab } = tabFor({ [VOICE_FILE_PATH]: voiceFile('') }, { hold: () => never });
    await show(voiceStep(tab));
    expect(text('[data-onboarding-reading="voice"]')).toBe('Reading studio-mac’s voice settings…');
    expect(engineInput('parakeet')).toBeNull();
    expect(q('[data-onboarding-voice-problem]')).toBeNull();
  });

  it('shows the default voice.yaml names as checked', async () => {
    const { tab, calls } = tabFor({ [VOICE_FILE_PATH]: voiceFile('# mine\ndefaultEngine: parakeet\n') });
    await show(voiceStep(tab));
    expect(q('[data-onboarding-reading="voice"]')).toBeNull();
    expect(engineInput('parakeet')).toHaveProperty('checked', true);
    expect(engineInput('browser')).toHaveProperty('checked', false);
    expect(q('[data-onboarding-voice-problem]')).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it('shows nothing checked when voice.yaml names no default', async () => {
    const { tab } = tabFor({ [VOICE_FILE_PATH]: voiceFile('') });
    await show(voiceStep(tab));
    expect(engineInput('parakeet')).toHaveProperty('checked', false);
    expect(engineInput('browser')).toHaveProperty('checked', false);
  });

  it('writes the chosen default into voice.yaml against the etag it read, keeping the rest of the file', async () => {
    const { tab, calls } = tabFor({
      [VOICE_FILE_PATH]: voiceFile('# mine\ndefaultEngine: parakeet\n', 'etag-voice-7'),
      [PUT_PATH]: PUT_RESULT,
    });
    await show(voiceStep(tab));
    await click(engineInput('browser'), 'Phone/browser voice');
    const put = writes(calls);
    expect(put).toHaveLength(1);
    expect(put[0]?.body).toEqual({ path: 'voice.yaml', text: '# mine\ndefaultEngine: browser\n' });
    expect(put[0]?.headers['if-match']).toBe('etag-voice-7');
    expect(engineInput('browser')).toHaveProperty('checked', true);
    expect(q('[data-onboarding-voice-problem]')).toBeNull();
  });

  it('adds the default line when voice.yaml had none', async () => {
    const { tab, calls } = tabFor({ [VOICE_FILE_PATH]: voiceFile('# mine'), [PUT_PATH]: PUT_RESULT });
    await show(voiceStep(tab));
    await click(engineInput('parakeet'), 'Parakeet');
    expect(writes(calls)[0]?.body).toEqual({ path: 'voice.yaml', text: '# mine\ndefaultEngine: parakeet\n' });
  });

  it('shows an alert, and the choice with nothing selected, when voice.yaml cannot be read', async () => {
    const { tab } = tabFor({ [VOICE_FILE_PATH]: refusal() });
    await show(voiceStep(tab));
    expect(text('[data-onboarding-voice-problem]')).toBe('The machine refused.');
    expect(q('[data-onboarding-voice-problem]')?.getAttribute('role')).toBe('alert');
    expect(q('[data-onboarding-reading="voice"]')).toBeNull();
    expect(engineInput('parakeet')).toHaveProperty('checked', false);
    expect(engineInput('browser')).toHaveProperty('checked', false);
  });

  it('shows an alert when the write is refused, and clears it on the next choice', async () => {
    let refuse = true;
    const { tab } = tabFor({
      [VOICE_FILE_PATH]: voiceFile('defaultEngine: parakeet\n'),
      [PUT_PATH]: () => (refuse ? refusal() : PUT_RESULT),
    });
    await show(voiceStep(tab));
    await click(engineInput('browser'), 'Phone/browser voice');
    expect(text('[data-onboarding-voice-problem]')).toBe('The machine refused.');
    refuse = false;
    await click(engineInput('parakeet'), 'Parakeet');
    expect(q('[data-onboarding-voice-problem]')).toBeNull();
  });

  it('shows an alert when the file cannot be read again at the moment of writing', async () => {
    let reads = 0;
    const { tab, calls } = tabFor({
      [VOICE_FILE_PATH]: () => {
        reads += 1;
        return reads === 1 ? voiceFile('') : refusal();
      },
    });
    await show(voiceStep(tab));
    await click(engineInput('browser'), 'Phone/browser voice');
    expect(text('[data-onboarding-voice-problem]')).toBe('The machine refused.');
    expect(writes(calls)).toEqual([]);
  });

  it('uses the app’s own voice service and the page’s own speech support when none are handed in', async () => {
    const { tab } = tabFor({ [VOICE_FILE_PATH]: voiceFile('') });
    await show(<OnboardingVoiceStep tab={tab} />);
    expect(engineInput('parakeet')).not.toBeNull();
    expect(engineInput('browser')).not.toBeNull();
  });

  it('points at Settings when there is no clean-up port', async () => {
    const { tab } = tabFor({ [VOICE_FILE_PATH]: voiceFile('') });
    await show(voiceStep(tab));
    expect(text('[data-onboarding-voice-cleanup="settings"]')).toContain('Settings › Behaviour › Dictation');
    expect(q('[data-setup-choices="voice-cleanup"]')).toBeNull();
  });

  it('shows the saved clean-up choice, and choosing another updates the dictation settings', async () => {
    const patches: SttSettingsPatch[] = [];
    const { tab } = tabFor({ [VOICE_FILE_PATH]: voiceFile('') });
    await show(voiceStep(tab, { cleanup: port('groq', patches) }));
    expect(q('[data-onboarding-voice-cleanup]')).toBeNull();
    expect(q('[data-setup-choice="groq"] input')).toHaveProperty('checked', true);
    expect(q('[data-setup-choice="local"] input')).toHaveProperty('checked', false);
    await click(q('[data-setup-choice="cerebras"] input'), 'Cerebras');
    await click(q('[data-setup-choice="local"] input'), 'On this device only');
    expect(patches).toEqual([{ enhancementProvider: 'cerebras' }, { enhancementProvider: 'local' }]);
  });
});

// ── Warden ───────────────────────────────────────────────────────────────────────────────────────

describe('OnboardingWardenStep', () => {
  const jevSwitch = (): HTMLButtonElement =>
    must(view?.container.querySelector<HTMLButtonElement>('[aria-label="Jev on"]'), 'the Jev switch');
  const jevOn = (): boolean => jevSwitch().getAttribute('aria-checked') === 'true';

  it('says it is reading while the Warden answers', async () => {
    const never = new Promise<void>(() => undefined);
    const { tab } = tabFor({ '/v1/warden/config': wardenView() }, { hold: () => never });
    await show(<OnboardingWardenStep tab={tab} onSaved={() => undefined} />);
    expect(text('[data-onboarding-reading="warden"]')).toBe('Reading the Warden’s settings…');
  });

  it('says why it could not read the settings, and offers Settings later', async () => {
    const { tab } = tabFor({ '/v1/warden/config': refusal() });
    await show(<OnboardingWardenStep tab={tab} onSaved={() => undefined} />);
    const note = text('[data-setup-note="warden-unavailable"]');
    expect(note).toContain('Couldn’t read the Warden’s settings');
    expect(note).toContain('set it up later in Settings › Warden');
  });

  it('switches Jev on when a Jev key is set, and nothing is saved until Save', async () => {
    const { tab, calls } = tabFor({
      '/v1/warden/config': byMethod(wardenView(), wardenView()),
      '/v1/speedups': speedups('set'),
    });
    await show(<OnboardingWardenStep tab={tab} onSaved={() => undefined} />);
    expect(text('[data-onboarding-step-body="warden"]')).toContain('A Jev key is set, so Jev is switched on');
    expect(jevOn()).toBe(true);
    expect(text('[data-onboarding-warden-unsaved]')).toContain('Not saved yet');
    expect(buttonLabelled('Save').disabled).toBe(false);
    expect(calls.some(call => call.body !== undefined)).toBe(false);
  });

  it('saves with a PATCH of what changed, reports it, and shows saved', async () => {
    const saved = wardenView({ layers: { jev: true, llm: false } });
    const { tab, calls } = tabFor({
      '/v1/warden/config': byMethod(wardenView(), saved),
      '/v1/speedups': speedups('set'),
    });
    let onSaved = 0;
    await show(
      <OnboardingWardenStep
        tab={tab}
        onSaved={() => {
          onSaved += 1;
        }}
      />,
    );
    await click(buttonLabelled('Save'), 'Save');
    const patches = calls.filter(call => call.body !== undefined);
    expect(patches).toHaveLength(1);
    // Only the key that changed: the default already has the LLM layer off.
    expect(patches[0]?.body).toEqual({ layers: { jev: true } });
    expect(patches[0]?.headers['content-type']).toBe('application/json');
    expect(onSaved).toBe(1);
    expect(text('[role="status"]')).toContain('Saved — in effect now.');
    expect(q('[data-onboarding-warden-unsaved]')).toBeNull();
  });

  it('forgets “saved” again as soon as the draft changes', async () => {
    const saved = wardenView({ layers: { jev: true, llm: false } });
    const { tab } = tabFor({
      '/v1/warden/config': byMethod(wardenView(), saved),
      '/v1/speedups': speedups('set'),
    });
    await show(<OnboardingWardenStep tab={tab} onSaved={() => undefined} />);
    await click(buttonLabelled('Save'), 'Save');
    expect(text()).toContain('Saved — in effect now.');
    await click(jevSwitch(), 'the Jev switch');
    expect(text()).not.toContain('Saved — in effect now.');
    expect(q('[data-onboarding-warden-unsaved]')).not.toBeNull();
  });

  it('shows the daemon’s refusal when the PATCH fails, and keeps the draft', async () => {
    const { tab } = tabFor({
      '/v1/warden/config': byMethod(wardenView(), refusal()),
      '/v1/speedups': speedups('set'),
    });
    let onSaved = 0;
    await show(
      <OnboardingWardenStep
        tab={tab}
        onSaved={() => {
          onSaved += 1;
        }}
      />,
    );
    await click(buttonLabelled('Save'), 'Save');
    expect(must(q('[role="alert"]'), 'the error').textContent).not.toBe('');
    expect(onSaved).toBe(0);
    expect(jevOn()).toBe(true);
    expect(text()).not.toContain('Saved — in effect now.');
  });

  it('leads with the rules-only sentence when there is no Jev key, and preselects nothing', async () => {
    const { tab } = tabFor({
      '/v1/warden/config': byMethod(wardenView(), wardenView()),
      '/v1/speedups': speedups('missing'),
    });
    await show(<OnboardingWardenStep tab={tab} onSaved={() => undefined} />);
    expect(text('[data-onboarding-step-body="warden"]')).toContain('Without a Jev key the safe default is rules only');
    expect(jevOn()).toBe(false);
    expect(q('[data-onboarding-warden-unsaved]')).toBeNull();
  });

  it('carries on when the Speed-ups read fails, treating the Jev key as unknown', async () => {
    const { tab } = tabFor({ '/v1/warden/config': byMethod(wardenView(), wardenView()) });
    await show(<OnboardingWardenStep tab={tab} onSaved={() => undefined} />);
    expect(text('[data-onboarding-step-body="warden"]')).toContain('Without a Jev key the safe default is rules only');
    expect(jevOn()).toBe(false);
  });
});

// ── Learning ─────────────────────────────────────────────────────────────────────────────────────

describe('OnboardingLearningStep', () => {
  const learning = (passiveDefault: boolean): LearningConfig => learningConfig({ passiveDefault });

  it('says it is reading while the daemon answers', async () => {
    const never = new Promise<void>(() => undefined);
    const { tab } = tabFor({ '/v1/learning/config': learning(true) }, { hold: () => never });
    await show(<OnboardingLearningStep tab={tab} onSaved={() => undefined} />);
    expect(text('[data-onboarding-reading="learning"]')).toBe('Reading the learning default…');
    expect(q('[data-setup-choices]')).toBeNull();
  });

  it('shows an alert, and no choice, when the default cannot be read', async () => {
    const { tab } = tabFor({ '/v1/learning/config': refusal() });
    await show(<OnboardingLearningStep tab={tab} onSaved={() => undefined} />);
    expect(must(q('[role="alert"]'), 'the alert').textContent).not.toBe('');
    expect(q('[data-setup-choices]')).toBeNull();
    expect(q('[data-onboarding-reading="learning"]')).toBeNull();
  });

  it('checks the current default', async () => {
    const { tab } = tabFor({ '/v1/learning/config': byMethod(learning(true), learning(true)) });
    await show(<OnboardingLearningStep tab={tab} onSaved={() => undefined} />);
    expect(q('[data-setup-choice="on"] input')).toHaveProperty('checked', true);
    expect(q('[data-setup-choice="off"] input')).toHaveProperty('checked', false);
    expect(q('[role="alert"]')).toBeNull();
  });

  it('PATCHes {passiveDefault} on a choice, reports it, and checks the answer', async () => {
    const { tab, calls } = tabFor({ '/v1/learning/config': byMethod(learning(true), learning(false)) });
    let onSaved = 0;
    await show(
      <OnboardingLearningStep
        tab={tab}
        onSaved={() => {
          onSaved += 1;
        }}
      />,
    );
    await click(q('[data-setup-choice="off"] input'), 'Off');
    const patches = calls.filter(call => call.body !== undefined);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ passiveDefault: false });
    expect(onSaved).toBe(1);
    expect(q('[data-setup-choice="off"] input')).toHaveProperty('checked', true);
  });

  it('shows an alert when the PATCH fails, and keeps the old choice', async () => {
    const { tab } = tabFor({ '/v1/learning/config': byMethod(learning(true), refusal()) });
    let onSaved = 0;
    await show(
      <OnboardingLearningStep
        tab={tab}
        onSaved={() => {
          onSaved += 1;
        }}
      />,
    );
    await click(q('[data-setup-choice="off"] input'), 'Off');
    expect(must(q('[role="alert"]'), 'the alert').textContent).not.toBe('');
    expect(onSaved).toBe(0);
    expect(q('[data-setup-choice="on"] input')).toHaveProperty('checked', true);
  });

  it('ignores a second choice while the first is still being saved', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    let writes = 0;
    const { tab } = tabFor(
      { '/v1/learning/config': byMethod(learning(true), learning(false)) },
      {
        hold: ({ write }) => {
          if (!write) return undefined;
          writes += 1;
          return pending;
        },
      },
    );
    await show(<OnboardingLearningStep tab={tab} onSaved={() => undefined} />);
    await click(q('[data-setup-choice="off"] input'), 'Off');
    await click(q('[data-setup-choice="on"] input'), 'On');
    expect(writes).toBe(1);
    await interact(() => release());
    await settle();
  });
});

// ── Agent controls ───────────────────────────────────────────────────────────────────────────────

describe('OnboardingControlsStep', () => {
  it('says it is checking while the machine has not answered', async () => {
    const { tab } = tabFor({}, { machine: null, checking: true });
    await show(<OnboardingControlsStep tab={tab} />);
    expect(text('[data-onboarding-reading="controls"]')).toBe('Checking studio-mac…');
  });

  it('says its controls show once it answers when it is not being checked', async () => {
    const { tab } = tabFor({}, { machine: null, checking: false });
    await show(<OnboardingControlsStep tab={tab} />);
    expect(text('[data-onboarding-reading="controls"]')).toBe('studio-mac’s controls show once it answers.');
  });

  it('renders the agent controls and the default runtime of a machine that answered', async () => {
    const { tab } = tabFor({
      '/v1/fleet/runtimes': runtimes([runtimeView('claude-default'), runtimeView('claude-review')]),
    });
    await show(<OnboardingControlsStep tab={tab} />);
    expect(text('[data-onboarding-step-body="controls"]')).toContain('What ferrets on studio-mac may control');
    expect(q('[data-setup-section="agent-control"]')).not.toBeNull();
    expect(q('[data-setup-section="default-runtime"]')).not.toBeNull();
    expect(q('[data-setup-choice="claude-review"]')).not.toBeNull();
  });
});

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

describe('OnboardingDoneStep', () => {
  const SET: OnboardingDoneRow = { id: 'claude', label: 'Claude Code', state: 'set', detail: 'claude-default' };
  const SKIPPED: OnboardingDoneRow = {
    id: 'speedups',
    label: 'Speed-ups',
    state: 'skipped',
    later: '#settings/studio/speedups',
  };
  const UNVISITED: OnboardingDoneRow = {
    id: 'warden',
    label: 'Warden',
    state: 'not visited',
    detail: 'Rules only',
    later: '#settings/studio/warden',
  };

  const done = async (rows: readonly OnboardingDoneRow[], navigated: string[] = []) =>
    show(<OnboardingDoneStep rows={rows} machineName="studio-mac" onNavigate={to => navigated.push(to)} />);

  const heading = (): string => text('[data-onboarding-step-body="done"] > p');

  it('says the machine is ready when nothing is left for later', async () => {
    await done([SET]);
    expect(heading()).toBe('studio-mac is ready.');
    expect(q('[data-onboarding-later]')).toBeNull();
  });

  it('says one step is left for later', async () => {
    await done([SET, SKIPPED]);
    expect(heading()).toBe('studio-mac is ready. One step is left for later.');
  });

  it('counts the steps left for later', async () => {
    await done([SET, SKIPPED, UNVISITED]);
    expect(heading()).toBe('studio-mac is ready. 2 steps are left for later.');
  });

  it('lists each step with its state, tone and detail', async () => {
    await done([SET, SKIPPED, UNVISITED]);
    const row = (id: string) => must(q(`[data-onboarding-summary-row="${id}"]`), `the ${id} row`);
    expect(row('claude').getAttribute('data-state')).toBe('set');
    expect(row('claude').querySelector('.kt-badge')?.getAttribute('data-tone')).toBe('ok');
    expect(row('claude').textContent).toContain('claude-default');
    expect(row('claude').querySelector('[data-onboarding-later]')).toBeNull();
    expect(row('speedups').querySelector('.kt-badge')?.getAttribute('data-tone')).toBe('warn');
    expect(row('speedups').textContent).not.toContain('Rules only');
    expect(row('warden').querySelector('.kt-badge')?.getAttribute('data-tone')).toBe('pend');
    expect(row('warden').textContent).toContain('Rules only');
  });

  it('puts Create a runtime first, and does not call the machine ready, while it has no runtime', async () => {
    const navigated: string[] = [];
    await show(
      <OnboardingDoneStep
        rows={[SKIPPED]}
        machineName="studio-mac"
        onNavigate={to => navigated.push(to)}
        createRuntimeHref="#settings/studio/runtimes"
      />,
    );
    expect(heading()).toBe('studio-mac has no runtime yet, so nothing can start here.');
    const link = must(q('[data-onboarding-create-runtime]'), 'the create link') as HTMLAnchorElement;
    expect(link.textContent).toBe('Create a runtime');
    expect(link.getAttribute('data-variant')).toBe('primary');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await interact(() => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(navigated).toEqual(['#settings/studio/runtimes']);
  });

  it('offers no Create a runtime once a runtime exists', async () => {
    await done([SET]);
    expect(q('[data-onboarding-create-runtime]')).toBeNull();
  });

  it('links a step left for later to Settings, navigating in the app instead of the browser', async () => {
    const navigated: string[] = [];
    await done([SET, SKIPPED, UNVISITED], navigated);
    const link = must(q('[data-onboarding-later="speedups"]'), 'the link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#settings/studio/speedups');
    expect(link.textContent).toBe('Set up later');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await interact(() => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(navigated).toEqual(['#settings/studio/speedups']);
  });
});
