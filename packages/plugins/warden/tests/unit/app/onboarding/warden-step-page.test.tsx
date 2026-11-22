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

/** What the daemon client throws for `403 grant_step_up_required` (a message that is raw wire text, never shown). */
const stepUpRefusal = (): Error =>
  Object.assign(new Error('grant_step_up_required: this act needs a recent passkey'), {
    status: 403,
    code: 'grant_step_up_required',
  });

interface Scene {
  readonly file?: ReturnType<typeof fileReply>;
  /** The key the page reads; a test may change it between reads with `setKey`. */
  readonly key?: SpeedupsView | 'off';
  readonly unreadable?: boolean;
  /** The Jev key list cannot be read when Next saves: the key is unknown, not missing, so nothing is asked. */
  readonly keyUnreadable?: boolean;
  readonly held?: readonly string[];
  readonly refuse?: string | Error;
  /** The refusal is given once: the next write goes through (the person confirmed the passkey). */
  readonly stepUpOnce?: boolean;
  /** What the slot under the cards holds; `null` = no key row is placed (Voice off). */
  readonly keyRow?: null;
}

const open = async (scene: Scene = {}) => {
  const patches: WardenConfigPatch[] = [];
  let named = 0;
  let writes = 0;
  let refusals = 0;
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
      updateConfig: async (patch, options) => {
        if (scene.refuse !== undefined && !(scene.stepUpOnce === true && refusals > 0)) {
          refusals += 1;
          throw typeof scene.refuse === 'string' ? new Error(scene.refuse) : scene.refuse;
        }
        patches.push(patch);
        writes += 1;
        // Naming rides the same write as the answer: it is counted, and the key is then named.
        if (options?.nameJevKey === true) {
          named += 1;
          nameable = 'named';
        }
        config = {
          ...config,
          layers: { ...config.layers, ...(patch.layers ?? {}) },
        };
        return view({ ...(scene.held === undefined ? {} : { held: [...scene.held] }), jevKey: nameable });
      },
      nameJevKey: async () => {
        throw new Error('the page must name the key in the same write, not in a second one');
      },
    }),
    readFile: async () => {
      if (scene.unreadable === true) throw new Error('The file could not be read.');
      return scene.file ?? fileReply(false);
    },
    readKey: async () => {
      if (scene.keyUnreadable === true) throw new Error('The key list could not be read.');
      return key;
    },
  };
  const run = recordedStep();
  const page = await mount(
    <WardenStepPage
      deps={deps}
      step={run.host}
      keyRow={scene.keyRow === null ? null : <input type="password" data-fake-key-row="" />}
    />,
  );
  mounted.push(page);
  await settle();
  const setKey = (next: SpeedupsView | 'off'): void => {
    key = next;
  };
  return { page, run, patches, named: () => named, writes: () => writes, setKey };
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
    // Try again reads the file once more (it is unreadable again here, so the line stays).
    await interact(() => must(page.container.querySelector<HTMLButtonElement>('button'), 'try again').click());
    await settle();
    expect(run.events).toEqual(['ready', 'ready']);
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

  it('names a stored key in the SAME write as the answer: one call, never a second write of warden.yaml', async () => {
    const { page, run, patches, named, writes } = await open({ key: speedups(true) });
    await pick(page, 'jev');
    await interact(() => run.runCommit());
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: false } }]);
    expect(named()).toBe(1);
    expect(writes()).toBe(1);
  });

  it('says what the kernel HELD for the owner in the footer line, once, and the next Next goes on without writing again', async () => {
    const { page, run, writes } = await open({ key: speedups(true), held: ['the Jev key is named.'] });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow('Waiting for your approval: the Jev key is named.');
    expect(writes()).toBe(1);
    await interact(() => run.runCommit());
    expect(writes()).toBe(1);
  });

  it('a refused combined write leaves nothing half-saved: one attempt, the error shown, and Next tries the write again', async () => {
    const { page, run, writes } = await open({ key: speedups(true), refuse: 'The machine refused the write.' });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow('refused the write');
    await expect(interact(() => run.runCommit())).rejects.toThrow('refused the write');
    expect(writes()).toBe(0);
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

  it('does not point at a key row that is not drawn when the question is asked', async () => {
    const { run, page } = await open({ key: speedups(false), keyRow: null });
    await pick(page, 'jev');
    const asking = interact(() => run.runCommit());
    await expect(asking).rejects.toThrow(
      'No Jev key yet, and this page has no place to add one. Go on without one? Press Next to say yes.',
    );
    await expect(interact(() => run.runCommit())).resolves.toBeUndefined();
  });

  it('points at the key row above only when a key row is drawn', async () => {
    const { run, page } = await open({ key: speedups(false) });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow(
      'No Jev key yet. Go on without one? Press Next to say yes, or paste a key above.',
    );
  });

  it('says the passkey sentence and offers the unlock when the save was refused for want of the step-up', async () => {
    const { page, run, patches } = await open({ key: 'off', refuse: stepUpRefusal(), stepUpOnce: true });
    await pick(page, 'jev');
    expect(page.container.querySelector('[data-warden-unlock]')).toBeNull();
    await expect(interact(() => run.runCommit())).rejects.toThrow('Part of this page needs you to confirm it’s you.');
    await settle();
    // The sentence is the footer's; the page adds the one action, never the raw error.
    expect(must(page.container.querySelector('[data-warden-unlock] button'), 'unlock').textContent).toBe(
      'Confirm it’s you',
    );
    expect(page.container.textContent).not.toContain('grant_step_up_required');
    // The button is the person's own press of Next. `step.next()` only navigates in the real flow, so it runs the registered
    // save ITSELF (the machine asks for the passkey there) and goes on only once that is written: done, then next.
    expect(run.events.filter(event => event === 'next' || event === 'done')).toEqual([]);
    await interact(() =>
      must(page.container.querySelector<HTMLButtonElement>('[data-warden-unlock] button'), 'unlock').click(),
    );
    await settle();
    expect(patches).toEqual([{ enabled: true, layers: { jev: true, llm: false } }]);
    expect(run.events.slice(-4)).toEqual(['busy:Saving…', 'busy:null', 'done', 'next']);
    expect(page.container.querySelector('[data-warden-unlock]')).toBeNull();
  });

  it('stays on the step, writes nothing and does not advance when the passkey is declined on Confirm', async () => {
    const { page, run, patches } = await open({ key: 'off', refuse: stepUpRefusal() });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow('confirm it’s you');
    await settle();
    await interact(() =>
      must(page.container.querySelector<HTMLButtonElement>('[data-warden-unlock] button'), 'unlock').click(),
    );
    await settle();
    expect(patches).toEqual([]);
    expect(run.events.filter(event => event === 'next' || event === 'done')).toEqual([]);
    expect(run.events.slice(-2)).toEqual(['busy:Saving…', 'busy:null']);
    // Still there to press again; the footer's own sentence is the one that says why, so the page does not repeat it.
    expect(page.container.querySelector('[data-warden-unlock] button')).not.toBeNull();
    expect(page.container.querySelector('[data-warden-unlock] [role=alert]')).toBeNull();
  });

  it('shows any other refusal as it is, with no unlock offered', async () => {
    const { page, run } = await open({ key: 'off', refuse: new Error('That is not yours to change.') });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow('That is not yours to change.');
    expect(page.container.querySelector('[data-warden-unlock]')).toBeNull();
  });

  it('clears the unlock when the pick changes', async () => {
    const { page, run } = await open({ key: 'off', refuse: stepUpRefusal() });
    await pick(page, 'jev');
    await expect(interact(() => run.runCommit())).rejects.toThrow('confirm it’s you');
    await settle();
    expect(page.container.querySelector('[data-warden-unlock]')).not.toBeNull();
    await pick(page, 'llm');
    expect(page.container.querySelector('[data-warden-unlock]')).toBeNull();
  });

  it('does not ask when the key list cannot be read (the key is unknown, not missing)', async () => {
    const { page, run, patches } = await open({ keyUnreadable: true });
    await pick(page, 'jev');
    await interact(() => run.runCommit());
    expect(patches.length).toBe(1);
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
