import { afterEach, describe, expect, it } from 'bun:test';
import { TalkToTest } from '../../../../../app/features/settings/talk-to-test.tsx';
import type { MicSource } from '../../../../../app/lib/stream/voice-stream.ts';
import { interact, type Mounted, mount } from '../../../../support/app/dom.ts';

/** Talk to test with a time limit (first-run's is 10 s): it ends the stream by itself, tells the machine, and says so. */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const harness = () => {
  const log = { starts: 0, closed: [] as unknown[], micStopped: 0 };
  const mic: MicSource = {
    start: async () => undefined,
    stop: () => {
      log.micStopped += 1;
    },
  };
  const client = {
    socket: (_route: string, _params: unknown, listeners: { onOpen?: () => void }) => {
      setTimeout(() => listeners.onOpen?.(), 0);
      return {
        send: (frame: string | Uint8Array) => {
          if (typeof frame === 'string') log.starts++;
        },
        close: (code?: number, reason?: string) => void log.closed.push([code, reason]),
      };
    },
  };
  return { log, mic, client };
};
const wait = (ms: number): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, ms)));
const stopButton = (view: Mounted): HTMLElement =>
  view.container.querySelector('[data-voice-talk-stop]') as HTMLElement;
const start = (view: Mounted): HTMLElement => view.container.querySelector('[data-voice-talk-start]') as HTMLElement;

describe('<TalkToTest limitMs>', () => {
  it('says how long it listens, stops by itself at the limit, tells the machine, and says it stopped', async () => {
    const { log, mic, client } = harness();
    mounted = await mount(
      <TalkToTest machine="Studio Mac" client={client as never} createMic={() => mic} limitMs={1_000} />,
    );
    expect(mounted.container.textContent).toContain('Speech check, up to 1 s');
    await interact(() => start(mounted as Mounted).click());
    expect(mounted.container.querySelector('[data-voice-talk-stop]')).not.toBeNull();
    await wait(1_100);
    expect(mounted.container.querySelector('[data-voice-talk-stop]')).toBeNull();
    expect(start(mounted)).not.toBeNull();
    expect(log.closed).toEqual([[1000, 'voice stream ended']]);
    expect(log.micStopped).toBe(1);
    expect(mounted.container.querySelector('[data-voice-outcome]')?.textContent).toBe('Stopped after 1 s.');
  });

  it('without a limit it keeps listening until Stop, and Stop cancels the pending limit', async () => {
    const { log, mic, client } = harness();
    mounted = await mount(<TalkToTest machine="Studio Mac" client={client as never} createMic={() => mic} />);
    expect(mounted.container.textContent).toContain('Speech check');
    expect(mounted.container.textContent).not.toContain('up to');
    await interact(() => start(mounted as Mounted).click());
    await wait(120);
    expect(mounted.container.querySelector('[data-voice-talk-stop]')).not.toBeNull();
    await interact(() => stopButton(mounted as Mounted).click());
    expect(log.closed).toHaveLength(1);
    await mounted.unmount();
    mounted = null;
  });

  it('a stop by the person before the limit leaves no second close behind', async () => {
    const { log, mic, client } = harness();
    mounted = await mount(
      <TalkToTest machine="Studio Mac" client={client as never} createMic={() => mic} limitMs={80} />,
    );
    await interact(() => start(mounted as Mounted).click());
    await interact(() => stopButton(mounted as Mounted).click());
    await wait(160);
    expect(log.closed).toHaveLength(1);
    expect(mounted.container.querySelector('[data-voice-outcome]')).toBeNull();
  });
});
