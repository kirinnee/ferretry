import { afterEach, describe, expect, it } from 'bun:test';
import { DEFAULT_PACK_CONFIG, type PackView } from '@ferretry/protocol';
import { PACK_SETTINGS_TAB, PackSettingsSurface } from '../../../../src/features/pack/pack-settings.tsx';
import type { MachinePack, PackRead, PackSave } from '../../../../src/features/pack/use-machine-pack.ts';
import type { PackConfigPatch } from '../../../../src/lib/pack/pack-files.ts';
import { DaemonClientProvider } from '../../../../src/lib/store.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { byText, click, textOf, typeInto, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { IDLE_GUIDE_API, PACK_VIEW, RUNNING_JOB, SUGGESTION } from '../../../support/pack.ts';
import { settleUntil } from '../../../support/settle.ts';
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
    saveGuide: async () => answer,
    ...IDLE_GUIDE_API,
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
    expect(root.querySelector('[data-models-guide]') === null).toBe(false);
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

describe('Settings › Pack mode › the guide generator', () => {
  const generator = async (view: PackView, overrides: Partial<MachinePack> = {}) => {
    const state: MachinePack = {
      read: ready(view),
      saveConfig: async () => ({ kind: 'applied' }),
      saveGuide: async () => ({ kind: 'applied' }),
      ...IDLE_GUIDE_API,
      ...overrides,
    };
    shown = await mount(<PackSettingsSurface connection={alpha} state={state} />);
    return shown.container;
  };

  it('lists the models closed, offers the generator and says when the daemon cannot build a guide', async () => {
    const root = await generator(PACK_VIEW);
    expect(root.querySelector('[data-models-panel]')).not.toBeNull();
    expect(root.querySelector('[data-model-row]') === null).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-guide-start]')?.disabled).toBe(true);
    expect(textOf(root)).toContain('daemon is too old');
    expect(root.querySelector('[data-guide-undo-last]') === null).toBe(true);
  });

  it('prefills the remembered preferences and sends a model description to the daemon', async () => {
    const described: { model: string; description: string | null }[] = [];
    const root = await generator(
      {
        ...PACK_VIEW,
        config: { ...PACK_VIEW.config, routingPreferences: 'Cheap first.' },
        builder: { available: true, runtimes: ['claude-main'] },
      },
      {
        describeModel: async request => {
          described.push(request);
          return { kind: 'applied', message: 'Saved.' };
        },
      },
    );
    expect(must(root.querySelector<HTMLTextAreaElement>('[data-guide-preferences]'), 'preferences').value).toBe(
      'Cheap first.',
    );
    expect(root.querySelector<HTMLButtonElement>('[data-guide-start]')?.disabled).toBe(false);
    await click(must(root.querySelector('[data-models-panel] button[aria-expanded="false"]'), 'open models'));
    await typeInto(must(root.querySelector<HTMLTextAreaElement>('[data-model-row] textarea'), 'description'), 'Words.');
    await click(byText(root, 'button', 'Save description'));
    await waitFor(() => described.length === 1, 'a description');
    expect(described[0]?.description).toBe('Words.');
  });

  it('offers Undo in the editor while an accepted suggestion can be undone', async () => {
    let undone = 0;
    const root = await generator(
      { ...PACK_VIEW, undo: { savedAt: '2026-10-22T14:35:00.000Z', source: 'file' } },
      {
        undoGuide: async () => {
          undone += 1;
          return { kind: 'applied', message: 'Put the old guide back.' };
        },
      },
    );
    await click(must(root.querySelector('[data-guide-undo-last]'), 'undo'));
    await waitForText(root, 'Put the old guide back.');
    expect(undone).toBe(1);
  });

  it('finds a run going on load, and sends the reviewed draft to the editor on Edit without saving it', async () => {
    const saves: unknown[] = [];
    const root = await generator(
      { ...PACK_VIEW, builder: { available: true, runtimes: ['codex-main'], job: RUNNING_JOB } },
      {
        saveGuide: async useCases => {
          saves.push(useCases);
          return { kind: 'applied' };
        },
        readJob: async () => ({
          kind: 'read',
          result: { job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION },
        }),
      },
    );
    expect(root.querySelector('[data-guide-job]')?.getAttribute('data-guide-job')).toBe('running');
    await settleUntil(() => root.querySelector('[data-guide-review]') !== null, 'the review', interact, 6_000);
    await click(must(root.querySelector('[data-review-action="edit"]'), 'edit'));
    expect(root.querySelector('[data-guide-review]') === null).toBe(true);
    const ids = [...root.querySelectorAll('[data-guide-use-case]')].map(item =>
      item.getAttribute('data-guide-use-case'),
    );
    expect(ids).toEqual(['hard', 'bulk', 'docs']);
    expect(saves).toHaveLength(0);
  }, 12_000);
});
