/**
 * Proves the Live hook is only composition: it starts the runner from the tap, mirrors its phase into a
 * view, pauses when the composer text changes under it (the person typing), ends when it can no longer
 * be offered or the page leaves, lets a refusal go after its time, and — with no ports handed in —
 * assembles the real ones from what the page holds, refusing with words when no engine was chosen.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { useEffect } from 'react';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';
import {
  type LiveVoiceHandle,
  NOTICE_MS,
  type UseLiveVoiceOptions,
  useLiveVoice,
} from '../../src/hooks/use-live-voice.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import type { LiveComposerBridge } from '../../src/lib/voice-chat/live-assembly.ts';
import { interact, mount } from '../support/dom.ts';
import { type FakeLive, fakeLive } from '../support/live-ports.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceId: 'token-a' });

const bridge = (lastShown: string | null = null): LiveComposerBridge => ({
  show: () => undefined,
  clear: () => undefined,
  draft: () => '',
  typed: () => '',
  lastShown: () => lastShown,
  submit: async () => true,
});

const options = (patch: Partial<UseLiveVoiceOptions> = {}): UseLiveVoiceOptions => ({
  enabled: true,
  daemon,
  settings: { ...DEFAULT_STT_SETTINGS, engine: 'browser' } as SttSettings,
  composer: bridge(),
  draft: '',
  reply: { current: () => null, subscribe: () => () => undefined },
  readContext: () => [],
  ...patch,
});

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await interact(async () => await Promise.resolve());
};

function Host(props: { readonly options: UseLiveVoiceOptions; readonly onHandle: (handle: LiveVoiceHandle) => void }) {
  const handle = useLiveVoice(props.options);
  useEffect(() => {
    props.onHandle(handle);
  });
  return <output data-phase={handle.view.phase} data-active={String(handle.active)} />;
}

const rig = async (fake: FakeLive, patch: Partial<UseLiveVoiceOptions> = {}) => {
  let handle: LiveVoiceHandle | null = null;
  const view = await mount(
    <Host options={options({ ports: fake.ports, ...patch })} onHandle={next => (handle = next)} />,
  );
  const get = (): LiveVoiceHandle => {
    if (handle === null) throw new Error('the hook has not rendered');
    return handle;
  };
  const rerender = async (next: Partial<UseLiveVoiceOptions>): Promise<void> =>
    await view.render(
      <Host options={options({ ports: fake.ports, ...patch, ...next })} onHandle={h => (handle = h)} />,
    );
  return { view, get, rerender };
};

describe('useLiveVoice', () => {
  // Time moves only when a test moves it: a refusal's ten seconds must not pass while it is still read.
  // (Inside the describe: a top-level hook would also run for every other file in the same process.)
  beforeEach(() => unitClock.hold());

  it('starts from the tap, mirrors the loop into a view, and ends cleanly', async () => {
    const fake = fakeLive();
    const { view, get } = await rig(fake);
    expect(get().available).toBe(true);
    expect(get().active).toBe(false);
    expect(get().view.visible).toBe(false);
    await interact(() => get().start());
    await flush();
    expect(get().active).toBe(true);
    expect(get().view.stateWord).toBe('Listening');
    expect(get().screenMayTurnOff).toBe(false);
    expect(fake.log).toContain('take.start');
    await interact(() => get().hold());
    expect(get().view.stateWord).toBe('On hold');
    await interact(() => get().resume());
    await flush();
    expect(get().view.stateWord).toBe('Listening');
    await interact(() => get().skip());
    await interact(() => get().sendNow());
    await interact(() => get().end());
    expect(get().active).toBe(false);
    expect(get().levels).toEqual([]);
    await view.unmount();
  });

  it('does nothing when Live is not offered, and ignores a second press while it is on', async () => {
    const off = fakeLive();
    const disabled = await rig(off, { enabled: false });
    expect(disabled.get().available).toBe(false);
    await interact(() => disabled.get().start());
    expect(off.takes.length).toBe(0);
    await disabled.view.unmount();

    const fake = fakeLive();
    const { view, get } = await rig(fake);
    await interact(() => get().start());
    await flush();
    await interact(() => get().start());
    expect(fake.takes.length).toBe(1);
    await view.unmount();
  });

  it('starts afresh after Live ended', async () => {
    const fake = fakeLive();
    const { view, get } = await rig(fake);
    await interact(() => get().start());
    await flush();
    await interact(() => get().end());
    await interact(() => get().start());
    await flush();
    expect(fake.takes.length).toBe(2);
    expect(get().view.stateWord).toBe('Listening');
    await view.unmount();
  });

  it('pauses when the composer text changes under it, and not when it is the words Live put there', async () => {
    const fake = fakeLive();
    const { view, get, rerender } = await rig(fake, { composer: bridge('hello'), draft: '' });
    await interact(() => get().start());
    await flush();
    await rerender({ composer: bridge('hello'), draft: 'hello' });
    expect(get().view.stateWord).toBe('Listening');
    await rerender({ composer: bridge('hello'), draft: 'hello there' });
    expect(get().view.stateWord).toBe('On hold');
    expect(get().view.detail).toContain('Paused while you type');
    await view.unmount();
  });

  it('ignores a changed draft when Live is off', async () => {
    const fake = fakeLive();
    const { view, get, rerender } = await rig(fake);
    await rerender({ draft: 'typing before Live' });
    expect(get().active).toBe(false);
    await view.unmount();
  });

  it('ends when it can no longer be offered, and when the page leaves', async () => {
    const fake = fakeLive();
    const { view, get, rerender } = await rig(fake);
    await interact(() => get().start());
    await flush();
    await rerender({ enabled: false });
    expect(get().active).toBe(false);
    expect(fake.takes[0]?.cancelled).toBe(true);

    const second = fakeLive();
    const next = await rig(second);
    await interact(() => next.get().start());
    await flush();
    await next.view.unmount();
    expect(second.takes[0]?.cancelled).toBe(true);
    await view.unmount();
  });

  it('shows a refusal in words for a while, then lets the bar go', async () => {
    const fake = fakeLive();
    fake.lock.granted = false;
    const { view, get } = await rig(fake);
    await interact(() => get().start());
    await flush();
    expect(get().view.visible).toBe(true);
    expect(get().view.detail).toBe('Live is on in another tab.');
    // The notice leaves after its time (the unit tier runs timers in virtual time).
    await interact(() => unitClock.advance(NOTICE_MS + 50));
    expect(get().view.visible).toBe(false);
    await view.unmount();
  });

  it('repaints while the ferret works and counts the ring', async () => {
    const fake = fakeLive();
    const { view, get } = await rig(fake);
    await interact(() => get().start());
    await flush();
    await interact(async () => {
      fake.hear(0.1, 600);
      fake.hear(0.001, 1_520);
      await Promise.resolve();
    });
    await flush();
    expect(get().view.stateWord).toContain('Sending in');
    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(get().view.stateWord).toMatch(/^Working/);
    await interact(() => unitClock.advance(1_100));
    expect(get().view.workingSeconds).not.toBeNull();
    await view.unmount();
  });
});

describe('useLiveVoice with the ports of the page itself', () => {
  beforeEach(() => unitClock.hold());

  it('refuses with words when no engine was chosen', async () => {
    let handle: LiveVoiceHandle | null = null;
    const view = await mount(
      <Host
        options={options({ settings: { ...DEFAULT_STT_SETTINGS, engine: null }, meter: null })}
        onHandle={next => (handle = next)}
      />,
    );
    await interact(() => (handle as LiveVoiceHandle | null)?.start());
    await flush();
    expect((handle as LiveVoiceHandle | null)?.view.detail).toContain('Pick a voice in Settings');
    await view.unmount();
  });

  it('looks for the chosen on-device engine: handed in, from the store, or none', async () => {
    for (const engine of ['parakeet', 'vosk-small-en'] as const) {
      for (const voice of [undefined, null] as const) {
        let handle: LiveVoiceHandle | null = null;
        const view = await mount(
          <Host
            options={options({
              settings: { ...DEFAULT_STT_SETTINGS, engine },
              ...(voice === undefined ? {} : { voice }),
              meter: null,
            })}
            onHandle={next => (handle = next)}
          />,
        );
        await interact(() => (handle as LiveVoiceHandle | null)?.start());
        await flush();
        expect((handle as LiveVoiceHandle | null)?.view.detail).toContain("isn't installed");
        await view.unmount();
      }
    }
  });
});
