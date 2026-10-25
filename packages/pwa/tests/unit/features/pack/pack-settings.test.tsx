import { afterEach, describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES, DEFAULT_PACK_CONFIG, type HealthView, type PackView } from '@ferretry/protocol';
import type { z } from 'zod';
import { PACK_SETTINGS_TAB, PackSettingsSurface } from '../../../../src/features/pack/pack-settings.tsx';
import type { MachinePack, PackRead, PackSave } from '../../../../src/features/pack/use-machine-pack.ts';
import type { PackConfigPatch } from '../../../../src/lib/pack/pack-files.ts';
import { DaemonClientProvider } from '../../../../src/lib/store.tsx';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { byText, click, textOf, typeInto, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { healthOf } from '../../../support/health.ts';
import { IDLE_ROUTING_API, NUDGE_VIEW, PACK_VIEW } from '../../../support/pack.ts';
import { alpha } from '../config-files/config-files-support.ts';

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
  shown = await mount(<PackSettingsSurface connection={alpha} state={state} />);
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
    expect(textOf(root)).toContain('Jev spends money on every pick');
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
    const { root, patches } = await surface(ready(), { kind: 'refused', message: 'pack.yaml has a problem.' });
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
    await waitForText(root, 'pack.yaml has a problem.');

    await typeInto(number(root, 'timeoutSeconds'), '60');
    await click(byText(root, 'button', 'Save probe'));
    await waitFor(() => patches.length === 2, 'the probe save');
    expect(patches[1]).toEqual({ probe: { timeoutSeconds: 60 } });
    expect(root.querySelector('[data-routing-card]') === null).toBe(false);
  });

  it('is a Machine tab panel that reads its own machine without an injected state', async () => {
    expect(PACK_SETTINGS_TAB.id).toBe('pack');
    shown = await mount(
      <DaemonClientProvider client={async () => ({ request: () => new Promise(() => undefined) }) as never}>
        <PACK_SETTINGS_TAB.Surface connection={alpha} />
      </DaemonClientProvider>,
    );
    expect(textOf(shown.container)).toContain('Reading Pack mode…');
  });
});

describe('Settings › Pack mode against a machine of another version', () => {
  const connected = async (health: HealthView) => {
    const client = {
      request: async (path: string, schema: z.ZodType<unknown>) => {
        if (path === '/v1/health') return schema.parse(health);
        if (path === '/v1/pack') return schema.parse(NUDGE_VIEW);
        return await new Promise<never>(() => undefined);
      },
    };
    shown = await mount(
      <DaemonClientProvider client={async () => client as never}>
        <PACK_SETTINGS_TAB.Surface connection={alpha} />
      </DaemonClientProvider>,
    );
    await waitFor(() => shown?.container.querySelector('textarea[data-routing-idea]') != null, 'the idea field');
    return shown.container;
  };
  const ideaOf = (root: HTMLElement) =>
    must(root.querySelector<HTMLTextAreaElement>('textarea[data-routing-idea]'), 'the idea');

  it('keeps an older machine’s idea to 500 characters and says it needs an update', async () => {
    const root = await connected(healthOf('4.84.0'));
    await waitForText(root, 'needs an update');
    expect(ideaOf(root).getAttribute('maxlength')).toBe('500');
    expect(textOf(must(root.querySelector('[data-idea-update-note]'), 'the note'))).toContain('fy daemon update');
  });

  it('gives a machine that lists pack.idea.4000 the full 4,000', async () => {
    const root = await connected(healthOf('4.90.0', [DAEMON_FEATURES.packIdea4000]));
    await waitFor(() => ideaOf(root).getAttribute('maxlength') === '4000', 'the longer limit');
    expect(root.querySelector('[data-idea-update-note]') === null).toBe(true);
  });
});
