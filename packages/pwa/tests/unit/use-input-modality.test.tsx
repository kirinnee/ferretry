import { describe, expect, it } from 'bun:test';
import '../support/dom.ts';
import {
  createInputModalityStore,
  readInputModality,
  resolveInputModality,
  type InputModalitySignals,
  type InputModalitySource,
  useInputModality,
} from '../../src/hooks/use-input-modality.ts';
import { mount } from '../support/dom.ts';

const queries = {
  finePrimary: '(pointer: fine)',
  coarsePrimary: '(pointer: coarse)',
  hoverPrimary: '(hover: hover)',
  noHoverPrimary: '(hover: none)',
  anyCoarse: '(any-pointer: coarse)',
} as const;

const desktopSignals = (overrides: Partial<InputModalitySignals> = {}): InputModalitySignals => ({
  finePrimary: true,
  coarsePrimary: false,
  hoverPrimary: true,
  noHoverPrimary: false,
  anyCoarse: false,
  lastPointerType: null,
  ...overrides,
});

class FakeMediaQuery {
  readonly listeners = new Set<() => void>();
  addCount = 0;
  removeCount = 0;

  constructor(public matches: boolean) {}

  addEventListener(_type: 'change', listener: () => void): void {
    this.addCount += 1;
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  set(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
}

class FakeSource implements InputModalitySource {
  readonly media = new Map<string, FakeMediaQuery>([
    [queries.finePrimary, new FakeMediaQuery(true)],
    [queries.coarsePrimary, new FakeMediaQuery(false)],
    [queries.hoverPrimary, new FakeMediaQuery(true)],
    [queries.noHoverPrimary, new FakeMediaQuery(false)],
    [queries.anyCoarse, new FakeMediaQuery(false)],
  ]);
  readonly pointers = new Set<(event: { pointerType?: string }) => void>();
  pointerAdds = 0;
  pointerRemoves = 0;

  matchMedia(query: string): FakeMediaQuery {
    const media = this.media.get(query);
    if (media === undefined) throw new Error(`unexpected query ${query}`);
    return media;
  }

  addPointerListener(listener: (event: { pointerType?: string }) => void): void {
    this.pointerAdds += 1;
    this.pointers.add(listener);
  }

  removePointerListener(listener: (event: { pointerType?: string }) => void): void {
    this.pointerRemoves += 1;
    this.pointers.delete(listener);
  }

  pointer(pointerType: string): void {
    for (const listener of this.pointers) listener({ pointerType });
  }
}

describe('resolveInputModality', () => {
  it('uses device capabilities and recent input, never viewport width', () => {
    expect(resolveInputModality(desktopSignals())).toEqual({ touchAffected: false, enterSends: true });
    expect(resolveInputModality(desktopSignals({ anyCoarse: true, lastPointerType: 'mouse' }))).toEqual({
      touchAffected: true,
      enterSends: true,
    });
    expect(resolveInputModality(desktopSignals({ lastPointerType: 'touch' }))).toEqual({
      touchAffected: true,
      enterSends: false,
    });
    expect(
      resolveInputModality({
        finePrimary: null,
        coarsePrimary: null,
        hoverPrimary: null,
        noHoverPrimary: null,
        anyCoarse: null,
        lastPointerType: 'mouse',
      }),
    ).toEqual({ touchAffected: true, enterSends: false });
  });
});

describe('createInputModalityStore', () => {
  it('shares one listener set and updates every reader for pointer and media changes', () => {
    const source = new FakeSource();
    const store = createInputModalityStore(() => source);
    let first = 0;
    let second = 0;
    const cleanFirst = store.subscribe(() => first++);
    const cleanSecond = store.subscribe(() => second++);

    expect(store.read()).toEqual({ touchAffected: false, enterSends: true });
    expect(source.pointerAdds).toBe(1);
    expect([...source.media.values()].every(query => query.addCount === 1)).toBe(true);

    source.pointer('touch');
    expect(store.getSnapshot()).toEqual({ touchAffected: true, enterSends: false });
    source.pointer('mouse');
    source.media.get(queries.coarsePrimary)?.set(true);
    expect(store.getSnapshot()).toEqual({ touchAffected: true, enterSends: false });
    expect(first).toBe(4);
    expect(second).toBe(3);

    cleanFirst();
    cleanSecond();
    store.dispose();
    expect(source.pointerRemoves).toBe(1);
    expect([...source.media.values()].every(query => query.removeCount === 1)).toBe(true);
  });

  it('stays conservative without a browser port or when probes fail', () => {
    const missing = createInputModalityStore(() => null);
    expect(missing.read()).toEqual({ touchAffected: true, enterSends: false });
    missing.dispose();

    const source = new FakeSource();
    source.matchMedia = () => {
      throw new Error('probe failed');
    };
    const failed = createInputModalityStore(() => source);
    failed.subscribe(() => {});
    source.pointer('mouse');
    expect(failed.read()).toEqual({ touchAffected: true, enterSends: false });
    failed.dispose();
  });
});

const Probe = () => {
  const state = useInputModality();
  return <span data-touch={String(state.touchAffected)} data-enter={String(state.enterSends)} />;
};

describe('useInputModality', () => {
  it('renders the browser-backed shared snapshot', async () => {
    const view = await mount(<Probe />);
    expect(view.container.querySelector('span')?.getAttribute('data-touch')).toBe(
      String(readInputModality().touchAffected),
    );
    expect(view.container.querySelector('span')?.getAttribute('data-enter')).toBe(
      String(readInputModality().enterSends),
    );
    await view.unmount();
  });
});
