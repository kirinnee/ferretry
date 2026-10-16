/**
 * Proves the voice engine choice: Parakeet's install step renders every phase with the sizes,
 * controls and alerts a person needs, and the two-engine radio group states its three active notes
 * (the "audio never leaves" promise only while Parakeet is chosen), discloses where browser voice
 * sends audio, and reports a browser engine that cannot run.
 */

import { describe, expect, it } from 'bun:test';
import {
  BROWSER_ACTIVE_NOTE,
  BROWSER_ENGINE_DISCLOSURE,
  BROWSER_ENGINE_LABEL,
  NO_ENGINE_NOTE,
  PARAKEET_ACTIVE_NOTE,
  PARAKEET_ENGINE_LABEL,
  ParakeetInstallStep,
  VoiceEngineChoice,
} from '../../../../src/features/settings/voice-engine-choice.tsx';
import type { ParakeetInstallSnapshot, ParakeetVoice } from '../../../../src/lib/stt/parakeet-voice.ts';
import { AVAILABLE_RECOGNITION, UNSUPPORTED_RECOGNITION } from '../../../support/browser-recognition.ts';
import { interact, mount, must } from '../../../support/dom.ts';

const MB = 1_000_000;

class FakeVoice {
  snapshot: ParakeetInstallSnapshot;
  readonly calls: string[] = [];
  readonly listeners = new Set<() => void>();

  constructor(snapshot: ParakeetInstallSnapshot) {
    this.snapshot = snapshot;
  }

  readonly getSnapshot = (): ParakeetInstallSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  refresh(): Promise<void> {
    this.calls.push('refresh');
    return Promise.resolve();
  }
  install(): Promise<void> {
    this.calls.push('install');
    return Promise.resolve();
  }
  cancel(): void {
    this.calls.push('cancel');
  }
  remove(): Promise<void> {
    this.calls.push('remove');
    return Promise.resolve();
  }
  asVoice(): ParakeetVoice {
    return this as unknown as ParakeetVoice;
  }
}

const snap = (
  overrides: Partial<ParakeetInstallSnapshot> & Pick<ParakeetInstallSnapshot, 'phase'>,
): ParakeetInstallSnapshot => ({
  totalBytes: 683 * MB,
  downloadedBytes: 0,
  ...overrides,
});

const button = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
      (candidate.textContent ?? '').includes(text),
    ) ?? null,
    `the "${text}" button`,
  );

const click = (element: HTMLElement) =>
  interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

describe('<ParakeetInstallStep>', () => {
  it('says why Parakeet is unsupported', async () => {
    const voice = new FakeVoice(snap({ phase: 'unsupported', reason: 'No WebAssembly here.' }));
    const view = await mount(<ParakeetInstallStep voice={voice.asVoice()} />);
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('No WebAssembly here.');
    expect(view.container.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('offers the install with its size, and calls install', async () => {
    const voice = new FakeVoice(snap({ phase: 'absent' }));
    const view = await mount(<ParakeetInstallStep voice={voice.asVoice()} />);
    const install = button(view.container, 'Install Parakeet (about 683 MB)');
    expect(install.disabled).toBe(false);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await click(install);
    expect(voice.calls).toContain('install');
    await view.unmount();
  });

  it('offers resume with what is left, and discard calls remove', async () => {
    const voice = new FakeVoice(snap({ phase: 'partial', downloadedBytes: 200 * MB }));
    const view = await mount(<ParakeetInstallStep voice={voice.asVoice()} />);
    expect(view.container.textContent).toContain('200 MB of 683 MB downloaded');
    await click(button(view.container, 'Resume download (483 MB left)'));
    expect(voice.calls).toContain('install');
    await click(button(view.container, 'Discard partial download'));
    expect(voice.calls).toContain('remove');
    await view.unmount();
  });

  it('shows a failed install as an alert', async () => {
    const voice = new FakeVoice(
      snap({ phase: 'absent', error: { code: 'network', message: 'The download stopped.' } }),
    );
    const view = await mount(<ParakeetInstallStep voice={voice.asVoice()} />);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('The download stopped.');
    await view.unmount();
  });

  it('disables the button while checking or removing', async () => {
    const checking = new FakeVoice(snap({ phase: 'checking' }));
    const first = await mount(<ParakeetInstallStep voice={checking.asVoice()} />);
    const wait = button(first.container, 'Checking this device…');
    expect(wait.disabled).toBe(true);
    await first.unmount();
    const removing = new FakeVoice(snap({ phase: 'removing' }));
    const second = await mount(<ParakeetInstallStep voice={removing.asVoice()} />);
    expect(button(second.container, 'Removing…').disabled).toBe(true);
    await second.unmount();
  });

  it('shows progress with a lowercase label and Cancel', async () => {
    const voice = new FakeVoice(snap({ phase: 'installing', downloadedBytes: 341 * MB, label: 'Encoder Weights' }));
    const view = await mount(<ParakeetInstallStep voice={voice.asVoice()} />);
    const bar = must(view.container.querySelector('[role="progressbar"]'), 'the progress bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('49');
    expect(view.container.textContent).toContain('Downloading encoder weights…');
    expect(view.container.textContent).toContain('341 MB of 683 MB');
    await click(button(view.container, 'Cancel'));
    expect(voice.calls).toContain('cancel');
    await view.unmount();
  });

  it('shows progress with no label, and a zero total as zero percent', async () => {
    const voice = new FakeVoice(snap({ phase: 'installing', downloadedBytes: 10 * MB }));
    const view = await mount(<ParakeetInstallStep voice={voice.asVoice()} />);
    expect(view.container.textContent).toContain('Downloading…');
    await view.unmount();
    const empty = new FakeVoice(snap({ phase: 'installing', totalBytes: 0 }));
    const second = await mount(<ParakeetInstallStep voice={empty.asVoice()} />);
    expect(second.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    await second.unmount();
  });

  it('shows the installed version, size and date, and removes only after confirming', async () => {
    const voice = new FakeVoice(
      snap({
        phase: 'installed',
        downloadedBytes: 683 * MB,
        version: 'v3-int8',
        installedAt: '2026-10-16T00:00:00.000Z',
      }),
    );
    const view = await mount(<ParakeetInstallStep voice={voice.asVoice()} />);
    expect(view.container.textContent).toContain('Installed on this device.');
    expect(view.container.textContent).toContain('v3-int8');
    expect(view.container.textContent).toContain('683 MB');
    expect(view.container.textContent).toContain('2026');
    await click(button(view.container, 'Remove from this device'));
    expect(view.container.textContent).toContain('Remove 683 MB from this device?');
    await click(button(view.container, 'Keep it'));
    expect(voice.calls).not.toContain('remove');
    expect(view.container.textContent).not.toContain('Remove 683 MB');
    await click(button(view.container, 'Remove from this device'));
    const confirm = must(
      [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Remove') ??
        null,
      'the confirming Remove button',
    );
    await click(confirm);
    expect(voice.calls).toContain('remove');
    expect(view.container.textContent).not.toContain('Remove 683 MB');
    await view.unmount();
  });

  it('shows an unreadable install date verbatim, and no date row without one', async () => {
    const odd = new FakeVoice(snap({ phase: 'installed', version: 'v3', installedAt: 'last Tuesday' }));
    const first = await mount(<ParakeetInstallStep voice={odd.asVoice()} />);
    expect(first.container.textContent).toContain('last Tuesday');
    await first.unmount();
    const undated = new FakeVoice(snap({ phase: 'installed', version: 'v3' }));
    const second = await mount(<ParakeetInstallStep voice={undated.asVoice()} />);
    expect(second.container.textContent).not.toContain('Installed' + 'last');
    expect([...second.container.querySelectorAll('dt')].map(node => node.textContent)).toEqual(['Version', 'Size']);
    await second.unmount();
  });

  it('reads a missing voice as unsupported', async () => {
    const view = await mount(<ParakeetInstallStep voice={null} />);
    expect(view.container.textContent).toContain('not available in this copy of Ferretry');
    await view.unmount();
  });
});

describe('<VoiceEngineChoice>', () => {
  const choice = (
    value: 'parakeet' | 'browser' | null,
    voice: FakeVoice | null,
    onChange: (id: string) => void = () => undefined,
  ) => (
    <VoiceEngineChoice
      value={value}
      onChange={onChange}
      voice={voice?.asVoice() ?? null}
      browserSupport={AVAILABLE_RECOGNITION}
    />
  );

  it('asks for a choice when none has been made, and makes no privacy promise', async () => {
    const voice = new FakeVoice(snap({ phase: 'absent' }));
    const view = await mount(choice(null, voice));
    expect(view.container.textContent).toContain(NO_ENGINE_NOTE);
    expect(view.container.textContent).not.toContain('audio never leaves');
    expect(view.container.textContent).toContain(PARAKEET_ENGINE_LABEL);
    expect(view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked').length).toBe(0);
    await view.unmount();
  });

  it('makes the privacy promise only while Parakeet is chosen', async () => {
    const voice = new FakeVoice(snap({ phase: 'absent' }));
    const view = await mount(choice('parakeet', voice));
    expect(view.container.textContent).toContain(PARAKEET_ACTIVE_NOTE);
    expect(view.container.textContent).toContain('audio never leaves');
    expect(view.container.querySelector<HTMLInputElement>('input[value="parakeet"]')?.checked).toBe(true);
    await view.unmount();
  });

  it('says where the audio goes while browser voice is chosen', async () => {
    const voice = new FakeVoice(snap({ phase: 'absent' }));
    const view = await mount(choice('browser', voice));
    expect(view.container.textContent).toContain(BROWSER_ACTIVE_NOTE);
    expect(view.container.textContent).not.toContain('audio never leaves');
    expect(view.container.querySelector<HTMLInputElement>('input[value="browser"]')?.checked).toBe(true);
    await view.unmount();
  });

  it('puts the disclosure in the browser option label', async () => {
    const view = await mount(choice(null, null));
    expect(view.container.textContent).toContain(`${BROWSER_ENGINE_LABEL} (${BROWSER_ENGINE_DISCLOSURE})`);
    await view.unmount();
  });

  it('reports the chosen engine on change', async () => {
    const voice = new FakeVoice(snap({ phase: 'absent' }));
    const chosen: string[] = [];
    const view = await mount(choice(null, voice, id => chosen.push(id)));
    await click(must(view.container.querySelector<HTMLInputElement>('input[value="browser"]'), 'the browser radio'));
    await click(must(view.container.querySelector<HTMLInputElement>('input[value="parakeet"]'), 'the Parakeet radio'));
    expect(chosen).toEqual(['browser', 'parakeet']);
    await view.unmount();
  });

  it('shows why browser voice is unavailable', async () => {
    const view = await mount(
      <VoiceEngineChoice
        value={null}
        onChange={() => undefined}
        voice={null}
        browserSupport={UNSUPPORTED_RECOGNITION}
      />,
    );
    expect(view.container.textContent).toContain(UNSUPPORTED_RECOGNITION.reason ?? 'missing reason');
    await view.unmount();
  });

  it('does not show a browser warning when it works', async () => {
    const view = await mount(choice(null, null));
    expect(view.container.textContent).not.toContain('does not support dictation');
    await view.unmount();
  });
});
