import { afterEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { ComposerDraftProvider, useComposerDraft } from '../../../src/compose/composer-draft.ts';
import { CONTROLS_KEY, DaemonControlsStore } from '../../../src/compose/controls.ts';
import { deviceControls, useDaemonControls, useDeviceControls } from '../../../src/compose/device-controls.ts';
import { type Mounted, interact, mount } from '@ferretry/app/testing';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the shared device controls', () => {
  it('is one instance for every reader', () => {
    expect(deviceControls()).toBe(deviceControls());
  });

  it('draws the live device controls and writes a patch through the store', async () => {
    const storage = new MemoryStorage();
    const store = new DaemonControlsStore(storage);
    let set: ((patch: { composerVimMode: boolean }) => unknown) | undefined;
    const Reader = () => {
      const controls = useDeviceControls(store);
      set = controls.set;
      return createElement('output', null, controls.device.composerVimMode ? 'vim' : 'plain');
    };
    view = await mount(createElement(Reader));
    expect(view.container.textContent).toBe('plain');
    await interact(() => set?.({ composerVimMode: true }));
    expect(view.container.textContent).toBe('vim');
    expect(JSON.parse(storage.getItem(CONTROLS_KEY) ?? '{}')).toMatchObject({ format: 1 });
  });

  it("reads one daemon's scope and leaves another daemon's alone", async () => {
    const store = new DaemonControlsStore(new MemoryStorage());
    const Reader = ({ daemon }: { readonly daemon: string }) =>
      createElement('output', null, useDaemonControls(daemon, store).controls.projectScope ?? 'none');
    view = await mount(
      createElement('div', null, createElement(Reader, { daemon: 'a' }), createElement(Reader, { daemon: 'b' })),
    );
    await interact(() => store.setControls('a', { projectScope: '/work/a' }));
    expect(view.container.textContent).toBe('/work/anone');
  });
});

describe('the composer draft binding', () => {
  it('is null outside a composer and the binding inside one', async () => {
    const seen: unknown[] = [];
    const Panel = () => {
      seen.push(useComposerDraft()?.draft ?? null);
      return null;
    };
    view = await mount(createElement(Panel));
    await view.unmount();
    view = await mount(
      createElement(
        ComposerDraftProvider,
        { binding: { draft: 'hello', ferretId: 'f1', onDraftChange: () => {} } },
        createElement(Panel),
      ),
    );
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe('hello');
  });
});
