/**
 * The Warden's first-run page (r11 O7): skipped when warden.yaml exists; otherwise three stacked cards, a default pick
 * that writes NOTHING by itself, and one `commit` that Next runs: it writes only the switch and the layers, names a stored
 * Jev key, and asks once before going on with no key. The key is typed in Voice's row (`keyRow`), never here.
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
  const page = await mount(
    <WardenStepPage deps={deps} step={run.host} keyRow={<input type="password" data-fake-key-row="" />} />,
  );
  mounted.push(page);
  await settle();
  const setKey = (next: SpeedupsView | 'off'): void => {
    key = next;
  };
  return { page, run, patches, named: () => named, setKey };
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

  it('shows three stacked cards with the free answer chosen, registers a commit, and writes nothing yet', async () => {
    const { page, run, patches } = await open();
    const ids = [...page.container.querySelectorAll('[data-choice]')].map(card => card.getAttribute('data-choice'));
    expect(ids).toEqual(['rules', 'jev', 'llm']);
    expect(page.container.querySelector('[data-choice-cards]')?.getAttribute('data-layout')).toBe('stack');
    expect(page.container.querySelector('[data-selected="true"]')?.getAttribute('data-choice')).toBe('rules');
    expect(run.events).toEqual(['ready', 'commit']);
    expect(patches).toEqual([]);
    // No button of its own: Next is the only thing to press, and the free answer has no key row.
    expect(page.container.querySelectorAll('button').length).toBe(0);
    expect(page.container.querySelector('[data-fake-key-row]')).toBeNull();
  });

  it('writes nothing for a pick (arrow keys and clicks only choose); Next writes only the switch and the layers', async () => {
    const storageBefore = { local: localStorage.length, session: sessionStorage.length };
    const { page, run, patches } = await open({ key: 'off' });
    await pick(page, 'llm');
    expect(patches).toEqual([]);
    await interact(() => run.runCommit());
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: true } }]);
    expect(page.container.querySelector('[data-warden-demo="llm"]')).not.toBeNull();
    // The page never calls done or busy itself: the shell does, around the commit.
    expect(run.events.filter(event => event === 'done' || event.startsWith('busy'))).toEqual([]);
    // Nothing is kept in the browser: the answer is on the daemon.
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(storageBefore);
  });

  it("draws Voice's key row under the cards for a Jev answer only, and no link into Settings", async () => {
    const { page } = await open({ key: speedups(false) });
    expect(page.container.querySelector('[data-fake-key-row]')).toBeNull();
    await pick(page, 'jev');
    expect(page.container.querySelector('[data-fake-key-row]')).not.toBeNull();
    await pick(page, 'llm');
    expect(page.container.querySelector('[data-fake-key-row]')).not.toBeNull();
    await pick(page, 'rules');
    expect(page.container.querySelector('[data-fake-key-row]')).toBeNull();
    expect(page.container.querySelector('a')).toBeNull();
    expect(page.container.textContent).not.toContain('Check again');
    expect(page.container.textContent).not.toContain('Waiting for the Jev key');
  });

  it('names a stored key in warden.yaml when Next is pressed, after writing the layers', async () => {
    const { page, run, patches, named } = await open({ key: speedups(true) });
    await pick(page, 'jev');
    await interact(() => run.runCommit());
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: false } }]);
    expect(named()).toBe(1);
  });

  it('writes and names nothing for the free answer even when a key is stored', async () => {
    const { run, patches, named } = await open({ key: speedups(true) });
    await interact(() => run.runCommit());
    expect(patches).toEqual([{ enabled: true, layers: { jev: false, llm: false } }]);
    expect(named()).toBe(0);
  });

  it('asks ONCE, before writing, when Jev is picked and no key is saved; the next Next says yes', async () => {
    const { page, run, patches, named } = await open({ key: speedups(false) });
    await pick(page, 'llm');
    await expect(interact(() => run.runCommit())).rejects.toThrow('Go on without one?');
    expect(patches).toEqual([]);
    await interact(() => run.runCommit());
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: true } }]);
    expect(named()).toBe(0);
  });

  it('asks again after a new pick, and not at all once a key was saved in the row meanwhile', async () => {
    const { page, run, patches, setKey, named } = await open({ key: speedups(false) });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow('Go on without one?');
    // The person pastes a key in Voice's row: the commit reads it fresh and names it.
    setKey(speedups(true));
    await interact(() => run.runCommit());
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: false } }]);
    expect(named()).toBe(1);
  });

  it('does not ask when Voice is off (no place to add a key)', async () => {
    const off = await open({ key: 'off' });
    await pick(off.page, 'jev');
    await interact(() => off.run.runCommit());
    expect(off.patches.length).toBe(1);
  });

  it('lets a refused write reach the shell as an error, with nothing written', async () => {
    const { page, run, patches } = await open({ refuse: 'That is not yours to change.', key: 'off' });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow('That is not yours to change.');
    expect(patches).toEqual([]);
  });
});
