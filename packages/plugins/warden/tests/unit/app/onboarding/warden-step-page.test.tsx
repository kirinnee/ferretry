/**
 * The Warden's first-run page: skipped when the person already wrote warden.yaml; otherwise three cards that write only
 * the switch and the layers, a Jev note that never asks for a key here, a demo that is decoration, and no storage write.
 */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { WardenStepPage, type WardenStepDeps } from '../../../../app/features/onboarding/warden-step-page.tsx';
import type { SpeedupsView } from '../../../../app/lib/speedups.ts';
import type { WardenConfigPatch, WardenConfigView } from '../../../../app/wire.ts';
import { fakeWardenClient } from '../../../support/app/clients.ts';
import { recordedStep } from '../../../support/app/step-host.ts';
import { wardenConfig } from '../../../support/app/warden.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const speedups = (set: boolean): SpeedupsView => ({
  vault: 'ok',
  providers: [
    {
      provider: 'jev',
      label: 'Jev',
      purpose: 'Triage.',
      costNote: 'Cheap.',
      privacyNote: 'A summary.',
      keyUrl: 'https://keys.example.test/',
      testNote: 'One decision.',
      secretName: 'JEV_API_KEY',
      set,
      testStale: false,
    },
  ],
});

interface Scene {
  readonly file?: { readonly exists: boolean; readonly written?: unknown };
  readonly key?: SpeedupsView | 'off';
  readonly held?: readonly string[];
  readonly refuse?: string;
}

const open = async (scene: Scene = {}) => {
  const patches: WardenConfigPatch[] = [];
  let named = 0;
  let config = wardenConfig();
  const view = (extra: Partial<WardenConfigView> = {}): WardenConfigView => ({
    config,
    accounts: [],
    warnings: [],
    ...extra,
  });
  const deps: WardenStepDeps = {
    client: fakeWardenClient({
      config: async () => view({ jevKey: 'not_named' }),
      updateConfig: async patch => {
        if (scene.refuse !== undefined) throw new Error(scene.refuse);
        patches.push(patch);
        config = {
          ...config,
          layers: { ...config.layers, ...(patch.layers ?? {}) },
        };
        return view({ ...(scene.held === undefined ? {} : { held: [...scene.held] }), jevKey: 'not_named' });
      },
      nameJevKey: async () => {
        named += 1;
        return view({ jevKey: 'named' });
      },
    }),
    readFile: async () => scene.file ?? { exists: false },
    readKey: async () => scene.key ?? speedups(false),
  };
  const run = recordedStep();
  const page = await mount(<WardenStepPage deps={deps} step={run.host} speedupsHref="/d/m1/settings/voice/speedups" />);
  mounted.push(page);
  await settle();
  return { page, run, patches, named: () => named };
};

const pick = async (page: Mounted, id: string): Promise<void> => {
  await interact(() => must(page.container.querySelector<HTMLInputElement>(`input[value="${id}"]`), id).click());
  await settle();
};

describe('the Warden step page', () => {
  it('is skipped as already set when the person wrote warden.yaml, and draws nothing', async () => {
    const { page, run } = await open({ file: { exists: true, written: { layers: { jev: true } } } });
    expect(run.events).toEqual(['skip:already-set']);
    expect(page.container.querySelector('[data-onboarding-step]')).toBeNull();
  });

  it('shows three cards with nothing chosen and writes nothing until the person picks', async () => {
    const { page, run, patches } = await open();
    const titles = [...page.container.querySelectorAll('[data-choice]')].map(card => card.getAttribute('data-choice'));
    expect(titles).toEqual(['rules', 'jev', 'llm']);
    expect(page.container.querySelectorAll('[data-selected="true"]').length).toBe(0);
    expect(run.events).toEqual(['ready']);
    expect(patches).toEqual([]);
  });

  it('writes only the switch and the layers for a pick, and tells the host it is done', async () => {
    const { page, run, patches } = await open();
    await pick(page, 'rules');
    expect(patches).toEqual([{ enabled: true, layers: { jev: false, llm: false } }]);
    expect(run.events).toEqual(['ready', 'busy:Saving…', 'done', 'busy:null']);
    expect(page.container.querySelector('[data-warden-demo="rules"]')).not.toBeNull();
    // No Jev note for the free answer.
    expect(page.container.querySelector('[data-warden-jev]')).toBeNull();
    // Nothing is kept in the browser: the answer is on the daemon, and the page remembers nothing of its own.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('turns both layers on for the LLM card and keeps the key out of the page', async () => {
    const { page, patches } = await open({ key: speedups(false) });
    await pick(page, 'llm');
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: true } }]);
    const note = must(page.container.querySelector('[data-warden-jev="missing"]'), 'missing note');
    expect(note.textContent).toContain('optional');
    expect(note.textContent).toContain('every flag goes to the investigation');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/d/m1/settings/voice/speedups');
    // This page never asks for a key.
    expect(page.container.querySelector('input[type="password"], input[type="text"], textarea')).toBeNull();
  });

  it('says a stored but unnamed key is not used yet, and names it on request', async () => {
    const { page, named } = await open({ key: speedups(true) });
    await pick(page, 'jev');
    expect(must(page.container.querySelector('[data-warden-jev="not_named"]'), 'not named').textContent).toContain(
      'every flag is shown to you',
    );
    const button = [...page.container.querySelectorAll('button')].find(b => b.textContent === 'Use the stored key');
    await interact(() => must(button ?? null, 'use button').click());
    await settle();
    expect(named()).toBe(1);
    expect(page.container.querySelector('[data-warden-jev="set"]')).not.toBeNull();
  });

  it('says when a loosening waits for the owner, and is still done', async () => {
    const { page, run } = await open({ held: ['LLM investigation is switched on'] });
    await pick(page, 'llm');
    expect(page.container.textContent).toContain('waits for you to confirm it: LLM investigation is switched on');
    expect(run.events).toContain('done');
  });

  it('says so and is not done when the daemon refuses the write', async () => {
    const { page, run } = await open({ refuse: 'That is not yours to change.' });
    await pick(page, 'jev');
    expect(page.container.textContent).toContain('That is not yours to change.');
    expect(run.events).not.toContain('done');
    expect(page.container.querySelectorAll('[data-selected="true"]').length).toBe(0);
  });

  it('reads Voice being off as "no place to add a key", not as a missing key', async () => {
    const { page } = await open({ key: 'off' });
    await pick(page, 'jev');
    expect(must(page.container.querySelector('[data-warden-jev="off"]'), 'off note').textContent).toContain(
      'switched off on this machine',
    );
  });
});
