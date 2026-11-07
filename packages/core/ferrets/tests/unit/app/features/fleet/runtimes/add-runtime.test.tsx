import { describe, expect, it } from 'bun:test';
import {
  type FleetCredentialList,
  FleetCredentialListSchema,
  FleetLayeredProfileCatalogSchema,
  type FleetMachineView,
  FleetRuntimeCatalogSchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { AddRuntime } from '../../../../../src/features/fleet/runtimes/add-runtime.tsx';
import type { MachineData } from '../../../../../src/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../src/features/fleet/shell/apply-change-panel.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  claudeFlow,
  credential,
  DATA,
  machine,
  PROFILES,
  profile,
  READS,
  RUNTIMES,
  runtime,
  STUDIO,
  scripted,
  stagedFrom,
  withStatus,
} from '../account-support.ts';
import { DEEPSEEK, PROVIDERS } from '../credentials/environment-support.ts';

const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;
const PROPOSE = 'POST /v1/fleet/proposals';
const LOGIN = 'POST /v1/fleet/login';

const credentialsOf = (...items: ReturnType<typeof credential>[]): FleetCredentialList =>
  FleetCredentialListSchema.parse({ format: 2, machine: 'studio-mac', credentials: items });

const NO_LOGINS: MachineData = { ...DATA, credentials: credentialsOf() };
const NO_PROFILES: MachineData = {
  ...DATA,
  profiles: FleetLayeredProfileCatalogSchema.parse({ ...PROFILES, profiles: [] }),
};
const SIGN_IN_NEEDED: MachineData = {
  ...DATA,
  credentials: credentialsOf(
    credential({ id: 'claude-work', label: 'work', ...withStatus('needs_sign_in'), usedBy: ['claude-work'] }),
    CREDENTIALS.credentials[0] as ReturnType<typeof credential>,
  ),
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 4; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
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
  readonly machine?: FleetMachineView | null;
  readonly online?: boolean;
  readonly finishes?: (string | null)[];
  readonly reloads?: string[];
}

const mountHost = async (options: HostOptions = {}) => {
  const client: FleetClient = scripted(options.routes ?? READS(), options.calls);
  const createClient = async (): Promise<FleetClient> => client;
  const initial = options.data ?? DATA;

  function Host() {
    const [data, setData] = useState<MachineData>(initial);
    const changes = useAccountChanges({ connection: STUDIO, createClient });
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
        connection={STUDIO}
        createClient={createClient}
        onFinish={open => options.finishes?.push(open)}
        pollMs={5}
      />
    );
  }

  const view = await mount(<Host />);
  await settle();
  return view;
};

const NOT_INSTALLED_CODEX = machine({
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: false },
  ],
});

const withRuntime = (base: MachineData, ...made: ReturnType<typeof runtime>[]): MachineData => ({
  ...base,
  runtimes: FleetRuntimeCatalogSchema.parse({ ...RUNTIMES, runtimes: [...RUNTIMES.runtimes, ...made] }),
});

const STAGED_ROUTES = (data: MachineData = DATA) => ({
  ...READS(data),
  [PROPOSE]: (call: Call) => stagedFrom(call),
  [APPLY]: APPLIED,
});

const proposed = (calls: readonly Call[]): unknown[] =>
  calls.filter(call => call.path === '/v1/fleet/proposals').map(call => call.body);

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
    await view.unmount();
  });

  it('waits while the machine is offline, even with everything chosen', async () => {
    const view = await mountHost({ online: false });
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(nameInput(view.container).value).toBe('claude-claude-hooks');
    expect(submit(view.container).disabled).toBe(true);
    await view.unmount();
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
    await view.unmount();
  });

  it('says on the login when its tool is not installed here', async () => {
    const view = await mountHost({ machine: NOT_INSTALLED_CODEX });
    expect(text(view.container, '[data-add-runtime-credential="codex"]')).toContain('Codex isn’t installed here');
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).not.toContain('installed here');
    await view.unmount();
  });

  it('E12: with no logins it says so and offers to add one', async () => {
    const view = await mountHost({ data: NO_LOGINS });
    expect(text(view.container, '[data-add-runtime-no-logins]')).toBe(
      'There are no logins on studio-mac yet. Add one below: sign in to Claude Code or Codex, or use a provider key.',
    );
    expect(view.container.querySelector('[data-add-runtime-credential]')).toBeNull();
    expect(text(view.container, '[data-add-row="login"]')).toBe('Add a new login');
    await view.unmount();
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
    await view.unmount();
  });

  it('E13: a login that needs sign-in can be signed in right there', async () => {
    const reloads: string[] = [];
    const view = await mountHost({
      data: SIGN_IN_NEEDED,
      reloads,
      routes: {
        ...READS(SIGN_IN_NEEDED),
        [LOGIN]: claudeFlow('awaiting-code', 'claude-work'),
        'GET /v1/fleet/login/flow-1': claudeFlow('complete', 'claude-work'),
      },
    });
    expect(view.container.querySelector('[data-credential-sign-in]')).toBeNull();
    await click(view.container, '[data-add-runtime-credential="claude-work"] input');
    expect(text(view.container, '[data-credential-sign-in="start"]')).toContain('Sign in to Claude Code');
    await click(view.container, '[data-credential-sign-in="start"] [data-change-submit]');
    await waitFor(view.container, '[data-credential-sign-in="complete"]');
    expect(reloads).toEqual(['reload']);
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    expect(view.container.querySelector('[data-credential-sign-in]')).toBeNull();
    await view.unmount();
  });
});

describe('Add runtime: Add a new login', () => {
  const NEW_CLAUDE = credential({ id: 'claude', email: undefined, ...withStatus('needs_sign_in') });
  const withNew = (...extra: ReturnType<typeof credential>[]): MachineData => ({
    ...DATA,
    credentials: credentialsOf(...CREDENTIALS.credentials, ...extra),
  });
  const newLoginRoutes = (after: MachineData, extra: Record<string, unknown> = {}) => ({
    ...STAGED_ROUTES(after),
    'GET /v1/fleet/presets': PROVIDERS,
    'GET /v1/secrets': { v: 1, health: 'ready', secrets: [], references: [] },
    'POST /v1/secrets': (call: Call) => ({
      name: (call.body as { name: string }).name,
      createdAt: '2026-10-16T08:00:00.000Z',
      updatedAt: '2026-10-16T08:00:00.000Z',
    }),
    ...extra,
  });

  it('opens in place under the list, offers a sign-in per tool, and Cancel closes it', async () => {
    const view = await mountHost({ machine: NOT_INSTALLED_CODEX });
    expect(view.container.querySelector('[data-add-runtime-new-login]')).toBeNull();
    await click(view.container, '[data-add-row="login"]');
    expect(view.container.querySelector('[data-add-row="login"]')).toBeNull();
    expect(text(view.container, '[data-add-runtime-new-login="signin"]')).toContain('Add a new login');
    const claude = must(
      view.container.querySelector<HTMLButtonElement>('[data-add-runtime-login="claude"]'),
      'claude button',
    );
    expect(claude.textContent).toBe('Sign in to Claude Code');
    expect(claude.disabled).toBe(false);
    const codex = must(
      view.container.querySelector<HTMLButtonElement>('[data-add-runtime-login="codex"]'),
      'codex button',
    );
    expect(codex.textContent).toBe('Codex isn’t installed here');
    expect(codex.disabled).toBe(true);
    await click(view.container, '[data-add-runtime-new-login-close]');
    expect(view.container.querySelector('[data-add-runtime-new-login]')).toBeNull();
    expect(view.container.querySelector('[data-add-row="login"]')).not.toBeNull();
    await view.unmount();
  });

  it('Sign in to Claude Code makes the login, starts its sign-in, and "Use it, sign in later" picks it', async () => {
    const calls: Call[] = [];
    const reloads: string[] = [];
    const after = withNew(NEW_CLAUDE);
    const view = await mountHost({
      calls,
      reloads,
      after,
      // The sign-in re-reads its flow every `pollMs`, so the machine answers that read too: still waiting
      // for the code. Unscripted, a slow runner's first poll lands before the assertions below and the
      // "didn't answer" refusal is the alert this test says is not there.
      routes: newLoginRoutes(after, {
        [LOGIN]: claudeFlow('awaiting-code', 'claude'),
        'GET /v1/fleet/login/flow-1': claudeFlow('awaiting-code', 'claude'),
      }),
    });
    await click(view.container, '[data-add-row="login"]');
    await click(view.container, '[data-add-runtime-login="claude"]');
    await waitFor(view.container, '[data-credential-sign-in="awaiting-code"]');
    expect(proposed(calls)).toEqual([{ change: { kind: 'credential.add', id: 'claude', harness: 'claude' } }]);
    expect(reloads).toEqual(['reload']);
    expect(calls.find(call => call.path === '/v1/fleet/login')?.body).toEqual({ credentialId: 'claude' });
    expect(view.container.querySelector('[role="alert"]')).toBeNull();

    await click(view.container, '[data-add-runtime-sign-in-later]');
    expect(view.container.querySelector('[data-add-runtime-new-login]')).toBeNull();
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-credential="claude"] input'), 'new')
        .checked,
    ).toBe(true);
    expect(view.container.querySelector('[data-add-runtime-part="profile"]')).not.toBeNull();
    // It still needs sign-in, so the Login part offers the sign-in under the list.
    expect(view.container.querySelector('[data-credential-sign-in="start"]')).not.toBeNull();
    await view.unmount();
  });

  it('a sign-in finished here picks the new login and re-reads', async () => {
    const reloads: string[] = [];
    const after = withNew(NEW_CLAUDE);
    const view = await mountHost({
      reloads,
      after,
      routes: newLoginRoutes(after, {
        [LOGIN]: claudeFlow('awaiting-code', 'claude'),
        'GET /v1/fleet/login/flow-1': claudeFlow('complete', 'claude'),
      }),
    });
    await click(view.container, '[data-add-row="login"]');
    await click(view.container, '[data-add-runtime-login="claude"]');
    await waitFor(view.container, '[data-add-row="login"]');
    expect(reloads.length).toBeGreaterThanOrEqual(2);
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-credential="claude"] input'), 'new')
        .checked,
    ).toBe(true);
    await view.unmount();
  });

  it('a sign-in that cannot start still leaves the login made, says why, and lets it be used', async () => {
    const after = withNew(NEW_CLAUDE);
    const view = await mountHost({
      after,
      routes: newLoginRoutes(after, {
        [LOGIN]: new FyHttpError('Another sign-in is open on this machine.', 409, 'fleet_change_conflict'),
      }),
    });
    await click(view.container, '[data-add-row="login"]');
    await click(view.container, '[data-add-runtime-login="claude"]');
    await waitFor(view.container, '[data-add-runtime-new-login] [role="alert"]');
    expect(text(view.container, '[data-add-runtime-new-login] [role="alert"]')).toContain(
      'Another sign-in is open on this machine.',
    );
    expect(
      view.container.querySelector('[data-add-runtime-new-login] [data-credential-sign-in="start"]'),
    ).not.toBeNull();
    await click(view.container, '[data-add-runtime-sign-in-later]');
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-credential="claude"] input'), 'new')
        .checked,
    ).toBe(true);
    await view.unmount();
  });

  it('a login that cannot be made says why right there, and the form below says nothing of it', async () => {
    const view = await mountHost({
      routes: newLoginRoutes(DATA, {
        [PROPOSE]: new FyHttpError(
          'This change conflicts with the setup on this machine.',
          409,
          'fleet_change_conflict',
        ),
      }),
    });
    await click(view.container, '[data-add-row="login"]');
    await click(view.container, '[data-add-runtime-login="claude"]');
    await waitFor(view.container, '[data-add-runtime-new-login] [role="alert"]');
    expect(text(view.container, '[data-add-runtime-new-login] [role="alert"]')).toBe(
      'This change conflicts with the setup on this machine.',
    );
    expect(view.container.querySelector('[data-add-runtime-credential="claude"]')).toBeNull();
    expect(view.container.querySelector('[data-change-refusal]')).toBeNull();
    await view.unmount();
  });

  it('Provider key shows the provider grid; Sign in goes back; a key added there comes back picked', async () => {
    const calls: Call[] = [];
    const deepseek = credential({
      id: 'deepseek',
      store: 'environment',
      email: undefined,
      harnesses: ['claude', 'codex'],
      usedBy: [],
    });
    const after = withNew(deepseek);
    const view = await mountHost({
      calls,
      after,
      routes: newLoginRoutes(after, { 'GET /v1/fleet/presets': { presets: [...PROVIDERS.presets, DEEPSEEK] } }),
    });
    await click(view.container, '[data-add-row="login"]');
    await click(view.container, '[data-add-login-kind-option="environment"] input');
    expect(text(view.container, '[data-add-runtime-new-login]')).toContain('Add a new login');
    expect(view.container.querySelector('[data-add-runtime-new-login="environment"]')).not.toBeNull();
    await waitFor(view.container, '[data-provider-grid]');
    await click(view.container, '[data-add-login-kind-option="signin"] input');
    expect(view.container.querySelector('[data-add-runtime-login="claude"]')).not.toBeNull();
    await click(view.container, '[data-add-login-kind-option="environment"] input');
    await waitFor(view.container, '[data-provider-tile="deepseek"]');
    await click(view.container, '[data-provider-tile="deepseek"]');
    await type(
      must(view.container.querySelector<HTMLInputElement>('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'key'),
      'a-pasted-deepseek-key',
    );
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-env-login="added"]');
    await click(view.container, '[data-env-login="added"] [data-step-next]');
    expect(view.container.querySelector('[data-add-runtime-new-login]')).toBeNull();
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-credential="deepseek"] input'), 'new')
        .checked,
    ).toBe(true);
    expect(view.container.querySelector('[data-add-runtime-runs]')).not.toBeNull();
    await view.unmount();
  });
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
    await view.unmount();
  });

  it('links to Profiles for building or changing one', async () => {
    const view = await mountHost();
    await pick(view.container, 'claude-personal');
    const link = must(view.container.querySelector('[data-add-runtime-profiles-link]'), 'link');
    expect(link.getAttribute('href')).toBe('#machines/studio-mac/profiles');
    expect(link.textContent).toBe('Build or change profiles in Profiles');
    expect(view.container.querySelector('[data-add-row="profile"]')).toBeNull();
    await view.unmount();
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
    await view.unmount();
  });

  it("P7: offers Generic and this login's own profiles first; the other tool's and a mixed one wait below, disabled, saying why", async () => {
    const scoped: MachineData = {
      ...DATA,
      profiles: FleetLayeredProfileCatalogSchema.parse({
        ...PROFILES,
        profiles: [
          profile({ name: 'Codex work', scope: { kind: 'scoped', scope: 'codex' } }),
          profile({ name: 'Old mix', scope: { kind: 'mixed', sentence: "Profile Old mix can't be both." } }),
          profile({ name: 'Claude work', scope: { kind: 'scoped', scope: 'claude' } }),
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
    await view.unmount();
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
    await view.unmount();
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
    await view.unmount();
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
    await view.unmount();
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
    await view.unmount();
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
    await view.unmount();
  });

  it('an empty name asks for one and offers nothing; spaces typed around a name are trimmed', async () => {
    const view = await ready();
    await type(nameInput(view.container), '');
    expect(text(view.container, '[data-runtime-name-problem]')).toContain('Give the runtime a name.');
    expect(view.container.querySelector('[data-runtime-name-suggestion]')).toBeNull();
    expect(submit(view.container).disabled).toBe(true);
    await type(nameInput(view.container), '  spaced  ');
    expect(nameInput(view.container).value).toBe('spaced');
    await view.unmount();
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
    await view.unmount();
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
    await view.unmount();
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
    await view.unmount();
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
            ? new FyHttpError('This change conflicts with the setup on this machine.', 409, 'fleet_change_conflict')
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
    await view.unmount();
  });
});

describe('Add runtime: a login that drives both CLIs', () => {
  const DUAL = credential({
    id: 'deepseek',
    store: 'environment',
    email: undefined,
    harnesses: ['claude', 'codex'],
    usedBy: [],
  });
  const DUAL_DATA: MachineData = {
    ...DATA,
    credentials: credentialsOf(CREDENTIALS.credentials[0] as ReturnType<typeof credential>, DUAL),
    profiles: FleetLayeredProfileCatalogSchema.parse({
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
    await view.unmount();
  });

  it('Runs follows a scoped profile until chosen; choosing a CLI drops a profile that no longer fits', async () => {
    const view = await mountHost({ data: DUAL_DATA });
    await click(view.container, '[data-add-runtime-credential="deepseek"] input');
    expect(runsAt(view.container)).toBe('claude');
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
    await click(view.container, '[data-add-runtime-runs-option="claude"] input');
    expect(view.container.querySelector('#add-runtime-name')).toBeNull();
    expect(codexWork().disabled).toBe(true);
    expect(text(view.container, '[data-add-runtime-runs]')).not.toContain('until you choose');
    await click(view.container, '[data-add-runtime-profile="Default"] input');
    await click(view.container, '[data-add-runtime-runs-option="codex"] input');
    expect(nameInput(view.container).value).toBe('codex-default-2');
    await view.unmount();
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
    await view.unmount();
  });

  it('offers no Runs choice for a login that drives one CLI', async () => {
    const view = await mountHost();
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    expect(view.container.querySelector('[data-add-runtime-runs]')).toBeNull();
    await view.unmount();
  });
});
