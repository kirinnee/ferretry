import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LayeredProfileCatalogSchema, type MachineView } from '../../../../../../contract/index.ts';
import { AddRuntime } from '../../../../../../app/features/fleet/runtimes/add-runtime.tsx';
import type { MachineData } from '../../../../../../app/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../../app/features/fleet/shell/apply-change-panel.tsx';
import { useState } from 'react';
import { interact, type Mounted, mount as mountView, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  credential,
  DATA,
  machine,
  PROFILES,
  profile,
  READS,
  runtime,
  scripted,
  stagedFrom,
  withStatus,
} from '../account-support.ts';
import { credentialsOf, NOT_INSTALLED_CODEX, refusal, withRuntime } from './support-b.ts';

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

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

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
}

const mountHost = async (options: HostOptions = {}) => {
  const client = scripted(options.routes ?? READS(), options.calls);
  const initial = options.data ?? DATA;

  function Host() {
    const [data, setData] = useState<MachineData>(initial);
    const changes = useAccountChanges({ client });
    return (
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

const nameInput = (container: ParentNode): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>('#add-runtime-name'), 'name input');

const submit = (container: ParentNode): HTMLButtonElement =>
  must([...container.querySelectorAll<HTMLButtonElement>('[data-change-submit]')].at(-1), 'submit');

describe('Add runtime: the page', () => {
  it('is one form: a way back, the Login part, and nothing else until a login is picked', async () => {
    const finishes: (string | null)[] = [];
    const view = await mountHost({ finishes });
    expect(text(view.container, 'h3')).toBe('Add a runtime');
    expect(text(view.container, '[data-page-back]')).toBe('Runtimes');
    expect(view.container.textContent).toContain(
      'A runtime is a login plus a profile. It’s what you launch on studio-mac.',
    );
    expect(view.container.querySelectorAll('[data-add-runtime-part]')).toHaveLength(1);
    expect(view.container.querySelector('[data-add-runtime-part="login"]')).not.toBeNull();
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(submit(view.container).textContent).toBe('Create runtime');
    expect(submit(view.container).disabled).toBe(true);
    await click(view.container, '[data-page-back]');
    expect(finishes).toEqual([null]);
  });

  it('waits while the machine is offline, even with everything chosen', async () => {
    const view = await mountHost({ online: false });
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(nameInput(view.container).value).toBe('claude-claude-hooks');
    expect(submit(view.container).disabled).toBe(true);
  });
});

describe('Add runtime: Login', () => {
  it('lists the logins, claude first, with their status and use', async () => {
    const view = await mountHost();
    const rows = [...view.container.querySelectorAll('[data-add-runtime-credential]')];
    expect(rows.map(row => row.getAttribute('data-add-runtime-credential'))).toEqual([
      'claude-personal',
      'claude-work',
      'codex',
    ]);
    const personal = text(view.container, '[data-add-runtime-credential="claude-personal"]');
    expect(personal).toContain('you@example.com');
    expect(personal).toContain('personal');
    expect(personal).toContain('Claude Code');
    expect(personal).toContain('Ready');
    expect(personal).toContain('used by 3 runtimes');
    expect(text(view.container, '[data-add-runtime-credential="codex"]')).toContain('used by 1 runtime');
    expect(text(view.container, '[data-add-runtime-credential="claude-work"]')).toContain('Refresh due');
    expect(view.container.querySelector('[data-add-runtime-no-logins]')).toBeNull();
  });

  it('says on the login when its tool is not installed here', async () => {
    const view = await mountHost({ machine: NOT_INSTALLED_CODEX });
    expect(text(view.container, '[data-add-runtime-credential="codex"]')).toContain('Codex isn’t installed here');
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).not.toContain('installed here');
  });

  it('E12: with no logins it says so and offers to add one', async () => {
    const view = await mountHost({ data: NO_LOGINS });
    expect(text(view.container, '[data-add-runtime-no-logins]')).toBe(
      'There are no logins on studio-mac yet. Add one below: sign in to Claude Code or Codex, or use a provider key.',
    );
    expect(view.container.querySelector('[data-add-runtime-credential]')).toBeNull();
    // Today's row opened a sign-in in place; this one is a link to Logins' tab (GAP(logins)).
    expect(text(view.container, '[data-add-row="login"]')).toBe('Add a new login in Sign-ins');
    expect(view.container.querySelector('[data-add-row="login"]')?.getAttribute('href')).toBe(SIGN_INS);
  });

  it('picking a login shows its Profile; picking another clears what was chosen after it', async () => {
    const view = await mountHost();
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    expect(view.container.querySelector('[data-add-runtime-part="profile"]')).not.toBeNull();
    await click(view.container, '[data-add-runtime-profile="Review"] input');
    await click(view.container, '[data-duplicate-ok]');
    expect(nameInput(view.container).value).toBe('claude-review-2');
    await click(view.container, '[data-add-runtime-credential="codex"] input');
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-profile="Review"] input'), 'review')
        .checked,
    ).toBe(false);
    expect(view.container.querySelector('[data-add-runtime-duplicate]')).toBeNull();
  });

  it('E13: a login that needs sign-in says so and links to the sign-in', async () => {
    const view = await mountHost({ data: SIGN_IN_NEEDED });
    expect(view.container.querySelector('[data-add-runtime-needs-sign-in]')).toBeNull();
    await click(view.container, '[data-add-runtime-credential="claude-work"] input');
    expect(text(view.container, '[data-add-runtime-needs-sign-in]')).toContain(
      'This login needs sign-in before you launch.',
    );
    expect(view.container.querySelector('[data-add-runtime-sign-in]')?.getAttribute('href')).toBe(
      `${SIGN_INS}/claude-work`,
    );
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    expect(view.container.querySelector('[data-add-runtime-needs-sign-in]')).toBeNull();
  });

  it.skip('E13: a login that needs sign-in can be signed in right there … pending port: Logins CredentialSignIn', () => {});
});

describe('Add runtime: Add a new login', () => {
  it('links to Logins’ Sign-ins tab instead of opening a sign-in in place', async () => {
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

  it.skip('opens in place under the list, offers a sign-in per tool, and Cancel closes it … pending port: Logins NewLogin', () => {});
  it.skip('Sign in to Claude Code makes the login, starts its sign-in, and "Use it, sign in later" picks it … pending port: Logins NewLogin', () => {});
  it.skip('a sign-in finished here picks the new login and re-reads … pending port: Logins CredentialSignIn', () => {});
  it.skip('a sign-in that cannot start still leaves the login made, says why, and lets it be used … pending port: Logins CredentialSignIn', () => {});
  it.skip('a login that cannot be made says why right there, and the form below says nothing of it … pending port: Logins NewLogin', () => {});
  it.skip('Provider key shows the provider grid; Sign in goes back; a key added there comes back picked … pending port: Logins provider grid', () => {});
});

describe('Add runtime: Profile', () => {
  const pick = async (container: ParentNode, login: string): Promise<void> =>
    await click(container, `[data-add-runtime-credential="${login}"] input`);

  it('lists the profiles with their size; a pick brings the Name with a suggestion', async () => {
    const view = await mountHost();
    await pick(view.container, 'claude-personal');
    const names = [...view.container.querySelectorAll('[data-add-runtime-profile]')].map(row =>
      row.getAttribute('data-add-runtime-profile'),
    );
    expect(names).toEqual(['Default', 'Claude hooks', 'Agent work', 'Review']);
    expect(text(view.container, '[data-add-runtime-profile="Default"]')).toContain('2 parts');
    expect(view.container.querySelector('[data-add-runtime-profile="Default"] [data-tone="warn"]')).toBeNull();
    expect(view.container.querySelector('[data-profile-unavailable]')).toBeNull();
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(submit(view.container).disabled).toBe(true);
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(nameInput(view.container).value).toBe('claude-claude-hooks');
    expect(submit(view.container).disabled).toBe(false);
  });

  it('links to Profiles for building or changing one', async () => {
    const view = await mountHost();
    await pick(view.container, 'claude-personal');
    const link = must(view.container.querySelector('[data-add-runtime-profiles-link]'), 'link');
    expect(link.getAttribute('href')).toBe(PROFILES_TAB);
    expect(link.textContent).toBe('Build or change profiles in Profiles');
    expect(view.container.querySelector('[data-add-row="profile"]')).toBeNull();
  });

  it('E14: a profile that does not apply to the login’s tool is disabled, with the machine’s reason; partial fits carry notes', async () => {
    const view = await mountHost();
    await pick(view.container, 'codex');
    const hooks = must(
      view.container.querySelector<HTMLInputElement>('[data-add-runtime-profile="Claude hooks"] input'),
      'hooks radio',
    );
    expect(hooks.disabled).toBe(true);
    expect(text(view.container, '[data-profile-unavailable]')).toBe(
      'Only Claude settings. Nothing here applies on Codex.',
    );
    const notes = [...view.container.querySelectorAll('[data-add-runtime-profile="Default"] [data-tone="warn"]')];
    expect(notes.map(note => note.textContent)).toEqual([
      'Claude settings will be skipped on Codex',
      'Partly supported on Codex',
    ]);
    expect(text(view.container, '[data-add-runtime-profile="Default"]')).toContain('3 parts');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
  });

  it("P7: offers Generic and this login's own profiles first; the other tool's and a mixed one wait below, disabled, saying why", async () => {
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
    const view = await mountHost({ data: scoped });
    await pick(view.container, 'claude-personal');
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-add-runtime-profile]')];
    expect(rows.map(row => row.dataset.addRuntimeProfile)).toEqual(['Claude work', 'Codex work', 'Old mix']);
    expect(text(view.container, '[data-add-runtime-profile="Claude work"]')).toContain('Claude only');
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-profile="Codex work"] input'), 'codex')
        .disabled,
    ).toBe(true);
    expect(text(view.container, '[data-add-runtime-profile="Codex work"] [data-profile-unavailable]')).toBe(
      'Codex only — this login is Claude Code',
    );
    expect(text(view.container, '[data-add-runtime-profile="Old mix"] [data-profile-unavailable]')).toBe(
      "Profile Old mix can't be both.",
    );
  });

  it('says so when the machine has no profiles', async () => {
    const view = await mountHost({ data: NO_PROFILES });
    await pick(view.container, 'claude-personal');
    expect(text(view.container, '[data-add-runtime-part="profile"]')).toContain(
      'There are no profiles on studio-mac yet.',
    );
    expect(view.container.querySelector('[data-add-runtime-profile]')).toBeNull();
    expect(view.container.querySelector('[data-add-runtime-profiles-link]')).not.toBeNull();
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
  });

  it('E15: the same login and profile needs "Add another anyway"; picking another profile starts over', async () => {
    const view = await mountHost();
    await pick(view.container, 'claude-personal');
    await click(view.container, '[data-add-runtime-profile="Review"] input');
    const duplicate = must(view.container.querySelector('[data-add-runtime-duplicate]'), 'duplicate');
    expect(duplicate.textContent).toContain('claude-review already uses this login and profile.');
    expect(duplicate.textContent).toContain('Add another anyway');
    expect(submit(view.container).disabled).toBe(true);

    await click(view.container, '[data-duplicate-ok]');
    expect(must(view.container.querySelector<HTMLInputElement>('[data-duplicate-ok]'), 'checkbox').checked).toBe(true);
    expect(nameInput(view.container).value).toBe('claude-review-2');
    expect(submit(view.container).disabled).toBe(false);

    await click(view.container, '[data-add-runtime-profile="Default"] input');
    expect(view.container.querySelector('[data-add-runtime-duplicate]')).not.toBeNull();
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(view.container.querySelector('[data-add-runtime-duplicate]')).toBeNull();
    await click(view.container, '[data-add-runtime-profile="Review"] input');
    expect(must(view.container.querySelector<HTMLInputElement>('[data-duplicate-ok]'), 'checkbox').checked).toBe(false);
  });
});

describe('Add runtime: Name and Create', () => {
  const ready = async (options: HostOptions = {}) => {
    const view = await mountHost(options);
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    return view;
  };

  it('shows the suggested name and the agent choice', async () => {
    const view = await ready();
    expect(nameInput(view.container).value).toBe('claude-claude-hooks');
    expect(view.container.querySelector('[data-runtime-name-problem]')).toBeNull();
    expect(text(view.container, '[data-add-runtime-part="name"]')).toContain(
      'Letters, digits and dashes. You type this to launch it.',
    );
    expect(text(view.container, '[data-add-runtime-agent]')).toContain('Ferretry launches this as an agent');
    expect(text(view.container, '[data-add-runtime-agent]')).toContain(
      'Adds Ferretry’s fixed layer last: no trust or onboarding prompts, and the machine’s agent permissions.',
    );
    expect(submit(view.container).disabled).toBe(false);
  });

  it('E16: an invalid name says why, offers one that works, and cannot be created until fixed', async () => {
    const view = await ready();
    await type(nameInput(view.container), 'bad name!');
    expect(text(view.container, '[data-runtime-name-problem]')).toContain('Use only letters, digits and dashes.');
    expect(nameInput(view.container).getAttribute('aria-invalid')).toBe('true');
    expect(submit(view.container).disabled).toBe(true);
    expect(text(view.container, '[data-runtime-name-suggestion]')).toBe('Use bad-name');
    await click(view.container, '[data-runtime-name-suggestion]');
    expect(nameInput(view.container).value).toBe('bad-name');
    expect(view.container.querySelector('[data-runtime-name-problem]')).toBeNull();
    expect(submit(view.container).disabled).toBe(false);
  });

  it('E16: a name already taken offers the next free one', async () => {
    const view = await ready();
    await type(nameInput(view.container), 'claude-default');
    expect(text(view.container, '[data-runtime-name-problem]')).toContain(
      'claude-default is already a runtime on studio-mac.',
    );
    expect(text(view.container, '[data-runtime-name-suggestion]')).toBe('Use claude-default-2');
    await click(view.container, '[data-runtime-name-suggestion]');
    expect(nameInput(view.container).value).toBe('claude-default-2');
  });

  it('an empty name asks for one and offers nothing; spaces typed around a name are trimmed', async () => {
    const view = await ready();
    await type(nameInput(view.container), '');
    expect(text(view.container, '[data-runtime-name-problem]')).toContain('Give the runtime a name.');
    expect(view.container.querySelector('[data-runtime-name-suggestion]')).toBeNull();
    expect(submit(view.container).disabled).toBe(true);
    await type(nameInput(view.container), '  spaced  ');
    expect(nameInput(view.container).value).toBe('spaced');
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
    await click(view.container, '[data-add-runtime-agent] input');
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(proposed(calls)).toEqual([
      {
        change: {
          kind: 'runtime.put',
          name: 'claude-claude-hooks',
          credential: 'claude-personal',
          profile: 'Claude hooks',
          agent: true,
          create: true,
        },
      },
    ]);
    expect(reloads).toEqual(['reload']);
    expect(view.container.querySelector('[data-add-runtime-made="claude-claude-hooks"]')).not.toBeNull();
    expect(text(view.container, '[data-add-runtime-done]')).toContain('claude-claude-hooks is ready to launch');
    expect(text(view.container, '[data-add-runtime-done]')).toContain('Claude Code · Claude hooks profile');
    expect(text(view.container, '[data-add-runtime-done]')).not.toContain('Sign in before you launch');
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(text(view.container, '[data-add-runtime-finish="list"]')).toBe('Back to Runtimes');
    expect(text(view.container, '[data-add-runtime-finish="open"]')).toBe('Open claude-claude-hooks');
    await click(view.container, '[data-add-runtime-finish="list"]');
    await click(view.container, '[data-add-runtime-finish="open"]');
    await click(view.container, '[data-page-back]');
    expect(finishes).toEqual([null, 'claude-claude-hooks', null]);
  });

  it('sends add-another when asked for, and a typed name', async () => {
    const calls: Call[] = [];
    const view = await mountHost({ calls, routes: STAGED_ROUTES() });
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    await click(view.container, '[data-add-runtime-profile="Review"] input');
    await click(view.container, '[data-duplicate-ok]');
    await type(nameInput(view.container), 'my-review');
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(proposed(calls)).toEqual([
      {
        change: {
          kind: 'runtime.put',
          name: 'my-review',
          credential: 'claude-personal',
          profile: 'Review',
          agent: false,
          create: true,
          addAnother: true,
        },
      },
    ]);
    // The re-read did not list it, so the panel still reads without its details.
    expect(text(view.container, '[data-add-runtime-done]')).toContain('my-review is ready to launch');
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
    await click(view.container, '[data-add-runtime-credential="claude-work"] input');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    await interact(() => submit(view.container).click());
    await waitFor(view.container, '[data-add-runtime-done]');
    expect(text(view.container, '[data-add-runtime-done]')).toContain(
      'Claude hooks profile. Sign in before you launch.',
    );
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
    expect(nameInput(view.container).value).toBe('claude-claude-hooks');
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

  it('is offered once, with its Claude + Codex chip, and says which of its CLIs is not installed', async () => {
    const view = await mountHost({ data: DUAL_DATA, machine: NOT_INSTALLED_CODEX });
    const rows = [...view.container.querySelectorAll('[data-add-runtime-credential]')];
    expect(rows.map(row => row.getAttribute('data-add-runtime-credential'))).toEqual(['claude-personal', 'deepseek']);
    const row = text(view.container, '[data-add-runtime-credential="deepseek"]');
    expect(row).toContain('Claude Code + Codex ·');
    expect(row).toContain('Claude + Codex');
    expect(row).toContain('Codex isn’t installed here');
    expect(
      view.container
        .querySelector('[data-add-runtime-credential="deepseek"] [data-login-scope]')
        ?.getAttribute('data-login-scope'),
    ).toBe('both');
  });

  it('Runs follows a scoped profile until chosen; choosing a CLI drops a profile that no longer fits', async () => {
    const view = await mountHost({ data: DUAL_DATA });
    await click(view.container, '[data-add-runtime-credential="deepseek"] input');
    expect(runsAt(view.container)).toBe('claude-code');
    expect(text(view.container, '[data-add-runtime-runs]')).toContain('picked from the profile until you choose');
    const codexWork = () =>
      must(
        view.container.querySelector<HTMLInputElement>('[data-add-runtime-profile="Codex work"] input'),
        'Codex work',
      );
    expect(codexWork().disabled).toBe(false);
    await click(view.container, '[data-add-runtime-profile="Codex work"] input');
    expect(runsAt(view.container)).toBe('codex');
    expect(nameInput(view.container).value).toBe('codex-codex-work');
    await click(view.container, '[data-add-runtime-runs-option="claude-code"] input');
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(codexWork().disabled).toBe(true);
    expect(text(view.container, '[data-add-runtime-runs]')).not.toContain('until you choose');
    await click(view.container, '[data-add-runtime-profile="Default"] input');
    await click(view.container, '[data-add-runtime-runs-option="codex"] input');
    expect(nameInput(view.container).value).toBe('codex-default-2');
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
    await click(view.container, '[data-add-runtime-credential="deepseek"] input');
    await click(view.container, '[data-add-runtime-profile="Codex work"] input');
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
          agent: false,
          create: true,
        },
      },
    ]);
    expect(text(view.container, '[data-add-runtime-done]')).toContain('Codex · Codex work profile');
  });

  it('offers no Runs choice for a login that drives one CLI', async () => {
    const view = await mountHost();
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    expect(view.container.querySelector('[data-add-runtime-runs]')).toBeNull();
  });
});
