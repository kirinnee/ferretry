import { afterEach, describe, expect, it } from 'bun:test';
import { DEFAULT_PACK_CONFIG, type PackView } from '../../../../../contract/index.ts';
import type { MachinePack, PackRead, PackSave } from '../../../../../app/features/pack/use-machine-pack.ts';
import type { PacksClient } from '../../../../../app/lib/client.ts';
import type { PackConfigPatch } from '../../../../../app/lib/pack/pack-files.ts';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { byText, click, textOf, typeInto, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { IDLE_ROUTING_API, PACK_VIEW } from '../../../support/pack.ts';
import { mockUi, uiDoubles } from '../../../support/ui-doubles.tsx';

mockUi();
const { PACK_SETTINGS_TAB, PackSettingsSurface } = await import('../../../../../app/features/pack/pack-settings.tsx');

const client = { call: () => new Promise(() => undefined) } as unknown as PacksClient;

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

const surface = async (read: PackRead, answer: PackSave = { kind: 'applied' }) => {
  const patches: PackConfigPatch[] = [];
  const state: MachinePack = {
    read,
    saveConfig: async patch => {
      patches.push(patch);
      return answer;
    },
    ...IDLE_ROUTING_API,
  };
  shown = await mount(<PackSettingsSurface client={client} configFiles={uiDoubles.useConfigFiles()} state={state} />);
  return { root: shown.container, patches };
};

const ready = (view: PackView = PACK_VIEW): PackRead => ({ kind: 'ready', view });
const number = (root: HTMLElement, key: string) =>
  must(root.querySelector<HTMLInputElement>(`[data-pack-number="${key}"]`), key);

describe('Settings › Pack mode', () => {
  it('says it is reading, and why it could not', async () => {
    let { root } = await surface({ kind: 'loading' });
    expect(textOf(root)).toContain('Reading Pack mode…');
    await shown?.unmount();
    ({ root } = await surface({ kind: 'failed', message: 'This machine is asleep.' }));
    expect(must(root.querySelector('[role="alert"]'), 'alert').textContent).toBe('This machine is asleep.');
  });

  it('switches Pack mode and the decision mode, and says plainly when a loosening edit is held', async () => {
    const { root, patches } = await surface(ready(), {
      kind: 'pending',
      message: 'Saved, but not in effect until you confirm it: Jev decides.',
    });
    const toggle = must(root.querySelector<HTMLButtonElement>('[data-pack-switch]'), 'switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    await waitFor(() => patches.length === 1, 'the switch save');
    expect(patches[0]).toEqual({ enabled: false });
    await waitForText(root, 'not in effect until you confirm it');
    expect(root.querySelector('[data-pack-outcome]')?.getAttribute('data-pack-outcome')).toBe('pending');

    expect(textOf(must(root.querySelector('[data-pack-jev-cap]'), 'cap'))).toBe('Daily cap: $0.25 (default $0.25)');
    expect(textOf(root)).toContain('Jev is not wired in this build yet: nothing is ranked by it and nothing is spent');
    const jev = must([...root.querySelectorAll<HTMLInputElement>('input[name="pack-decision"]')][1], 'jev');
    await click(jev);
    await waitFor(() => patches.length === 2, 'the decision save');
    expect(patches[1]).toEqual({ decision: 'jev' });
  });

  it('shows Jev’s cap as a setting while Jev decides, and an Off switch', async () => {
    const view: PackView = {
      ...PACK_VIEW,
      config: { ...DEFAULT_PACK_CONFIG, enabled: false, decision: 'jev', jev: { usdPerDay: 1 } },
    };
    const { root, patches } = await surface(ready(view));
    expect(must(root.querySelector('[data-pack-switch]'), 'switch').textContent).toContain('Off');
    const cap = number(root, 'usdPerDay');
    expect(cap.value).toBe('1');
    await typeInto(cap, '2.5');
    await click(byText(root, 'button', 'Save jev cap'));
    await waitFor(() => patches.length === 1, 'the cap save');
    expect(patches[0]).toEqual({ jev: { usdPerDay: 2.5 } });
    expect(root.querySelector('[data-pack-outcome]') === null).toBe(true);
  });

  it('edits the limits and the probe together, refuses an out-of-range number, and discards', async () => {
    const { root, patches } = await surface(ready(), { kind: 'refused', message: 'packs.yaml has a problem.' });
    const save = () => byText<HTMLButtonElement>(root, 'button', 'Save limits');
    expect(number(root, 'interactiveChildren').value).toBe('20');
    expect(save().disabled).toBe(true);
    await typeInto(number(root, 'maxDepth'), '9');
    expect(number(root, 'maxDepth').getAttribute('aria-invalid')).toBe('true');
    expect(textOf(root)).toContain('Between 1 and 4.');
    expect(save().disabled).toBe(true);
    await typeInto(number(root, 'maxDepth'), '1.5');
    expect(save().disabled).toBe(true);
    await click(byText(root, 'button', 'Discard'));
    expect(number(root, 'maxDepth').value).toBe('2');
    await typeInto(number(root, 'maxDepth'), '3');
    await typeInto(number(root, 'autoChildren'), '6');
    await click(save());
    await waitFor(() => patches.length === 1, 'the limits save');
    expect(patches[0]).toEqual({ limits: { maxDepth: 3, autoChildren: 6 } });
    await waitForText(root, 'packs.yaml has a problem.');

    await typeInto(number(root, 'timeoutSeconds'), '60');
    await click(byText(root, 'button', 'Save probe'));
    await waitFor(() => patches.length === 2, 'the probe save');
    expect(patches[1]).toEqual({ probe: { timeoutSeconds: 60 } });
    expect(root.querySelector('[data-routing-card]') === null).toBe(false);
  });

  it('is a Settings tab that reads its own machine without an injected state', async () => {
    expect(PACK_SETTINGS_TAB.id).toBe('pack');
    shown = await mount(<PACK_SETTINGS_TAB.Surface client={client} configFiles={uiDoubles.useConfigFiles()} />);
    expect(textOf(shown.container)).toContain('Reading Pack mode…');
  });
});
