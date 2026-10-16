import { afterEach, describe, expect, it } from 'bun:test';
import { useRef } from 'react';
import {
  CHAT_GUTTER_PROPERTY,
  type GutterObserverFactory,
  scrollbarGutter,
  useChatScrollbarGutter,
} from '../../src/hooks/use-chat-scrollbar-gutter.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

/** A scroller whose box this suite states, because happy-dom lays nothing out. */
const sized = (element: Element, box: { offsetWidth: number; clientWidth: number; clientLeft?: number }): void => {
  for (const [key, value] of Object.entries({ clientLeft: 0, ...box }))
    Object.defineProperty(element, key, { configurable: true, value });
};

interface Recorder {
  readonly factory: GutterObserverFactory;
  readonly observed: Element[];
  disconnected: number;
  fire: () => void;
}

const recorder = (): Recorder => {
  const state: Recorder = {
    observed: [],
    disconnected: 0,
    fire: () => undefined,
    factory: callback => {
      state.fire = callback;
      return {
        observe: target => state.observed.push(target),
        disconnect: () => {
          state.disconnected += 1;
        },
      };
    },
  };
  return state;
};

function Surface({
  sessionKey,
  factory,
  transcript = true,
  attach = true,
}: {
  readonly sessionKey: string;
  readonly factory?: GutterObserverFactory;
  readonly transcript?: boolean;
  readonly attach?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useChatScrollbarGutter(ref, sessionKey, ...(factory === undefined ? [] : [factory]));
  return (
    <div data-surface="" ref={attach ? ref : undefined}>
      {transcript ? (
        <div className="fy-transcript">
          <div className="fy-transcript-content" />
        </div>
      ) : null}
    </div>
  );
}

let view: Mounted | null = null;
const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
afterEach(async () => {
  await view?.unmount();
  view = null;
  if (originalObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalObserver);
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

const gutterOf = (container: HTMLElement): string =>
  (container.querySelector('[data-surface]') as HTMLElement).style.getPropertyValue(CHAT_GUTTER_PROPERTY);

describe('scrollbarGutter', () => {
  it('is what the box spends beyond its client area and borders, never negative', () => {
    expect(scrollbarGutter({ offsetWidth: 600, clientWidth: 589, clientLeft: 0 })).toBe(11);
    expect(scrollbarGutter({ offsetWidth: 602, clientWidth: 589, clientLeft: 1 })).toBe(11);
    expect(scrollbarGutter({ offsetWidth: 600, clientWidth: 600, clientLeft: 0 })).toBe(0);
    expect(scrollbarGutter({ offsetWidth: 0, clientWidth: 4, clientLeft: 0 })).toBe(0);
  });
});

describe('useChatScrollbarGutter', () => {
  it('publishes the transcript scrollbar width and follows it as the transcript grows', async () => {
    const rec = recorder();
    view = await mount(<Surface factory={rec.factory} sessionKey="a" />);
    expect(gutterOf(view.container)).toBe('0px');
    // The surface, the scroller and its content are all watched: a scrollbar appears when content grows.
    expect(rec.observed.map(element => element.className || 'surface')).toEqual([
      'surface',
      'fy-transcript',
      'fy-transcript-content',
    ]);

    sized(view.container.querySelector('.fy-transcript') as Element, { offsetWidth: 640, clientWidth: 629 });
    await interact(() => rec.fire());
    expect(gutterOf(view.container)).toBe('11px');
  });

  it('re-reads its targets for another session, and lets go of the old ones', async () => {
    const rec = recorder();
    view = await mount(<Surface factory={rec.factory} sessionKey="a" />);
    await view.render(<Surface factory={rec.factory} sessionKey="b" />);
    expect(rec.disconnected).toBe(1);
    expect(rec.observed).toHaveLength(6);
  });

  it('writes zero when there is no transcript, and watches only the surface', async () => {
    const rec = recorder();
    view = await mount(<Surface factory={rec.factory} sessionKey="a" transcript={false} />);
    expect(gutterOf(view.container)).toBe('0px');
    expect(rec.observed).toHaveLength(1);
  });

  it('measures once and stays put where the engine has no ResizeObserver', async () => {
    view = await mount(<Surface factory={() => null} sessionKey="a" />);
    expect(gutterOf(view.container)).toBe('0px');
  });

  it('does nothing before the surface is mounted', async () => {
    const rec = recorder();
    view = await mount(<Surface attach={false} factory={rec.factory} sessionKey="a" />);
    expect(gutterOf(view.container)).toBe('');
    expect(rec.observed).toHaveLength(0);
  });

  it('uses the browser ResizeObserver by default, and none where it is missing', async () => {
    const seen: Element[] = [];
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        observe(target: Element) {
          seen.push(target);
        }
        disconnect() {}
      },
    });
    view = await mount(<Surface sessionKey="a" />);
    expect(seen).toHaveLength(3);
    await view.unmount();

    Reflect.deleteProperty(globalThis, 'ResizeObserver');
    view = await mount(<Surface sessionKey="b" />);
    expect(gutterOf(view.container)).toBe('0px');
  });
});
