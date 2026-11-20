/**
 * The engine card and its grid: one radio group where the whole card is the choice, a fixed-height card that never
 * grows, a pop that plays once on the card just chosen, an "i" that opens the long text in place, and an Install button
 * that never changes the choice. Layout (heights) cannot be measured in happy-dom, so the fixed height is pinned in the
 * stylesheet itself, which is the only place it is set.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { EngineCard, type EngineCardProps } from '../../../../../app/features/engine-card/engine-card.tsx';
import {
  chipsOf,
  EngineCardGrid,
  type EngineCardGridProps,
  installViewOf,
} from '../../../../../app/features/engine-card/engine-card-grid.tsx';
import { engineBars } from '../../../../../app/features/engine-card/engine-numbers.ts';
import { PARAKEET_CATALOG_MODEL, onDeviceModel } from '../../../../../app/lib/stt/model-catalog.ts';
import {
  ModelInstallError,
  type ModelInstaller,
  type ModelInstallOptions,
  type ModelStoreStatus,
} from '../../../../../app/lib/stt/model-store.ts';
import { OnDeviceVoice } from '../../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../../app/lib/stt/on-device-voices.ts';
import { AVAILABLE_RECOGNITION, UNSUPPORTED_RECOGNITION } from '../../../../support/app/browser-recognition.ts';
import { interact, mount, must, pressKey } from '../../../../support/app/dom.ts';

const CSS = readFileSync(new URL('../../../../../app/features/engine-card/engine-card.css', import.meta.url), 'utf8');

class Store implements ModelInstaller {
  readonly totalBytes = 86_000_000;
  state: ModelStoreStatus = { state: 'absent' };
  pending: { resolve(): void; reject(error: unknown): void; options: ModelInstallOptions } | null = null;
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.state);
  }
  install(options: ModelInstallOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, options };
    });
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

const ZIPFORMER = must(onDeviceModel('sherpa-zipformer-en'), 'zipformer');

const voiceFor = (store: Store, model = ZIPFORMER) =>
  new OnDeviceVoice({
    model,
    support: { available: true },
    store,
    openSession: () => {
      throw new Error('no session in this suite');
    },
  });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
};

const cardProps = (overrides: Partial<EngineCardProps> = {}): EngineCardProps => ({
  id: 'sherpa-zipformer-en',
  name: 'Sherpa Zipformer',
  line: 'Fastest. Words appear as you speak.',
  bars: engineBars(ZIPFORMER),
  chips: ['Live words', 'On device'],
  details: ['A long paragraph about the engine.', 'Measured on a slow CPU.'],
  selected: false,
  justChosen: false,
  group: 'g',
  onChoose: () => undefined,
  install: { kind: 'none' },
  ...overrides,
});

const gridProps = (overrides: Partial<EngineCardGridProps> = {}): EngineCardGridProps => ({
  value: null,
  onChoose: () => undefined,
  voices: null,
  browserSupport: AVAILABLE_RECOGNITION,
  deviceClass: 'computer',
  ...overrides,
});

const card = (container: HTMLElement, id: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`.fy-engine-card[data-engine="${id}"]`), `the ${id} card`);

describe('<EngineCard>', () => {
  it('is one radio carrying the engine name, with the bars and line as its description', async () => {
    const view = await mount(<EngineCard {...cardProps()} />);
    const radio = must(view.container.querySelector<HTMLInputElement>('input[type="radio"]'), 'the radio');
    expect(radio.getAttribute('aria-label')).toBe('Sherpa Zipformer');
    const describedBy = must(radio.getAttribute('aria-describedby'), 'a description');
    const description = must(document.getElementById(describedBy), 'the description').textContent ?? '';
    expect(description).toContain('Fastest. Words appear as you speak.');
    expect(description).toContain('Speed 0.4 s. Accuracy 52%. Size 86 MB.');
    expect(view.container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Speed 0.4 s, Accuracy 52%, Size 86 MB',
    );
    await view.unmount();
  });

  it('chooses on a press of the card and never nests a control inside a label', async () => {
    const chosen: string[] = [];
    const view = await mount(<EngineCard {...cardProps({ onChoose: id => chosen.push(id) })} />);
    expect(view.container.querySelector('label')).toBeNull();
    await interact(() => must(view.container.querySelector<HTMLInputElement>('input'), 'radio').click());
    expect(chosen).toEqual(['sherpa-zipformer-en']);
    await view.unmount();
  });

  it('opens the long text in place from the "i", closes it with Escape, and hands the focus back', async () => {
    const view = await mount(<EngineCard {...cardProps()} />);
    const info = must(
      view.container.querySelector<HTMLButtonElement>('button[aria-label="About Sherpa Zipformer"]'),
      'i',
    );
    expect(info.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.textContent).not.toContain('A long paragraph about the engine.');
    await interact(() => info.click());
    expect(info.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.textContent).toContain('A long paragraph about the engine.');
    expect(view.container.textContent).toContain('Measured on a slow CPU.');
    await interact(() => pressKey(must(view.container.querySelector('.fy-engine-details'), 'details'), 'Escape'));
    expect(view.container.querySelector('.fy-engine-details')).toBeNull();
    expect(document.activeElement).toBe(info);
    await view.unmount();
  });

  it('draws the selection and the pop only on the card that was just chosen', async () => {
    const view = await mount(<EngineCard {...cardProps({ selected: true })} />);
    const root = must(view.container.querySelector<HTMLElement>('.fy-engine-card'), 'card');
    expect(root.dataset.selected).toBe('true');
    expect(root.dataset.pop).toBe('false');
    await view.render(<EngineCard {...cardProps({ selected: true, justChosen: true })} />);
    expect(root.dataset.pop).toBe('true');
    await view.unmount();
  });

  it('puts the install button inside the card, above the choice, and says its size', async () => {
    let installs = 0;
    const chosen: string[] = [];
    const view = await mount(
      <EngineCard
        {...cardProps({
          onChoose: id => chosen.push(id),
          install: { kind: 'idle', size: '86 MB', onInstall: () => (installs += 1) },
        })}
      />,
    );
    const install = must(view.container.querySelector<HTMLButtonElement>('button[data-state="idle"]'), 'install');
    expect(install.textContent).toContain('Install (86 MB)');
    expect(install.getAttribute('aria-label')).toBe('Install Sherpa Zipformer (86 MB)');
    await interact(() => install.click());
    expect(installs).toBe(1);
    expect(chosen).toEqual([]);
    await view.unmount();
  });

  it('shows a download as a progress bar with Cancel, and an install failure in place of the line', async () => {
    let cancelled = 0;
    const view = await mount(
      <EngineCard
        {...cardProps({
          install: { kind: 'installing', percent: 42, size: '86 MB', onCancel: () => (cancelled += 1) },
        })}
      />,
    );
    const bar = must(view.container.querySelector('[role="progressbar"]'), 'progress');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuetext')).toBe('42% of 86 MB');
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label^="Cancel"]'), 'cancel').click(),
    );
    expect(cancelled).toBe(1);
    await view.render(<EngineCard {...cardProps({ error: 'The encoder stopped downloading.' })} />);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('The encoder stopped downloading.');
    expect(view.container.querySelector('.fy-engine-body')?.textContent).not.toContain('Fastest.');
    await view.unmount();
  });

  it('can be shown but not chosen', async () => {
    const view = await mount(<EngineCard {...cardProps({ disabled: true })} />);
    expect(must(view.container.querySelector<HTMLInputElement>('input'), 'radio').disabled).toBe(true);
    await view.unmount();
  });
});

describe('the engine card stylesheet', () => {
  it('fixes the height at 186 px (a two-line sentence) and wraps its words, so no name or line is cut off', () => {
    expect(CSS).toContain('--fy-engine-height: 186px;');
    expect(CSS).toMatch(/\.fy-engine-card \{[^}]*height: var\(--fy-engine-height\);[^}]*overflow: hidden;/s);
    expect(CSS).toMatch(/\.fy-engine-name \{[^}]*overflow-wrap: anywhere;/s);
    expect(CSS).not.toMatch(/\.fy-engine-(name|line) \{[^}]*text-overflow: ellipsis;/s);
    expect(CSS).toMatch(/\.fy-engine-line \{[^}]*min-height: 36px;[^}]*overflow-wrap: anywhere;/s);
  });

  it('puts at most three cards in a row, at least 240 px each, and stacks them on a phone', () => {
    expect(CSS).toContain('repeat(auto-fit, minmax(max(240px, calc((100% - 2 * var(--fy-engine-gap)) / 3)), 1fr))');
  });

  it('plays the 160 ms pop only on the card just chosen, and not at all when motion is reduced', () => {
    expect(CSS).toContain("[data-pop='true'][data-selected='true']");
    expect(CSS).toContain('animation: fy-engine-pop 160ms ease-out');
    expect(CSS).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
    expect(CSS).toMatch(/:root\[data-motion='reduced'\][^{]*\{[^}]*animation: none/);
  });

  it('draws every card button a full 44 px tall', () => {
    expect(CSS).toMatch(/:root \.fy-engine-mini \{[^}]*min-height: 44px;/s);
    expect(CSS).not.toMatch(/\.fy-engine-none \{[^}]*max-height/s);
  });
});

describe('<EngineCardGrid>', () => {
  it('lists the catalog, the browser voice and Off as one radio group with a single name', async () => {
    const view = await mount(<EngineCardGrid {...gridProps()} />);
    const radios = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(8 + 2);
    expect(new Set(radios.map(radio => radio.name)).size).toBe(1);
    expect(radios.some(radio => radio.checked)).toBe(false);
    expect(radios.every(radio => radio.tabIndex <= 0)).toBe(true);
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(card(view.container, 'off').textContent).toContain('Off');
    expect(card(view.container, 'parakeet').textContent).toContain('Parakeet 0.6B');
    await view.unmount();
  });

  it('draws no bars on the browser voice (nothing measured) and says so, while every on-device card keeps three', async () => {
    const view = await mount(<EngineCardGrid {...gridProps()} />);
    const browser = card(view.container, 'browser');
    expect(browser.querySelector('[data-option-bars]')).toBeNull();
    expect(browser.querySelector('[data-option-bar]')).toBeNull();
    expect(browser.querySelector('.fy-engine-none')?.textContent).toBe('Not measured. Nothing to download.');
    for (const id of ['parakeet', 'sherpa-zipformer-en'])
      expect(card(view.container, id).querySelectorAll('[data-option-bar]')).toHaveLength(3);
    await view.unmount();
  });

  it('tells the stylesheet how many cards it holds, so four sit two by two', async () => {
    const four = await mount(<EngineCardGrid {...gridProps({ models: [ZIPFORMER, PARAKEET_CATALOG_MODEL] })} />);
    expect(must(four.container.querySelector('.fy-engine-grid'), 'grid').getAttribute('data-count')).toBe('4');
    await four.unmount();
    expect(CSS).toMatch(/\.fy-engine-grid\[data-count='4'\]/);
  });

  it('marks the engine a device dictates with by default, per device class', async () => {
    const phone = await mount(<EngineCardGrid {...gridProps({ deviceClass: 'phone' })} />);
    expect(card(phone.container, 'parakeet-tdt-110m').textContent).toContain('Default');
    expect(card(phone.container, 'parakeet').textContent).not.toContain('Default');
    await phone.unmount();
    const computer = await mount(<EngineCardGrid {...gridProps({ deviceClass: 'computer' })} />);
    expect(card(computer.container, 'parakeet-tdt-110m').textContent).toContain('Default');
    expect(card(computer.container, 'parakeet').textContent).not.toContain('Default');
    await computer.unmount();
  });

  it('chooses through one port, and only the card just chosen carries the pop', async () => {
    const chosen: string[] = [];
    const view = await mount(<EngineCardGrid {...gridProps({ onChoose: choice => chosen.push(choice) })} />);
    await interact(() => must(card(view.container, 'off').querySelector<HTMLInputElement>('input'), 'radio').click());
    expect(chosen).toEqual(['off']);
    expect(card(view.container, 'off').dataset.pop).toBe('true');
    expect(card(view.container, 'parakeet').dataset.pop).toBe('false');
    await view.render(<EngineCardGrid {...gridProps({ onChoose: choice => chosen.push(choice), value: 'off' })} />);
    expect(card(view.container, 'off').dataset.selected).toBe('true');
    await view.unmount();
  });

  it('moves the focus on an arrow key and chooses only on Enter, so arrowing over Browser voice sends nothing', async () => {
    const chosen: string[] = [];
    const view = await mount(<EngineCardGrid {...gridProps({ onChoose: choice => chosen.push(choice) })} />);
    const radios = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const usable = radios.filter(radio => !radio.disabled);
    const first = must(usable[0], 'first usable radio');
    const browser = must(card(view.container, 'browser').querySelector<HTMLInputElement>('input'), 'browser radio');
    const off = must(card(view.container, 'off').querySelector<HTMLInputElement>('input'), 'off radio');
    expect(usable.indexOf(browser)).toBe(0);
    first.focus();
    await interact(() => pressKey(first, 'ArrowDown'));
    const second = must(usable[1], 'second usable radio');
    expect(document.activeElement).toBe(second);
    await interact(() => pressKey(second, 'End'));
    expect(document.activeElement).toBe(off);
    await interact(() => pressKey(off, 'Home'));
    expect(document.activeElement).toBe(browser);
    expect(chosen).toEqual([]);
    expect(radios.some(radio => radio.checked)).toBe(false);
    await interact(() => pressKey(browser, 'Enter'));
    expect(chosen).toEqual(['browser']);
    await view.unmount();
  });

  it('lists only the engines it is given, and leaves out the browser voice and Off when asked', async () => {
    const view = await mount(
      <EngineCardGrid {...gridProps({ models: [PARAKEET_CATALOG_MODEL], browser: false, off: false })} />,
    );
    expect(
      [...view.container.querySelectorAll('.fy-engine-card')].map(node => (node as HTMLElement).dataset.engine),
    ).toEqual(['parakeet']);
    await view.unmount();
  });

  it('shows the browser voice but cannot choose it where the browser has no recognition', async () => {
    const view = await mount(<EngineCardGrid {...gridProps({ browserSupport: UNSUPPORTED_RECOGNITION })} />);
    expect(must(card(view.container, 'browser').querySelector<HTMLInputElement>('input'), 'radio').disabled).toBe(true);
    expect(card(view.container, 'browser').textContent).toContain('Not available here');
    await view.unmount();
  });

  it('installs from the card, reports the running download as busy, and clears it when the download ends', async () => {
    const store = new Store();
    const voice = voiceFor(store);
    const busy: (string | null)[] = [];
    const view = await mount(
      <EngineCardGrid
        {...gridProps({ models: [ZIPFORMER], voices: new OnDeviceVoices([voice]), onBusy: label => busy.push(label) })}
      />,
    );
    await settle();
    const zip = card(view.container, 'sherpa-zipformer-en');
    expect(zip.textContent).toContain('Install (86 MB)');
    await interact(() => must(zip.querySelector<HTMLButtonElement>('button[data-state="idle"]'), 'install').click());
    await interact(() =>
      store.pending?.options.onProgress?.({ label: 'Encoder', downloadedBytes: 43_000_000, totalBytes: 86_000_000 }),
    );
    expect(zip.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(busy.at(-1)).toBe('Downloading Sherpa Zipformer…');
    expect(zip.dataset.selected).toBe('false');
    store.state = { state: 'installed', version: 'v1', bytes: 86_000_000, installedAt: '2026-10-22T00:00:00.000Z' };
    await interact(async () => {
      store.pending?.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(zip.textContent).toContain('Installed');
    expect(busy.at(-1)).toBeNull();
    await view.unmount();
  });

  it('says a failed download in place of the line, and that an engine is missing from this build', async () => {
    const store = new Store();
    const voice = voiceFor(store);
    const view = await mount(
      <EngineCardGrid
        {...gridProps({ models: [ZIPFORMER, PARAKEET_CATALOG_MODEL], voices: new OnDeviceVoices([voice]) })}
      />,
    );
    await settle();
    expect(card(view.container, 'parakeet').textContent).toContain('Not available here');
    await interact(() =>
      must(
        card(view.container, 'sherpa-zipformer-en').querySelector<HTMLButtonElement>('button[data-state="idle"]'),
        'install',
      ).click(),
    );
    await interact(async () => {
      store.pending?.reject(new ModelInstallError('network', 'The encoder stopped downloading.'));
      await Promise.resolve();
    });
    await settle();
    expect(card(view.container, 'sherpa-zipformer-en').querySelector('[role="alert"]')?.textContent).toBe(
      'The encoder stopped downloading.',
    );
    await view.unmount();
  });
});

describe('the engine card words', () => {
  it('names the chips from what the catalog says about live words', () => {
    expect(chipsOf(ZIPFORMER)).toEqual(['Live words', 'On device']);
    expect(chipsOf(PARAKEET_CATALOG_MODEL)).toEqual(['Near-live', 'On device']);
  });

  it('reads an install snapshot into the slot a card draws', () => {
    const voice = voiceFor(new Store());
    const base = { totalBytes: 86_000_000, downloadedBytes: 0 };
    expect(installViewOf({ ...base, phase: 'absent' }, voice).kind).toBe('idle');
    expect(installViewOf({ ...base, phase: 'checking' }, voice).kind).toBe('checking');
    expect(installViewOf({ ...base, phase: 'installed' }, voice).kind).toBe('installed');
    expect(installViewOf({ ...base, phase: 'partial', downloadedBytes: 20_000_000 }, voice)).toMatchObject({
      kind: 'partial',
      left: '66 MB',
    });
    expect(installViewOf({ ...base, phase: 'installing', downloadedBytes: 43_000_000 }, voice)).toMatchObject({
      kind: 'installing',
      percent: 50,
    });
    expect(installViewOf({ ...base, phase: 'unsupported', reason: 'No WebAssembly.' }, voice)).toEqual({
      kind: 'unavailable',
      reason: 'No WebAssembly.',
    });
  });
});
