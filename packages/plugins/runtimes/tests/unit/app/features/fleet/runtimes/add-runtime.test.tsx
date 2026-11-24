import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LayeredProfileCatalogSchema, type MachineView } from '../../../../../../contract/index.ts';
import { AddRuntime } from '../../../../../../app/features/fleet/runtimes/add-runtime.tsx';
import type { MachineData } from '../../../../../../app/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../../app/features/fleet/shell/apply-change-panel.tsx';
import { type PlacedPanel, WithSlotPanels } from '@ferretry/app/testing';
import { type ReactNode, useState } from 'react';
import {
  choose as chooseBox,
  closeBox,
  labelOf,
  openBox,
  optionsOpen,
  shownBy,
} from '../../../../support/select-box.ts';
import { interact, type Mounted, mount as mountView, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  BACKUP_PATH,
  type Call,
  CHANGE_ID,
  COMMITTED,
  CREDENTIALS,
  credential,
  DATA,
  LANDED_FILE,
  machine,
  PROFILES,
  profile,
  READS,
  ROLLBACK_INCOMPLETE,
  ROLLED_BACK,
  runtime,
  scripted,
  stagedFrom,
  UNRESTORED_PATH,
  withStatus,
} from '../account-support.ts';
import { credentialsOf, NOT_INSTALLED_CODEX, refusal, withRuntime } from './support-b.ts';
import {
  ADD_RUNTIME_LOGIN_SLOT,
  ADD_RUNTIME_SIGN_IN_SLOT,
  isAddRuntimeLoginSlotProps,
  isAddRuntimeSignInSlotProps,
} from '../../../../../../contract/index.ts';

const APPLY = `POST /v1/runtimes/proposals/${CHANGE_ID}/apply`;
const PROPOSE = 'POST /v1/runtimes/proposals';
const SETTINGS = '/d/d1/settings/runtimes/runtimes';
/** Where another tab is: its Settings path on this daemon, with the page in the hash. */
const SIGN_INS = '/d/d1/settings/logins/logins#machines/studio-mac/sign-ins';
const PROFILES_TAB = '/d/d1/settings/runtimes/profiles#machines/studio-mac/profiles';

const NO_LOGINS: MachineData = { ...DATA, credentials: credentialsOf() };
const NO_PROFILES: MachineData = {
  ...DATA,
  profiles: LayeredProfileCatalogSchema.parse({ ...PROFILES, profiles: [] }),
};
const SIGN_IN_NEEDED: MachineData = {
  ...DATA,
  credentials: credentialsOf(
    credential({ id: 'claude-work', label: 'work', ...withStatus('needs_sign_in'), usedBy: ['claude-work'] }),
    CREDENTIALS.logins[0] as unknown as Record<string, unknown>,
  ),
};

const mounted: Mounted[] = [];

beforeEach(() => window.history.pushState({}, '', SETTINGS));

afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  window.location.hash = '';
  window.history.pushState({}, '', '/');
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const waitFor = async (container: ParentNode, selector: string): Promise<Element> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = container.querySelector(selector);
    if (found !== null) return found;
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
  }
  throw new Error(`expected ${selector} to appear`);
};

const click = async (container: ParentNode, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};

const loginBox = (container: ParentNode): HTMLElement =>
  must(container.querySelector<HTMLElement>('[data-add-runtime-credential-select]'), 'login select');

const profileBox = (container: ParentNode): HTMLElement =>
  must(container.querySelector<HTMLElement>('[data-add-runtime-profile-select]'), 'profile select');

/** Picks a login by its stored id: the list names logins in plain words and carries the id on its "id" line. */
const pickLogin = async (container: ParentNode, id: string): Promise<void> => {
  const host = loginBox(container);
  await openBox(host);
  const option = must(
    optionsOpen().find(candidate => candidate.textContent?.includes(`id ${id}`) === true),
    `the login ${id}`,
  );
  await interact(() => option.click());
};

const pickProfile = (container: ParentNode, name: string): Promise<void> => chooseBox(profileBox(container), name);

/** The labels of a select box's options, read from its open list. */
const labelsOf = async (host: HTMLElement): Promise<string[]> => {
  await openBox(host);
  const labels = optionsOpen().map(labelOf);
  await closeBox(host);
  return labels;
};

const loginsOf = (container: ParentNode): Promise<string[]> => labelsOf(loginBox(container));
const profilesOf = (container: ParentNode): Promise<string[]> => labelsOf(profileBox(container));
const loginShown = (container: ParentNode): string => shownBy(loginBox(container));
const profileShown = (container: ParentNode): string => shownBy(profileBox(container));

const text = (container: ParentNode, selector: string): string =>
  must(container.querySelector(selector), selector).textContent ?? '';

interface HostOptions {
  readonly data?: MachineData;
  /** What every re-read answers. */
  readonly after?: MachineData;
  readonly routes?: Record<string, unknown>;
  readonly calls?: Call[];
  readonly machine?: MachineView | null;
  readonly online?: boolean;
  readonly finishes?: (string | null)[];
  readonly reloads?: string[];
  /** The panels the layout places in the slots the page offers; none: the page as drawn outside a shell. */
  readonly slots?: Readonly<Record<string, readonly PlacedPanel[]>>;
}

const mountHost = async (options: HostOptions = {}) => {
  const client = scripted(options.routes ?? READS(), options.calls);
  const initial = options.data ?? DATA;
  const Shell = ({ children }: { readonly children: ReactNode }) =>
    options.slots === undefined ? <>{children}</> : <WithSlotPanels slots={options.slots}>{children}</WithSlotPanels>;

  function Host() {
    const [data, setData] = useState<MachineData>(initial);
    const changes = useAccountChanges({ client });
    return (
      <Shell>
        <AddRuntime
          data={data}
          reload={async () => {
            options.reloads?.push('reload');
            const next = options.after ?? data;
            setData(next);
            return next;
          }}
          changes={changes}
          machine={options.machine === undefined ? machine() : options.machine}
          machineName="studio-mac"
          online={options.online ?? true}
          onFinish={open => options.finishes?.push(open)}
        />
      </Shell>
    );
  }

  const view = await mountView(<Host />);
  mounted.push(view);
  await settle();
  return view;
};

const STAGED_ROUTES = (data: MachineData = DATA) => ({
  ...READS(data),
  [PROPOSE]: (call: Call) => stagedFrom(call),
  [APPLY]: APPLIED,
});

const proposed = (calls: readonly Call[]): unknown[] =>
  calls.filter(call => call.route === PROPOSE).map(call => call.body);

const submit = (container: ParentNode): HTMLButtonElement =>
  must([...container.querySelectorAll<HTMLButtonElement>('[data-change-submit]')].at(-1), 'submit');

describe('Add runtime: the page', () => {
  it('is one short form: a way back, Login and Profile already filled in, and Create', async () => {
    const finishes: (string | null)[] = [];
    const view = await mountHost({ finishes });
    expect(text(view.container, 'h3')).toBe('Advanced: add a runtime');
    expect(text(view.container, '[data-page-back]')).toBe('Runtimes');
    expect(view.container.textContent).toContain('Every ready login already has a runtime on studio-mac');
    expect(
      [...view.container.querySelectorAll('[data-add-runtime-part]')].map(part =>
        part.getAttribute('data-add-runtime-part'),
      ),
    ).toEqual(['login', 'login-more', 'profile']);
    // Only Login shows first: the rest (new login, sign-in, Profile) sits under one "More".
    const more = must(view.container.querySelector<HTMLDetailsElement>('[data-add-runtime-more]'), 'More');
    expect(more.open).toBe(false);
    expect(more.querySelector('summary')?.textContent).toBe('More');
    expect(more.querySelector('[data-add-runtime-profile-select]')).not.toBeNull();
    expect(view.container.querySelectorAll('[data-add-runtime-more]')).toHaveLength(1);
    expect(loginShown(view.container)).toBe('Claude · your terminal sign-in (personal)');
    expect(profileShown(view.container)).toBe('Claude hooks');
    expect(submit(view.container).textContent).toBe('Create runtime');
    expect(submit(view.container).disabled).toBe(false);
    await click(view.container, '[data-page-back]');
    expect(finishes).toEqual([null]);
  });

  it('waits while the machine is offline, even with everything chosen', async () => {
    const view = await mountHost({ online: false });
    expect(submit(view.container).disabled).toBe(true);
  });
});

describe('Add runtime: plain names (Q8a)', () => {
  it('no stored login or runtime id reads as a name, and no id is drawn at all', async () => {
    const view = await mountHost();
    const root = view.container;
    const ids = ['claude-personal', 'claude-work', 'codex', 'claude-review'];
    const visible = [loginShown(root), profileShown(root), ...(await loginsOf(root)), ...(await profilesOf(root))];
    for (const id of ids) for (const shown of visible) expect(shown).not.toContain(id);
    // There is no name box to ask for an id: the id the runtime gets is never drawn.
    expect(root.textContent).not.toContain('claude-claude-hooks');
    expect(root.querySelector('[data-add-runtime-id]')).toBeNull();
    await pickProfile(root, 'Review');
    await click(root, '[data-duplicate-ok]');
    expect(text(root, '[data-add-runtime-duplicate]')).not.toContain('claude-review');
    // The built-in profile is "Ferretry standard", not ferretry-claude.
    expect(visible.join('|')).not.toContain('ferretry-');
  });
});

describe('Add runtime: Login', () => {
  it('lists the logins, claude first, with their status', async () => {
    const view = await mountHost();
    expect(await loginsOf(view.container)).toEqual([
      'Claude · your terminal sign-in (personal)',
      'Claude · Claude.ai sign-in (work)',
      'Codex · your terminal sign-in',
    ]);
    await openBox(loginBox(view.container));
    const personal =
      optionsOpen().find(option => labelOf(option).startsWith('Claude · your terminal sign-in'))?.textContent ?? '';
    await closeBox(loginBox(view.container));
    expect(personal).toContain('personal');
    expect(personal).toContain('id claude-personal');
    expect(text(view.container, '[data-add-runtime-login-sub]')).toContain('Ready');
    await pickLogin(view.container, 'claude-work');
    expect(text(view.container, '[data-add-runtime-login-sub]')).toContain('Refresh due');
    expect(view.container.querySelector('[data-add-runtime-no-logins]')).toBeNull();
  });

  it('says under the login when its tool is not installed here', async () => {
    const view = await mountHost({ machine: NOT_INSTALLED_CODEX });
    expect(text(view.container, '[data-add-runtime-login-sub]')).not.toContain('installed here');
    await pickLogin(view.container, 'codex');
    expect(text(view.container, '[data-add-runtime-login-sub]')).toContain('Codex isn’t installed here');
  });

  it('E12: with no logins it says so and offers to add one', async () => {
    const view = await mountHost({ data: NO_LOGINS });
    expect(text(view.container, '[data-add-runtime-no-logins]')).toBe(
      'There are no logins on studio-mac yet. Add one below: sign in to Claude Code or Codex, or use a provider key.',
    );
    expect(view.container.querySelector('[data-add-runtime-credential-select]')).toBeNull();
    // No panel is placed in this suite's shell-less page, so the row is the link to Logins' tab.
    expect(text(view.container, '[data-add-row="login"]')).toBe('Add a new login in Sign-ins');
    expect(view.container.querySelector('[data-add-row="login"]')?.getAttribute('href')).toBe(SIGN_INS);
  });

  it('picking another login starts the rest over', async () => {
    const view = await mountHost();
    await pickProfile(view.container, 'Review');
    await click(view.container, '[data-duplicate-ok]');
    await pickLogin(view.container, 'codex');
    expect(
      must(
        view.container.querySelector<HTMLInputElement>('[data-duplicate-ok]') ?? document.createElement('input'),
        'ok',
      ).checked,
    ).toBe(false);
  });

  it('E13: a login that needs sign-in says so and links to the sign-in', async () => {
    const view = await mountHost({ data: SIGN_IN_NEEDED });
    expect(text(view.container, '[data-add-runtime-needs-sign-in]')).toContain(
      'This login needs sign-in before you launch.',
    );
    expect(view.container.querySelector('[data-add-runtime-sign-in]')?.getAttribute('href')).toBe(
      `${SIGN_INS}/claude-work`,
    );
    await pickLogin(view.container, 'claude-personal');
    expect(view.container.querySelector('[data-add-runtime-needs-sign-in]')).toBeNull();
  });
});

describe('Add runtime: Add a new login', () => {
  it('without Logins’ panel placed, links to its Sign-ins tab', async () => {
    const view = await mountHost({ machine: NOT_INSTALLED_CODEX });
    expect(view.container.querySelector('[data-add-runtime-new-login]')).toBeNull();
    const row = must(view.container.querySelector<HTMLAnchorElement>('[data-add-row="login"]'), 'login row');
    expect(row.getAttribute('href')).toBe(SIGN_INS);
    expect(row.textContent).toBe('Add a new login in Sign-ins');
  });

  it('follows the link inside the app: the path moves to Logins’ tab without a reload', async () => {
    const view = await mountHost();
    await click(view.container, '[data-add-row="login"]');
    expect(window.location.pathname).toBe('/d/d1/settings/logins/logins');
    expect(window.location.hash).toBe('#machines/studio-mac/sign-ins');
  });
});

/**
 * The two slots the page offers, filled by stand-in panels: they draw what the page handed them (the props the contract
 * names, and the subject) and answer through the callbacks only, as Logins' real panels do (its own suite draws those).
 */
const PLACED: Record<string, readonly PlacedPanel[]> = {
  [ADD_RUNTIME_LOGIN_SLOT]: [
    {
      plugin: 'logins',
      id: 'add-runtime-login',
      view: props => (
        <div data-fake-add-login={String(isAddRuntimeLoginSlotProps(props))}>
          <button
            type="button"
            data-fake-add=""
            onClick={() => (props['onAdded'] as (id: string) => void)('claude-new')}
          >
            Add
          </button>
        </div>
      ),
    },
  ],
  [ADD_RUNTIME_SIGN_IN_SLOT]: [
    {
      plugin: 'logins',
      id: 'add-runtime-sign-in',
      view: props => (
        <div
          data-fake-sign-in={`${String(props['subject'])}:${String(props['harness'])}:${String(isAddRuntimeSignInSlotProps(props))}`}
        >
          <button type="button" data-fake-signed-in="" onClick={() => (props['onSignedIn'] as () => void)()}>
            Done
          </button>
        </div>
      ),
    },
  ],
};

const NEW_LOGIN: MachineData = {
  ...DATA,
  credentials: credentialsOf(
    credential({ id: 'claude-new', label: 'new', ...withStatus('needs_sign_in'), usedBy: [] }),
    CREDENTIALS.logins[0] as unknown as Record<string, unknown>,
  ),
};

describe('Add runtime: a login added and signed in right here', () => {
  it('opens Logins’ add-login panel under the list, and Cancel closes it', async () => {
    const view = await mountHost({ slots: PLACED });
    const row = must(view.container.querySelector<HTMLButtonElement>('[data-add-row="login"]'), 'login row');
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('href')).toBeNull();
    expect(row.textContent).toBe('Add a new login');
    expect(view.container.querySelector('[data-slot]')).toBeNull();
    await click(view.container, '[data-add-row="login"]');
    expect(text(view.container, '[data-add-row="login"]')).toBe('Cancel adding a login');
    expect(
      view.container.querySelector(`[data-slot="${ADD_RUNTIME_LOGIN_SLOT}"] [data-fake-add-login="true"]`),
    ).not.toBeNull();
    expect(window.location.pathname).toBe(SETTINGS);
    await click(view.container, '[data-add-row="login"]');
    expect(view.container.querySelector('[data-slot]')).toBeNull();
  });

  it('a login added there is re-read, listed and picked, and the panel closes', async () => {
    const reloads: string[] = [];
    const view = await mountHost({ slots: PLACED, after: NEW_LOGIN, reloads });
    expect(view.container.querySelector('[data-add-runtime-credential="claude-new"]')).toBeNull();
    await click(view.container, '[data-add-row="login"]');
    await click(view.container, '[data-fake-add]');
    await settle();
    expect(reloads).toEqual(['reload']);
    expect(view.container.querySelector('[data-slot]')?.getAttribute('data-slot')).toBe(ADD_RUNTIME_SIGN_IN_SLOT);
    expect(loginShown(view.container)).toBe('Claude · Claude.ai sign-in (new)');
    expect(view.container.querySelector('[data-add-runtime-part="profile"]')).not.toBeNull();
  });

  it('E13: a picked login that needs sign-in draws Logins’ sign-in panel for it, and a finished one re-reads', async () => {
    const reloads: string[] = [];
    const view = await mountHost({ data: SIGN_IN_NEEDED, slots: PLACED, reloads });
    await pickLogin(view.container, 'claude-work');
    expect(text(view.container, '[data-add-runtime-needs-sign-in]')).toContain(
      'This login needs sign-in before you launch.',
    );
    expect(view.container.querySelector('a[data-add-runtime-sign-in]')).toBeNull();
    expect(
      view.container
        .querySelector(
          `[data-add-runtime-sign-in-panel="claude-work"] [data-slot="${ADD_RUNTIME_SIGN_IN_SLOT}"] [data-fake-sign-in]`,
        )
        ?.getAttribute('data-fake-sign-in'),
    ).toBe('claude-work:claude-code:true');
    await click(view.container, '[data-fake-signed-in]');
    expect(reloads).toEqual(['reload']);
  });

  it('with no panel placed in a slot each falls back to the link to Logins’ Sign-ins tab', async () => {
    const view = await mountHost({ data: SIGN_IN_NEEDED, slots: { [ADD_RUNTIME_LOGIN_SLOT]: [] } });
    expect(view.container.querySelector('[data-add-row="login"]')?.getAttribute('href')).toBe(SIGN_INS);
    await pickLogin(view.container, 'claude-work');
    expect(view.container.querySelector('[data-add-runtime-sign-in]')?.getAttribute('href')).toBe(
      `${SIGN_INS}/claude-work`,
    );
  });

  it('off a machine page there is no daemon to draw the slots for, so the link stays', async () => {
    window.history.pushState({}, '', '/');
    const view = await mountHost({ slots: PLACED });
    expect(view.container.querySelector('[data-add-row="login"]')?.tagName).toBe('A');
    expect(view.container.querySelector('[data-add-row="login"]')?.getAttribute('href')).toBe(
      '#machines/studio-mac/sign-ins',
    );
  });
});

describe('Add runtime: Profile', () => {
  const pick = async (container: ParentNode, login: string): Promise<void> => await pickLogin(container, login);

  it('offers the profiles that fit, already on one that is not yet a runtime, with a suggested name', async () => {
    const view = await mountHost();
    await pick(view.container, 'claude-personal');
    expect(await profilesOf(view.container)).toEqual(['Default', 'Claude hooks', 'Agent work', 'Review']);
    expect(profileShown(view.container)).toBe('Claude hooks');
    expect(submit(view.container).disabled).toBe(false);
    await pickProfile(view.container, 'Agent work');
  });

  it('links to Profiles for building or changing one', async () => {
    const view = await mountHost();
    await pick(view.container, 'claude-personal');
    const link = must(view.container.querySelector('[data-add-runtime-profiles-link]'), 'link');
    expect(link.getAttribute('href')).toBe(PROFILES_TAB);
    expect(link.textContent).toBe('Build or change profiles in Profiles');
    expect(view.container.querySelector('[data-add-row="profile"]')).toBeNull();
  });

  it('E14, P7: only profiles that apply to the login’s tool are offered', async () => {
    const view = await mountHost();
    await pick(view.container, 'codex');
    expect(await profilesOf(view.container)).not.toContain('Claude hooks');
    expect(await profilesOf(view.container)).toContain('Default');
    const scoped: MachineData = {
      ...DATA,
      profiles: LayeredProfileCatalogSchema.parse({
        ...PROFILES,
        profiles: [
          profile({ name: 'Codex work', scope: { kind: 'scoped', scope: 'codex' } }),
          profile({ name: 'Old mix', scope: { kind: 'mixed', sentence: "Profile Old mix can't be both." } }),
          profile({ name: 'Claude work', scope: { kind: 'scoped', scope: 'claude-code' } }),
        ],
      }),
    };
    const other = await mountHost({ data: scoped });
    expect(await profilesOf(other.container)).toEqual(['Claude work']);
  });

  it('says so when the machine has no profiles', async () => {
    const view = await mountHost({ data: NO_PROFILES });
    await pick(view.container, 'claude-personal');
    expect(text(view.container, '[data-add-runtime-no-profiles]')).toBe(
      'No profile on studio-mac applies to Claude Code yet.',
    );
    expect(view.container.querySelector('#add-runtime-profile')).toBeNull();
    expect(view.container.querySelector('[data-add-runtime-profiles-link]')).not.toBeNull();
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
  });

  it('E15: the same login and profile needs "Add another anyway"; picking another profile starts over', async () => {
    const view = await mountHost();
    await pick(view.container, 'claude-personal');
    await pickProfile(view.container, 'Review');
    const duplicate = must(view.container.querySelector('[data-add-runtime-duplicate]'), 'duplicate');
    expect(duplicate.textContent).toContain(
      'Claude · your terminal sign-in (personal) — Review profile already uses this login and profile.',
    );
    expect(duplicate.textContent).toContain('Add another anyway');
    expect(submit(view.container).disabled).toBe(true);

    await click(view.container, '[data-duplicate-ok]');
    expect(must(view.container.querySelector<HTMLInputElement>('[data-duplicate-ok]'), 'checkbox').checked).toBe(true);
    expect(submit(view.container).disabled).toBe(false);

    await pickProfile(view.container, 'Default');
    expect(view.container.querySelector('[data-add-runtime-duplicate]')).not.toBeNull();
    await pickProfile(view.container, 'Claude hooks');
    expect(view.container.querySelector('[data-add-runtime-duplicate]')).toBeNull();
    await pickProfile(view.container, 'Review');
    expect(must(view.container.querySelector<HTMLInputElement>('[data-duplicate-ok]'), 'checkbox').checked).toBe(false);
  });
});

describe('Add runtime: Name and Create', () => {
  const ready = async (options: HostOptions = {}) => {
    const view = await mountHost(options);
    await pickLogin(view.container, 'claude-personal');
    await pickProfile(view.container, 'Claude hooks');
    return view;
  };

  it('O9-5 has no Name field: the id the runtime is stored under is made for it and never typed or shown', async () => {
    const view = await ready();
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(view.container.querySelector('[data-add-runtime-part="name"]')).toBeNull();
    expect(view.container.querySelector('[data-add-runtime-id]')).toBeNull();
    expect(view.container.querySelector('[data-runtime-name-problem]')).toBeNull();
    expect(view.container.textContent).not.toContain('claude-claude-hooks');
    expect(submit(view.container).disabled).toBe(false);
  });

  it('creates the runtime with exactly what was chosen, re-reads, and shows the made panel', async () => {
    const calls: Call[] = [];
    const reloads: string[] = [];
    const finishes: (string | null)[] = [];
    const after = withRuntime(
      DATA,
      runtime({
        name: 'claude-claude-hooks',
        profile: 'Claude hooks',
        credential: { id: 'claude-personal', store: 'host', status: 'ready' },
      }),
    );
    const view = await ready({ calls, reloads, finishes, after, routes: STAGED_ROUTES(after) });
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(proposed(calls)).toEqual([
      {
        change: {
          kind: 'runtime.put',
          name: 'claude-claude-hooks',
          credential: 'claude-personal',
          profile: 'Claude hooks',
          create: true,
        },
      },
    ]);
    expect(reloads).toEqual(['reload']);
    expect(view.container.querySelector('[data-add-runtime-made="claude-claude-hooks"]')).not.toBeNull();
    expect(text(view.container, '[data-add-runtime-done]')).toContain(
      'Claude · your terminal sign-in is ready to launch',
    );
    expect(text(view.container, '[data-add-runtime-done]')).not.toContain('claude-claude-hooks');
    expect(text(view.container, '[data-add-runtime-done]')).toContain('Claude Code · Claude hooks profile');
    expect(text(view.container, '[data-add-runtime-done]')).not.toContain('Sign in before you launch');
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(text(view.container, '[data-add-runtime-finish="list"]')).toBe('Back to Runtimes');
    expect(text(view.container, '[data-add-runtime-finish="open"]')).toBe('Open this runtime');
    await click(view.container, '[data-add-runtime-finish="list"]');
    await click(view.container, '[data-add-runtime-finish="open"]');
    await click(view.container, '[data-page-back]');
    expect(finishes).toEqual([null, 'claude-claude-hooks', null]);
  });

  it('sends add-another when asked for', async () => {
    const calls: Call[] = [];
    const view = await mountHost({ calls, routes: STAGED_ROUTES() });
    await pickLogin(view.container, 'claude-personal');
    await pickProfile(view.container, 'Review');
    await click(view.container, '[data-duplicate-ok]');
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(proposed(calls)).toEqual([
      {
        change: {
          kind: 'runtime.put',
          name: 'claude-review-2',
          credential: 'claude-personal',
          profile: 'Review',
          create: true,
          addAnother: true,
        },
      },
    ]);
    // The re-read did not list it, so the panel still reads without its details.
    expect(text(view.container, '[data-add-runtime-done]')).toContain('claude-review-2 is ready to launch');
    expect(text(view.container, '[data-add-runtime-done]')).not.toContain('profile');
  });

  it('says to sign in before launching when the made runtime’s login needs it', async () => {
    const after = withRuntime(
      SIGN_IN_NEEDED,
      runtime({
        name: 'claude-claude-hooks',
        profile: 'Claude hooks',
        credential: { id: 'claude-work', store: 'ferretry', status: 'needs_sign_in' },
      }),
    );
    const view = await mountHost({ data: SIGN_IN_NEEDED, after, routes: STAGED_ROUTES(after) });
    await pickLogin(view.container, 'claude-work');
    await pickProfile(view.container, 'Claude hooks');
    await interact(() => submit(view.container).click());
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(text(view.container, '[data-add-runtime-done]')).toContain(
      'Claude hooks profile. Sign in to its login before you launch it.',
    );
    // One true thing: added, and not yet launchable. Never "ready" and "sign in first" in one line.
    expect(text(view.container, '[data-add-runtime-done]')).toContain('is added');
    expect(text(view.container, '[data-add-runtime-done]')).not.toContain('ready');
  });

  it('R3-M1: a rolled-back apply names the file that stayed, and the form does not say the runtime is made', async () => {
    const reloads: string[] = [];
    const view = await ready({
      reloads,
      routes: { ...READS(), [PROPOSE]: (call: Call) => stagedFrom(call), [APPLY]: ROLLED_BACK },
    });
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-change-refusal]');
    const alert = must(view.container.querySelector('[data-change-refusal]'), 'alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toStartWith('This change was not applied: the fleet apply failed and was rolled back.');
    expect(alert.textContent).toContain(LANDED_FILE);
    expect(alert.textContent).toContain('put that file back as it was, or delete it if it did not exist before');
    expect(alert.textContent).not.toContain('remove that file');
    expect(view.container.querySelector('[data-add-runtime-done]')).toBeNull();
    expect(reloads).toEqual([]);
  });

  it('R3-M1: a rollback-incomplete apply names the paths left partly changed and says the machine needs a look', async () => {
    const reloads: string[] = [];
    const view = await ready({
      reloads,
      routes: { ...READS(), [PROPOSE]: (call: Call) => stagedFrom(call), [APPLY]: ROLLBACK_INCOMPLETE },
    });
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-change-refusal]');
    const said = text(view.container, '[data-change-refusal]');
    expect(said).toContain('could not be fully put back');
    expect(said).toContain('needs a look');
    expect(said).toContain(UNRESTORED_PATH);
    expect(said).toContain(BACKUP_PATH);
    expect(said).toContain(LANDED_FILE);
    expect(view.container.querySelector('[data-add-runtime-done]')).toBeNull();
    expect(reloads).toEqual([]);
  });

  it('R3-M1: a finished apply still makes the runtime', async () => {
    const view = await ready({
      routes: { ...READS(), [PROPOSE]: (call: Call) => stagedFrom(call), [APPLY]: COMMITTED },
    });
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(view.container.querySelector('[data-change-refusal]')).toBeNull();
  });

  it('a refusal is one sentence on the form, and nothing moves on until it works', async () => {
    let refuse = true;
    const reloads: string[] = [];
    const view = await ready({
      reloads,
      routes: {
        ...READS(),
        [PROPOSE]: (call: Call) =>
          refuse
            ? refusal('This change conflicts with the setup on this machine.', 409, 'fleet_change_conflict')
            : stagedFrom(call),
        [APPLY]: APPLIED,
      },
    });
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-change-refusal]');
    expect(text(view.container, '[data-change-refusal]')).toBe('This change conflicts with the setup on this machine.');
    expect(view.container.querySelector('[data-add-runtime-done]')).toBeNull();
    expect(reloads).toEqual([]);
    refuse = false;
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-done]');
  });
});

describe('Add runtime: a login that drives both CLIs', () => {
  const DUAL = credential({
    id: 'deepseek',
    store: 'environment',
    email: undefined,
    harnesses: ['claude-code', 'codex'],
    usedBy: [],
  });
  const DUAL_DATA: MachineData = {
    ...DATA,
    credentials: credentialsOf(CREDENTIALS.logins[0] as unknown as Record<string, unknown>, DUAL),
    profiles: LayeredProfileCatalogSchema.parse({
      ...PROFILES,
      profiles: [
        profile({ name: 'Default' }),
        profile({ name: 'Codex work', scope: { kind: 'scoped', scope: 'codex' } }),
      ],
    }),
  };
  const runsAt = (container: ParentNode) =>
    container.querySelector('[data-add-runtime-runs]')?.getAttribute('data-add-runtime-runs');

  it('is offered once, and says under the login which of its CLIs is not installed', async () => {
    const view = await mountHost({ data: DUAL_DATA, machine: NOT_INSTALLED_CODEX });
    expect(await loginsOf(view.container)).toEqual(['Claude · your terminal sign-in (personal)', 'Claude · API key']);
    await openBox(loginBox(view.container));
    expect(optionsOpen().find(option => labelOf(option) === 'Claude · API key')?.textContent).toContain('id deepseek');
    await closeBox(loginBox(view.container));
    await pickLogin(view.container, 'deepseek');
    expect(text(view.container, '[data-add-runtime-login-sub]')).toContain('Codex isn’t installed here');
  });

  it('Runs sits under More options and follows the CLI chosen: only profiles that fit it are offered', async () => {
    const view = await mountHost({ data: DUAL_DATA });
    await pickLogin(view.container, 'deepseek');
    expect(view.container.querySelector('[data-add-runtime-more]')).not.toBeNull();
    expect(runsAt(view.container)).toBe('claude-code');
    expect(text(view.container, '[data-add-runtime-runs]')).toContain('Claude Code until you choose');
    expect(await profilesOf(view.container)).toEqual(['Default']);
    await click(view.container, '[data-add-runtime-runs-option="codex"] input');
    expect(runsAt(view.container)).toBe('codex');
    expect(text(view.container, '[data-add-runtime-runs]')).not.toContain('until you choose');
    expect(await profilesOf(view.container)).toEqual(['Default', 'Codex work']);
    await pickProfile(view.container, 'Codex work');
    await click(view.container, '[data-add-runtime-runs-option="claude-code"] input');
    expect(await profilesOf(view.container)).toEqual(['Default']);
  });

  it('sends the CLI it runs with the runtime, and names it on the made panel', async () => {
    const calls: Call[] = [];
    const after = withRuntime(
      DUAL_DATA,
      runtime({
        name: 'codex-codex-work',
        harness: 'codex',
        profile: 'Codex work',
        credential: { id: 'deepseek', store: 'environment', status: 'ready' },
      }),
    );
    const view = await mountHost({ data: DUAL_DATA, after, calls, routes: STAGED_ROUTES(after) });
    await pickLogin(view.container, 'deepseek');
    await click(view.container, '[data-add-runtime-runs-option="codex"] input');
    await pickProfile(view.container, 'Codex work');
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(proposed(calls)).toEqual([
      {
        change: {
          kind: 'runtime.put',
          name: 'codex-codex-work',
          credential: 'deepseek',
          profile: 'Codex work',
          harness: 'codex',
          create: true,
        },
      },
    ]);
    expect(text(view.container, '[data-add-runtime-done]')).toContain('Codex · Codex work profile');
  });

  it('offers no Runs choice for a login that drives one CLI', async () => {
    const view = await mountHost();
    expect(view.container.querySelector('[data-add-runtime-runs]')).toBeNull();
  });
});
