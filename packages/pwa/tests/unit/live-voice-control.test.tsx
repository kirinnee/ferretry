/**
 * The Live control as a hook returning nodes: what it offers, and that a turn spoken through the REAL
 * take adapter (a fake on-device engine) is cleaned with the page's conversation and shown through the
 * composer bridge. The microphone, the clock and the locks are the fakes of `support/live-ports.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { useLiveVoiceControl, type LiveVoiceControlProps } from '../../src/components/live-voice-control.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { OnDeviceVoice } from '../../src/lib/stt/on-device-voice.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import type { LiveComposerBridge } from '../../src/lib/voice-chat/live-assembly.ts';
import { interact, mount } from '../support/dom.ts';
import { fakeLive } from '../support/live-ports.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceId: 'token-a' });

const bridge = (): LiveComposerBridge & { readonly shown: string[] } => {
  const shown: string[] = [];
  return {
    shown,
    show: words => void shown.push(words),
    clear: () => void shown.push('<cleared>'),
    seal: () => undefined,
    observe: () => () => undefined,
    draft: () => shown.at(-1) ?? '',
    typed: () => '',
    lastShown: () => shown.at(-1) ?? null,
    submit: async () => true,
  };
};

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await interact(async () => await Promise.resolve());
};

const props = (patch: Partial<LiveVoiceControlProps> = {}): LiveVoiceControlProps => ({
  settings: { ...DEFAULT_STT_SETTINGS, engine: 'browser' },
  disabled: false,
  daemon,
  bridge: bridge(),
  draft: '',
  reply: { current: () => null, subscribe: () => () => undefined },
  compact: false,
  busyElsewhere: false,
  commandTarget: null,
  ...patch,
});

function Host(p: {
  readonly props: LiveVoiceControlProps;
  readonly onControl: (c: ReturnType<typeof useLiveVoiceControl>) => void;
}) {
  const control = useLiveVoiceControl(p.props);
  p.onControl(control);
  return (
    <div>
      {control.button}
      {control.bar}
    </div>
  );
}

describe('useLiveVoiceControl', () => {
  it('offers no button where Live is not offered: dictation off, no session to watch, or no right to send', async () => {
    for (const patch of [
      { settings: undefined },
      { settings: { ...DEFAULT_STT_SETTINGS, enabled: false } },
      { reply: undefined },
      { disabled: true },
    ] as Partial<LiveVoiceControlProps>[]) {
      const view = await mount(<Host props={props(patch)} onControl={() => undefined} />);
      expect(view.container.querySelector('button[aria-label="Live voice"]')).toBeNull();
      await view.unmount();
    }
  });

  it('is the 44 px icon on a phone and on a desktop, so it fits a narrow agent pane', async () => {
    const compact = await mount(
      <Host props={props({ compact: true, shortcutHint: '⌥L' })} onControl={() => undefined} />,
    );
    const phone = compact.container.querySelector('button[aria-label="Live voice"]');
    expect(phone?.textContent).toBe('');
    expect(phone?.getAttribute('title')).toContain('⌥L');
    await compact.unmount();
    const desktop = await mount(<Host props={props()} onControl={() => undefined} />);
    expect(desktop.container.querySelector('button[aria-label="Live voice"]')?.textContent).toBe('');
    await desktop.unmount();
  });

  it('hears a turn through the real take, cleans it with the page conversation, and shows it in the composer', async () => {
    const fake = fakeLive();
    // The real take adapter and the real composer bridge: only the world around them is fake.
    const { take: _take, send: _send, ...ports } = fake.ports;
    const composer = bridge();
    const asked: boolean[] = [];
    const voice = {
      support: { available: true },
      createSession: () => ({
        start: () => undefined,
        cancel: () => undefined,
        finish: async () => 'run kteem now',
      }),
    } as unknown as OnDeviceVoice;
    const seen: boolean[] = [];
    let control: ReturnType<typeof useLiveVoiceControl> | null = null;
    const view = await mount(
      <Host
        props={props({
          settings: {
            ...DEFAULT_STT_SETTINGS,
            engine: 'parakeet',
            enhancement: true,
            enhancementProvider: 'local',
            dictionary: ['kteam = kteem'],
          },
          bridge: composer,
          readConversation: () => {
            asked.push(true);
            return ['one', 'two', 'three', 'four', 'five'];
          },
          onActiveChange: active => void seen.push(active),
          seams: { ports, voice },
        })}
        onControl={next => (control = next)}
      />,
    );
    await interact(() => (control as ReturnType<typeof useLiveVoiceControl> | null)?.live.start());
    await flush();
    await interact(async () => {
      fake.hear(0.1, 600);
      fake.hear(0.001, 1_520);
      await Promise.resolve();
    });
    await flush();
    expect(composer.shown.at(-1)).toBe('run kteam now');
    expect(asked.length).toBeGreaterThan(0);
    expect(seen).toContain(true);
    await interact(() => (control as ReturnType<typeof useLiveVoiceControl> | null)?.live.end());
    expect(seen.at(-1)).toBe(false);
    await view.unmount();
  });

  it('a control that leaves while Live is ON tells the page Live is off, and hands over the phase it was in', async () => {
    const fake = fakeLive();
    const seen: boolean[] = [];
    const retired: string[] = [];
    let control: ReturnType<typeof useLiveVoiceControl> | null = null;
    const view = await mount(
      <Host
        props={props({
          onActiveChange: active => void seen.push(active),
          onRetire: phase => void retired.push(phase),
          seams: { ports: fake.ports },
        })}
        onControl={next => (control = next)}
      />,
    );
    await interact(() => (control as ReturnType<typeof useLiveVoiceControl> | null)?.live.start());
    await flush();
    expect(seen.at(-1)).toBe(true);
    await view.unmount();
    expect(retired).toEqual(['listening']);
    expect(seen.at(-1)).toBe(false);
  });

  it('a control that leaves with Live OFF retires nothing', async () => {
    const retired: string[] = [];
    const view = await mount(
      <Host props={props({ onRetire: phase => void retired.push(phase) })} onControl={() => undefined} />,
    );
    await view.unmount();
    expect(retired).toEqual([]);
  });

  it('answers the palette request itself, but not while the mic is busy', async () => {
    const fake = fakeLive();
    const target = new EventTarget();
    let control: ReturnType<typeof useLiveVoiceControl> | null = null;
    const view = await mount(
      <Host
        props={props({ commandTarget: target, seams: { ports: fake.ports } })}
        onControl={next => (control = next)}
      />,
    );
    await interact(() => void target.dispatchEvent(new Event('fy:live-voice-toggle')));
    await flush();
    expect((control as ReturnType<typeof useLiveVoiceControl> | null)?.live.active).toBe(true);
    await interact(() => void target.dispatchEvent(new Event('fy:live-voice-toggle')));
    await flush();
    expect((control as ReturnType<typeof useLiveVoiceControl> | null)?.live.active).toBe(false);
    await view.render(
      <Host
        props={props({ commandTarget: target, busyElsewhere: true, seams: { ports: fake.ports } })}
        onControl={next => (control = next)}
      />,
    );
    await interact(() => void target.dispatchEvent(new Event('fy:live-voice-toggle')));
    await flush();
    expect((control as ReturnType<typeof useLiveVoiceControl> | null)?.live.active).toBe(false);
    await view.unmount();
  });
});
