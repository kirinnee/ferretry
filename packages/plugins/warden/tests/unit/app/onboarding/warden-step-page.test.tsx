/**
 * The Warden's first-run page: skipped when warden.yaml is already on the machine; otherwise three cards that write only
 * the switch and the layers, a Jev note that never asks for a key here, a demo that is decoration, and no storage write.
 * The file read is the route's REAL reply (`GET /v1/config/file`: path, exists, text, state, …), never a made-up field.
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

/** What `GET /v1/config/file` really returns for `warden.yaml` (core/kernel/host/config/routes.ts). */
const fileReply = (exists: boolean, text = '# yaml-language-server: $schema=warden.schema.json\n') => ({
  path: 'warden.yaml',
  absolutePath: '/home/x/.ferretry/config/warden.yaml',
  kind: 'warden',
  schema: 'warden.schema.json',
  exists,
  text,
  etag: 'e1',
  state: 'ok',
  issues: [],
});

interface Scene {
  readonly file?: ReturnType<typeof fileReply>;
  /** The key the page reads; a test may change it between reads with `setKey`. */
  readonly key?: SpeedupsView | 'off';
  readonly unreadable?: boolean;
  readonly held?: readonly string[];
  readonly refuse?: string;
}

const open = async (scene: Scene = {}) => {
  const patches: WardenConfigPatch[] = [];
  let named = 0;
  let key: SpeedupsView | 'off' = scene.key ?? speedups(false);
  let nameable: WardenConfigView['jevKey'] = 'not_named';
  let config = wardenConfig();
  const view = (extra: Partial<WardenConfigView> = {}): WardenConfigView => ({
    config,
    accounts: [],
    warnings: [],
    ...extra,
  });
  const deps: WardenStepDeps = {
    client: fakeWardenClient({
      config: async () => view({ jevKey: nameable }),
      updateConfig: async patch => {
        if (scene.refuse !== undefined) throw new Error(scene.refuse);
        patches.push(patch);
        config = {
          ...config,
          layers: { ...config.layers, ...(patch.layers ?? {}) },
        };
        return view({ ...(scene.held === undefined ? {} : { held: [...scene.held] }), jevKey: nameable });
      },
      nameJevKey: async () => {
        named += 1;
        nameable = 'named';
        return view({ jevKey: 'named' });
      },
    }),
    readFile: async () => {
      if (scene.unreadable === true) throw new Error('The file could not be read.');
      return scene.file ?? fileReply(false);
    },
    readKey: async () => key,
  };
  const run = recordedStep();
  const page = await mount(<WardenStepPage deps={deps} step={run.host} speedupsHref="/d/m1/settings/voice/speedups" />);
  mounted.push(page);
  await settle();
  const setKey = (next: SpeedupsView | 'off'): void => {
    key = next;
  };
  return { page, run, patches, named: () => named, setKey };
};

const press = async (page: Mounted, label: string): Promise<void> => {
  const button = [...page.container.querySelectorAll('button')].find(b => b.textContent === label);
  await interact(() => must(button ?? null, label).click());
  await settle();
};

const pick = async (page: Mounted, id: string): Promise<void> => {
  await interact(() => must(page.container.querySelector<HTMLInputElement>(`input[value="${id}"]`), id).click());
  await settle();
};

describe('the Warden step page', () => {
  it('is skipped as already set when warden.yaml exists, even one that says enabled: false, and draws nothing', async () => {
    const { page, run, patches } = await open({ file: fileReply(true, 'enabled: false\n') });
    expect(run.events).toEqual(['skip:already-set']);
    expect(page.container.querySelector('[data-onboarding-step]')).toBeNull();
    expect(patches).toEqual([]);
  });

  it('is skipped for a file that exists but is empty or does not check: it is still not the page to write over it', async () => {
    const empty = await open({ file: fileReply(true, '') });
    expect(empty.run.events).toEqual(['skip:already-set']);
    const broken = await open({ file: { ...fileReply(true, 'enabled: [\n'), state: 'invalid' } });
    expect(broken.run.events).toEqual(['skip:already-set']);
  });

  it('says so, and offers no card, when the file cannot be read, rather than treat it as missing', async () => {
    const { page, run, patches } = await open({ unreadable: true });
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('could not be read');
    expect(page.container.querySelectorAll('[data-choice]').length).toBe(0);
    expect(patches).toEqual([]);
    expect(run.events).toEqual(['ready']);
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
    const storageBefore = { local: localStorage.length, session: sessionStorage.length };
    const { page, run, patches } = await open();
    await pick(page, 'rules');
    expect(patches).toEqual([{ enabled: true, layers: { jev: false, llm: false } }]);
    expect(run.events).toEqual(['ready', 'busy:Saving…', 'busy:null', 'done']);
    expect(page.container.querySelector('[data-warden-demo="rules"]')).not.toBeNull();
    // No Jev note for the free answer.
    expect(page.container.querySelector('[data-warden-jev]')).toBeNull();
    // Nothing is kept in the browser: the answer is on the daemon, and the page remembers nothing of its own.
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(storageBefore);
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

  it('says a stored but unnamed key is not used yet, holds the step, and names it on request', async () => {
    const { page, named, run } = await open({ key: speedups(true) });
    await pick(page, 'jev');
    expect(run.events).toEqual(['ready', 'busy:Saving…', 'busy:Waiting for the Jev key…']);
    expect(must(page.container.querySelector('[data-warden-jev="not_named"]'), 'not named').textContent).toContain(
      'every flag is shown to you',
    );
    const button = [...page.container.querySelectorAll('button')].find(b => b.textContent === 'Use the stored key');
    await interact(() => must(button ?? null, 'use button').click());
    await settle();
    expect(named()).toBe(1);
    expect(page.container.querySelector('[data-warden-jev="set"]')).not.toBeNull();
    expect(run.events.slice(-2)).toEqual(['busy:null', 'done']);
  });

  it('lets the person go on without naming the stored key, and only then is the step done', async () => {
    const { page, run, named } = await open({ key: speedups(true) });
    await pick(page, 'llm');
    expect(run.events).not.toContain('done');
    await press(page, 'Go on without a key');
    expect(named()).toBe(0);
    expect(run.events.slice(-2)).toEqual(['busy:null', 'done']);
  });

  it('reaches "Use the stored key" after the key is saved in Speed-ups, without picking Jev again', async () => {
    const { page, run, patches, named, setKey } = await open({ key: speedups(false) });
    await pick(page, 'jev');
    // No key yet: the step is held, not done.
    expect(page.container.querySelector('[data-warden-jev="missing"]')).not.toBeNull();
    expect(run.events).toEqual(['ready', 'busy:Saving…', 'busy:Waiting for the Jev key…']);
    // The owner saves the key in Speed-ups, then comes back and asks the page to look again: no second card pick.
    setKey(speedups(true));
    await press(page, 'Check again');
    expect(page.container.querySelector('[data-warden-jev="not_named"]')).not.toBeNull();
    expect(run.events).not.toContain('done');
    await press(page, 'Use the stored key');
    expect(named()).toBe(1);
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: false } }]);
    expect(run.events.slice(-2)).toEqual(['busy:null', 'done']);
    // The key itself never reaches the page: no field and no value anywhere in it.
    expect(page.container.querySelector('input[type="password"], input[type="text"], textarea')).toBeNull();
    expect(page.container.textContent).not.toContain('JEV_API_KEY');
  });

  it('is done at once on a later pick once the key is named, with nothing to hold', async () => {
    const { page, run, setKey } = await open({ key: speedups(true) });
    await pick(page, 'jev');
    await press(page, 'Use the stored key');
    setKey(speedups(true));
    await pick(page, 'llm');
    expect(run.events.at(-1)).toBe('done');
    expect(page.container.querySelector('[data-warden-jev="set"]')).not.toBeNull();
  });

  it('lets the person go on without any key, and the step is held until they do', async () => {
    const { page, run } = await open({ key: speedups(false) });
    await pick(page, 'llm');
    expect(run.events).not.toContain('done');
    await press(page, 'Go on without a key');
    expect(run.events.slice(-2)).toEqual(['busy:null', 'done']);
  });

  it('says when a loosening waits for the owner, and is still done', async () => {
    const { page, run } = await open({ held: ['LLM investigation is switched on'], key: 'off' });
    await pick(page, 'llm');
    expect(page.container.textContent).toContain('waits for you to confirm it: LLM investigation is switched on');
    expect(run.events.slice(-2)).toEqual(['busy:null', 'done']);
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
