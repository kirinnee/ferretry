import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ConfigFileView, FleetMachineView, LearningConfig } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactElement } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import type { OnboardingDoneRow } from '../../../../../src/features/fleet/setup/onboarding-model.ts';
import {
  OnboardingDefaultsStep,
  OnboardingDoneStep,
  OnboardingStartStep,
} from '../../../../../src/features/fleet/setup/onboarding-steps.tsx';
import type { MachineTabProps } from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import type { ParakeetInstallSnapshot, ParakeetVoice } from '../../../../../src/lib/stt/parakeet-voice.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { config as learningConfig } from '../../../../support/learning.ts';
import { fileView } from '../../config-files/config-files-support.ts';
import {
  APPLY_PATH,
  type Call,
  machineAnswer,
  machineView,
  STAGED,
  STUDIO,
  scriptedClient,
  WORK,
} from './setup-support.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const DESKTOP_WIDTH = 1_280;
const ORIGINAL_WIDTH = typeof window === 'undefined' ? DESKTOP_WIDTH : window.innerWidth;

const setViewport = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

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

// \u2500\u2500 Start from \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

describe('OnboardingStartStep', () => {
  const startStep = (
    start: 'fresh' | 'clone',
    events: string[],
    sources: readonly DaemonConnectionRecord[] = [record(WORK, 'work-linux')],
  ) => {
    const { tab } = tabFor({ '/v1/fleet/profiles': { format: 'version-2', profiles: [] } });
    return (
      <OnboardingStartStep
        start={start}
        onStart={choice => events.push(choice)}
        sources={sources}
        tab={tab}
        onFresh={() => events.push('fresh!')}
        onCloned={() => events.push('cloned')}
        onCopied={source => events.push(`copied ${source}`)}
      />
    );
  };

  it('shows two cards that are the actions, and no radio, checkbox or Continue of its own', async () => {
    await show(startStep('fresh', []));
    expect(text('[data-start-card="fresh"]')).toContain('Start fresh');
    expect(text('[data-start-card="fresh"]')).toContain('Bring in Claude Code and Codex, one tap each.');
    expect(text('[data-start-card="clone"]')).toContain('Copy work-linux');
    expect(text('[data-start-card="clone"]')).toContain('Never secrets or logins.');
    expect(view?.container.querySelectorAll('input')).toHaveLength(0);
    expect(view?.container.querySelectorAll('[data-onboarding-primary]')).toHaveLength(0);
  });

  it('moves on when Start fresh is tapped', async () => {
    const events: string[] = [];
    await show(startStep('fresh', events));
    await click(q('[data-start-card="fresh"]'), 'Start fresh');
    expect(events).toEqual(['fresh!']);
  });

  it('opens the Copy flow when the copy card is tapped', async () => {
    const events: string[] = [];
    await show(startStep('fresh', events));
    await click(q('[data-start-card="clone"]'), 'the copy card');
    expect(events).toEqual(['clone']);
  });

  it('names no single machine when there are several to copy', async () => {
    await show(startStep('fresh', [], [record(WORK, 'work-linux'), record(STUDIO, 'studio-two')]));
    expect(text('[data-start-card="clone"]')).toContain('Copy another machine');
  });

  it('embeds the Copy flow when copying, with no step list, no \u201CStep n of m\u201D and no title of its own', async () => {
    await show(startStep('clone', []));
    expect(q('[data-start-card]')).toBeNull();
    const body = must(q('[data-onboarding-step-body="start"]'), 'the start body');
    expect(body.querySelector('[data-presentation="embedded"]')).not.toBeNull();
    expect(body.textContent).not.toMatch(/Step \d+ of \d+/);
    expect(body.querySelector('#machine-stepper-title')).toBeNull();
    expect(body.querySelector('[data-stepper-back]')).toBeNull();
    expect(body.querySelector('[data-stepper-cancel]')).toBeNull();
  });
});

// \u2500\u2500 Defaults \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

describe('OnboardingDefaultsStep', () => {
  const VOICE_FILE_PATH = '/v1/config/file?path=voice.yaml';
  const PUT_PATH = '/v1/config/file';
  const LEARNING = '/v1/learning/config';
  const voiceFile = (text: string, etag = 'etag-voice-1'): ConfigFileView =>
    fileView({ path: 'voice.yaml', kind: 'voice', schema: 'voice', text, etag });
  const PUT_RESULT = { path: 'voice.yaml', etag: 'etag-voice-2', outcome: 'applied' };
  const learning = (passiveDefault: boolean): LearningConfig => learningConfig({ passiveDefault });

  const parakeet = (phase: ParakeetInstallSnapshot['phase']) => {
    const installs = { count: 0 };
    const snapshot = { phase, totalBytes: 683_000_000, downloadedBytes: 0 } as ParakeetInstallSnapshot;
    const voice = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      refresh: async () => undefined,
      install: async () => {
        installs.count += 1;
      },
    } as unknown as ParakeetVoice;
    return { voice, installs };
  };

  const READS = {
    [VOICE_FILE_PATH]: voiceFile('# mine\ndefaultEngine: browser\n'),
    [PUT_PATH]: PUT_RESULT,
    [LEARNING]: byMethod(learning(true), learning(false)),
    '/v1/fleet/proposals': STAGED,
    [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'Changed' },
  } as const;

  const defaults = (
    answers: Parameters<typeof tabFor>[0] = READS,
    options: { voice?: ParakeetVoice | null; machine?: FleetMachineView | null; checking?: boolean } = {},
  ) => {
    const made = tabFor(answers, {
      ...(options.machine === undefined ? {} : { machine: options.machine }),
      ...(options.checking === undefined ? {} : { checking: options.checking }),
    });
    const finished = { count: 0, here: [] as boolean[] };
    return {
      ...made,
      finished,
      element: (
        <OnboardingDefaultsStep
          tab={made.tab}
          voice={options.voice === undefined ? null : options.voice}
          onFinished={stillHere => {
            finished.count += 1;
            finished.here.push(stillHere);
          }}
        />
      ),
    };
  };

  const select = () =>
    must(q('select[aria-label="Voice on this device"]') as HTMLSelectElement | null, 'the voice select');
  const pick = async (value: string): Promise<void> => {
    await interact(() => {
      const element = select();
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  };
  const learningBox = () => q('input[aria-label="Learn from my corrections"]') as HTMLInputElement | null;
  const control = (kind: string) => q(`[data-agent-control-kind="${kind}"] input`) as HTMLInputElement | null;
  const useThese = () => buttonLabelled('Use these');
  const writes = (calls: readonly Call[]) => calls.filter(call => call.path === PUT_PATH);
  const learningWrites = (calls: readonly Call[]) =>
    calls.filter(call => call.path === LEARNING && call.body !== undefined);
  const proposals = (calls: readonly Call[]) => calls.filter(call => call.path === '/v1/fleet/proposals');

  it('says these are already set, and shows what the machine has now', async () => {
    const { element } = defaults();
    await show(element);
    expect(text()).toContain('These are already set. Change any, or keep them.');
    expect(select().value).toBe('browser');
    expect(Array.from(select().options).map(option => option.textContent)).toEqual([
      'Browser voice',
      'Parakeet (683 MB, on device)',
      'Each device’s default',
    ]);
    expect(learningBox()?.checked).toBe(true);
    expect(control('terminals')?.checked).toBe(true);
    expect(control('ferretrySettings')?.checked).toBe(false);
    expect(control('pageScripts')?.checked).toBe(false);
    expect(view?.container.querySelectorAll('[data-agent-control-kind]')).toHaveLength(5);
  });

  it('shows the device default, not Off, when voice.yaml names no default — and says voice stays on', async () => {
    const { element } = defaults({ ...READS, [VOICE_FILE_PATH]: voiceFile('# mine\n') });
    await show(element);
    expect(select().value).toBe('device');
    expect(Array.from(select().options).map(option => option.textContent)).not.toContain('Off');
    expect(text('[data-default-row="voice"]')).toContain('Voice stays on');
    expect(text('[data-default-row="voice"]')).toContain('Parakeet on that device');
  });

  it('holds the one primary back while it is still reading', async () => {
    const never = new Promise<void>(() => undefined);
    const made = tabFor(READS, { hold: () => never });
    await show(<OnboardingDefaultsStep tab={made.tab} voice={null} onFinished={() => undefined} />);
    expect(text('[data-onboarding-reading="voice"]')).toBe('Reading studio-mac\u2019s voice settings\u2026');
    expect(useThese().disabled).toBe(true);
  });

  it('has exactly one primary, named Use these', async () => {
    const { element } = defaults();
    await show(element);
    expect(view?.container.querySelectorAll('[data-onboarding-primary]')).toHaveLength(1);
    expect(view?.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
  });

  it('writes nothing, and moves on, when nothing was changed', async () => {
    const { element, calls, finished, retried } = defaults();
    await show(element);
    const before = calls.length;
    await click(useThese(), 'Use these');
    expect(calls.slice(before)).toEqual([]);
    expect(finished.count).toBe(1);
    expect(retried.count).toBe(0);
    expect(finished.here).toEqual([true]);
  });

  it('saves only what changed: learning alone is one PATCH, and nothing else', async () => {
    const { element, calls, finished } = defaults();
    await show(element);
    await click(learningBox(), 'the learning box');
    await click(useThese(), 'Use these');
    expect(learningWrites(calls).map(call => call.body)).toEqual([{ passiveDefault: false }]);
    expect(writes(calls)).toEqual([]);
    expect(proposals(calls)).toEqual([]);
    expect(finished.count).toBe(1);
  });

  it('writes the chosen voice into voice.yaml against the etag it read, keeping the rest of the file', async () => {
    const { element, calls, finished } = defaults();
    await show(element);
    await pick('parakeet');
    await click(useThese(), 'Use these');
    const [put] = writes(calls);
    expect(put?.body).toEqual({ path: 'voice.yaml', text: '# mine\ndefaultEngine: parakeet\n' });
    expect(Object.values(put?.headers ?? {})).toContain('etag-voice-1');
    expect(learningWrites(calls)).toEqual([]);
    expect(finished.count).toBe(1);
  });

  it('clears the machine default by removing the line, keeping the rest', async () => {
    const { element, calls } = defaults();
    await show(element);
    await pick('device');
    await click(useThese(), 'Use these');
    expect(writes(calls)[0]?.body).toMatchObject({ text: '# mine\n' });
  });

  it('starts the Parakeet download only when Parakeet was picked', async () => {
    const picked = parakeet('absent');
    const { element } = defaults(READS, { voice: picked.voice });
    await show(element);
    await click(useThese(), 'Use these with nothing changed');
    expect(picked.installs.count).toBe(0);
    await pick('device');
    await click(useThese(), 'Use these with the device default');
    expect(picked.installs.count).toBe(0);
    await pick('parakeet');
    await click(useThese(), 'Use these with Parakeet');
    expect(picked.installs.count).toBe(1);
  });

  it('does not download Parakeet again when it is already installed', async () => {
    const picked = parakeet('installed');
    const { element } = defaults(READS, { voice: picked.voice });
    await show(element);
    await pick('parakeet');
    await click(useThese(), 'Use these');
    expect(picked.installs.count).toBe(0);
  });

  it('saves a controls change through the reviewed change, then the machine is re-read', async () => {
    const { element, calls, finished, retried } = defaults();
    await show(element);
    await click(control('ferretrySettings'), 'Ferretry settings');
    await click(useThese(), 'Use these');
    const [staged] = proposals(calls);
    expect(staged?.body).toMatchObject({
      change: {
        kind: 'machine.settings',
        agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: true },
      },
    });
    expect(calls.some(call => call.path === APPLY_PATH)).toBe(true);
    expect(retried.count).toBe(1);
    expect(finished.count).toBe(1);
  });

  it('says a passkey will be asked for when this device is not on the machine, and still saves', async () => {
    const { element, calls, finished } = defaults({
      ...READS,
      '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'step-up-required' }),
    });
    await show(element);
    expect(q('[data-change-step-up]')).toBeNull();
    await click(control('files'), 'Files');
    expect(text('[data-change-step-up]')).toBe('studio-mac will ask you to confirm with your passkey when you save.');
    await click(useThese(), 'Use these');
    expect(proposals(calls)).toHaveLength(1);
    expect(finished.count).toBe(1);
  });

  it('stops on the daemon\u2019s refusal, writes nothing else, and does not move on', async () => {
    const { element, calls, finished } = defaults({ ...READS, '/v1/fleet/proposals': refusal() });
    await show(element);
    await click(control('terminals'), 'Terminals');
    await click(learningBox(), 'the learning box');
    await pick('device');
    await click(useThese(), 'Use these');
    expect(text('[data-change-refusal]')).toBe('The machine refused.');
    expect(q('[data-change-refusal]')?.getAttribute('role')).toBe('alert');
    expect(learningWrites(calls)).toEqual([]);
    expect(writes(calls)).toEqual([]);
    expect(finished.count).toBe(0);
  });

  it('shows the machine\u2019s refusal of the learning change, and does not move on', async () => {
    const { element, finished } = defaults({ ...READS, [LEARNING]: byMethod(learning(true), refusal()) });
    await show(element);
    await click(learningBox(), 'the learning box');
    await click(useThese(), 'Use these');
    expect(text('[data-onboarding-defaults-problem]')).toBe('The machine refused.');
    expect(finished.count).toBe(0);
  });

  it('saves only the remainder when Use these is pressed again after a failure', async () => {
    let learningUp = false;
    const { element, calls, finished } = defaults({
      ...READS,
      [LEARNING]: (call: Call) => (call.body === undefined ? learning(true) : learningUp ? learning(false) : refusal()),
    });
    await show(element);
    await pick('device');
    await click(learningBox(), 'the learning box');
    await click(useThese(), 'Use these');
    expect(finished.count).toBe(0);
    learningUp = true;
    await click(useThese(), 'Use these again');
    expect(learningWrites(calls)).toHaveLength(2);
    expect(writes(calls)).toHaveLength(1);
    expect(finished.count).toBe(1);
  });

  it('leaves a row it could not read out of the save, and says so', async () => {
    const { element, calls, finished } = defaults({ ...READS, [VOICE_FILE_PATH]: refusal() });
    await show(element);
    expect(text('[data-default-unread="voice"]')).toContain('Couldn\u2019t read studio-mac\u2019s voice settings.');
    expect(q('select[aria-label="Voice on this device"]')).toBeNull();
    await click(learningBox(), 'the learning box');
    await click(useThese(), 'Use these');
    expect(writes(calls)).toEqual([]);
    expect(learningWrites(calls)).toHaveLength(1);
    expect(finished.count).toBe(1);
  });

  it('leaves both rows out, and says so, when the machine cannot be reached at all', async () => {
    const made = defaults();
    const unreachable = { ...made.tab, createClient: () => Promise.reject(new Error('offline')) };
    await show(<OnboardingDefaultsStep tab={unreachable} voice={null} onFinished={() => made.finished.count++} />);
    expect(q('[data-default-unread="voice"]')).not.toBeNull();
    expect(q('[data-default-unread="learning"]')).not.toBeNull();
  });

  it('says the controls show once the machine answers when it has not', async () => {
    const { element } = defaults(READS, { machine: null, checking: true });
    await show(element);
    expect(text('[data-default-unread="agents"]')).toBe('Checking studio-mac\u2026');
  });
});

// \u2500\u2500 Done \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

describe('OnboardingDoneStep', () => {
  const CLAUDE: OnboardingDoneRow = { id: 'claude', set: true, text: 'Claude Code \u2014 claude-default' };
  const SKIPPED: OnboardingDoneRow = {
    id: 'speedups',
    set: false,
    text: 'Speed-ups skipped',
    later: '#settings/studio/speedups',
  };
  const SENTENCE = 'Defaults: browser voice, learning on, agents may use terminals, browsers and files.';

  const done = async (rows: readonly OnboardingDoneRow[], navigated: string[] = [], notes: readonly string[] = []) =>
    show(
      <OnboardingDoneStep
        rows={rows}
        defaults={SENTENCE}
        changeHref="#settings/studio/agents"
        onNavigate={to => navigated.push(to)}
        notes={notes}
      />,
    );

  it('lists each line with \u2713 or \u2013, and nothing else owns a primary', async () => {
    await done([CLAUDE, SKIPPED]);
    const row = (id: string) => must(q(`[data-onboarding-summary-row="${id}"]`), `the ${id} row`);
    expect(row('claude').textContent).toContain('\u2713 Claude Code \u2014 claude-default');
    expect(row('claude').getAttribute('data-state')).toBe('set');
    expect(row('claude').querySelector('[data-onboarding-later]')).toBeNull();
    expect(row('speedups').textContent).toContain('\u2013 Speed-ups skipped');
    expect(row('speedups').getAttribute('data-state')).toBe('skipped');
    expect(view?.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(0);
  });

  it('names the defaults in one sentence with a Change in Settings link', async () => {
    const navigated: string[] = [];
    await done([CLAUDE], navigated);
    expect(text('[data-onboarding-defaults-sentence]')).toContain(SENTENCE);
    const link = must(q('[data-onboarding-later="defaults"]'), 'the link') as HTMLAnchorElement;
    expect(link.textContent).toBe('Change in Settings');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await interact(() => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(navigated).toEqual(['#settings/studio/agents']);
  });

  it('links a \u2013 line to Settings, navigating in the app instead of the browser', async () => {
    const navigated: string[] = [];
    await done([CLAUDE, SKIPPED], navigated);
    const link = must(q('[data-onboarding-later="speedups"]'), 'the link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#settings/studio/speedups');
    expect(link.textContent).toBe('Set up later');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await interact(() => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(navigated).toEqual(['#settings/studio/speedups']);
  });

  it('lists what the imports left to do, and leaves the list out when there is nothing', async () => {
    await done(
      [CLAUDE],
      [],
      ['Brought in 4 conversations.', 'claude-default still needs a sign-in (Settings \u203A Sign-ins).'],
    );
    const items = Array.from(view?.container.querySelectorAll('[data-onboarding-notes] li') ?? []).map(
      item => item.textContent,
    );
    expect(items).toEqual([
      'Brought in 4 conversations.',
      'claude-default still needs a sign-in (Settings \u203A Sign-ins).',
    ]);
    await view?.unmount();
    await done([CLAUDE]);
    expect(q('[data-onboarding-notes]')).toBeNull();
  });
});
