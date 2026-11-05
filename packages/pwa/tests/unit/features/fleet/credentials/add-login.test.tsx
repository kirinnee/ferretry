import { describe, expect, it } from 'bun:test';
import type { FleetCredentialList, FleetCredentialView, FleetMachineView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { AddLogin } from '../../../../../src/features/fleet/credentials/add-login.tsx';
import { secretRef } from '../../../../../src/features/fleet/credentials/environment-model.ts';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { useMachineData } from '../../../../../src/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../src/features/fleet/shell/apply-change-panel.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import { localModelsFixture } from '../../../../support/local-models.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  claudeFlow,
  credential,
  DATA,
  machine,
  READS,
  RUNTIMES,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';
import { OLLAMA, PROVIDERS } from './environment-support.ts';

const CHANGES = 'POST /v1/fleet/proposals';
const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;
const LOGIN = 'POST /v1/fleet/login';
const FLOW = '/v1/fleet/login/flow-1';
const STORE = 'POST /v1/secrets';

/**
 * Waits until the screen shows what the test expects, one act per slice, for at most two seconds.
 *
 * A click's act ends before the daemon answers it on a loaded runner — the scripted client reads each
 * answer's body, which can resolve on a later macrotask — so the screen the click leads to is a thing to
 * wait for, not a thing to assert the moment the act ends.
 */
const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const type = async (field: Element | null, value: string): Promise<void> => {
  const input = must(field as HTMLInputElement | HTMLTextAreaElement | null, 'a field');
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

const text = (container: HTMLElement, selector: string): string | undefined =>
  container.querySelector(selector)?.textContent ?? undefined;

const submit = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('[data-add-login-fields] [data-change-submit]'), 'the button');

const only = (calls: readonly Call[], key: string): Call[] =>
  calls.filter(call => `${call.method} ${call.path}` === key);

const changeBodies = (calls: readonly Call[]): unknown[] =>
  only(calls, CHANGES).map(call => (call.body as { change: unknown }).change);

const listOf = (credentials: readonly FleetCredentialView[]): FleetCredentialList => ({
  ...CREDENTIALS,
  credentials: [...credentials],
});

/** The runtimes with nothing on Claude Code, so a new Claude Code login gets one. */
const CODEX_ONLY = { ...RUNTIMES, runtimes: RUNTIMES.runtimes.filter(runtime => runtime.harness === 'codex') };

interface HostProps {
  readonly createClient: () => Promise<FleetClient>;
  readonly tool: FleetMachineView | null;
  readonly online: boolean;
  readonly checking: boolean;
  readonly events: string[];
  readonly pollMs?: number;
}

function Host({ createClient, tool, online, checking, events, pollMs }: HostProps) {
  const { data, reload } = useMachineData(STUDIO, createClient);
  const changes = useAccountChanges({ connection: STUDIO, createClient });
  return (
    <AddLogin
      machine={tool}
      machineName="studio-mac"
      online={online}
      checking={checking}
      onRetry={() => events.push('retry')}
      connection={STUDIO}
      createClient={createClient}
      data={data}
      reload={reload}
      changes={changes}
      onAdded={id => events.push(`added ${id}`)}
      onLeave={() => events.push('left')}
      {...(pollMs === undefined ? {} : { pollMs })}
    />
  );
}

interface World {
  readonly existing?: readonly FleetCredentialView[];
  /** The login a `credential.add` of a sign-in makes. */
  readonly fresh?: FleetCredentialView;
  readonly runtimes?: typeof RUNTIMES;
  readonly profiles?: typeof DATA.profiles;
  readonly routes?: Record<string, unknown>;
  /** A change this answers with a refusal instead of staging. */
  readonly refuse?: (change: { kind: string; id?: string; name?: string }) => Error | undefined;
  /** A `runtime.put` waits for this before it is answered. */
  readonly hold?: Promise<void>;
  /** A sign-in restart waits this many milliseconds before it is answered. */
  readonly restartDelayMs?: number;
}

interface Opened {
  readonly tool?: FleetMachineView | null;
  readonly online?: boolean;
  readonly checking?: boolean;
  readonly pollMs?: number;
}

const open = async (world: World = {}, props: Opened = {}) => {
  const calls: Call[] = [];
  const events: string[] = [];
  const made: FleetCredentialView[] = [];
  const existing = world.existing ?? CREDENTIALS.credentials;
  const base = scripted(
    {
      ...READS({
        ...DATA,
        runtimes: world.runtimes ?? CODEX_ONLY,
        ...(world.profiles === undefined ? {} : { profiles: world.profiles }),
      }),
      'GET /v1/fleet/credentials': () => listOf([...existing, ...made]),
      'GET /v1/fleet/presets': PROVIDERS,
      'GET /v1/secrets': { v: 1, health: 'ready', secrets: [], references: [] },
      [STORE]: (call: Call) => ({
        name: (call.body as { name: string }).name,
        createdAt: '2026-10-16T08:00:00.000Z',
        updatedAt: '2026-10-16T08:00:00.000Z',
      }),
      [CHANGES]: (call: Call) => {
        const change = (call.body as { change: { kind: string; id?: string; store?: string } }).change;
        const refusal = world.refuse?.(change);
        if (refusal !== undefined) return refusal;
        if (change.kind === 'credential.add')
          made.push(
            change.store === 'environment'
              ? credential({ id: change.id ?? '', store: 'environment' })
              : (world.fresh ?? credential({ id: change.id ?? '', email: 'new@example.com' })),
          );
        return stagedFrom(call);
      },
      [APPLY]: APPLIED,
      ...world.routes,
    },
    calls,
  );
  const client: FleetClient = {
    request: async (path, schema, init) => {
      const kind =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { change?: { kind?: string } }).change?.kind
          : undefined;
      if (world.hold !== undefined && path === '/v1/fleet/proposals' && kind === 'runtime.put') await world.hold;
      if (world.restartDelayMs !== undefined && path === '/v1/fleet/login' && typeof init?.body === 'string') {
        if ((JSON.parse(init.body) as { restart?: boolean }).restart === true)
          await new Promise(resolve => setTimeout(resolve, world.restartDelayMs));
      }
      return base.request(path, schema, init);
    },
  };
  const view = await mount(
    <Host
      createClient={async () => client}
      tool={props.tool === undefined ? machine() : props.tool}
      online={props.online ?? true}
      checking={props.checking ?? false}
      events={events}
      {...(props.pollMs === undefined ? {} : { pollMs: props.pollMs })}
    />,
  );
  await until(() => view.container.querySelector('[data-env-login="loading"]') === null, 'the providers read');
  return { view, calls, events };
};

/** Types into the Name box. */
const nameIt = async (c: HTMLElement, value: string): Promise<void> => {
  await type(c.querySelector('#add-login-name'), value);
};

/** Through a Claude Code sign-in to "Signed in": the tile, the Name, the button, the code. */
const signInToClaude = async (c: HTMLElement, name = 'side'): Promise<void> => {
  await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
  await nameIt(c, name);
  await click(submit(c), 'the one button');
  await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
  await type(c.querySelector('textarea'), 'code-from-page');
  await click(
    Array.from(c.querySelectorAll('button')).find(button => button.textContent === 'Finish sign-in') ?? null,
    'Finish sign-in',
  );
  await until(() => c.querySelector('[data-add-login-done]') !== null, 'signed in');
};

const CLAUDE_SIGNS_IN = {
  [LOGIN]: claudeFlow('awaiting-code', 'claude'),
  [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete', 'claude') },
};

describe('AddLogin · one screen', () => {
  it('shows every provider as tiles on one screen, with no step counter, and its title focused', async () => {
    const codexMissing = machine({
      tools: [
        { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
        { harness: 'codex', label: 'Codex', installed: false },
      ],
    });
    const { view } = await open({}, { tool: codexMissing });
    const c = view.container;
    expect(document.activeElement?.id).toBe('add-login-title');
    expect(text(c, '#add-login-title')).toBe('Add a login');
    expect(c.querySelector('[data-stepper-position], [data-stepper-steps], [data-stepper-progress]')).toBeNull();
    expect(text(c, '[data-add-login-choices] > p')).toBe('How will studio-mac reach the model?');
    expect(text(c, '[data-add-login-choice="claude"]')).toBe('Claude CodeClaude subscription');
    expect(text(c, '[data-add-login-choice="codex"]')).toBe(
      'CodexNot installed on studio-mac · install it in Settings',
    );
    expect(c.querySelector('[data-add-login-choice="codex"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(c.querySelector('[data-add-login-choice="claude"]')?.hasAttribute('aria-disabled')).toBe(false);
    expect(c.querySelector('[data-provider-tile="deepseek"]')).not.toBeNull();
    expect(c.querySelector('[data-provider-tile="paste"]')).not.toBeNull();
    // Nothing asked for until a tile is tapped, and a tool that is not installed opens nothing.
    expect(c.querySelector('[data-add-login-fields]')).toBeNull();
    await click(c.querySelector('[data-add-login-choice="codex"]'), 'the Codex tile');
    expect(c.querySelector('[data-add-login-fields]')).toBeNull();
    await view.unmount();
  });

  it('a machine that has not answered with its setup has no tool to sign in to', async () => {
    const { view } = await open({}, { tool: null });
    const tiles = Array.from(view.container.querySelectorAll('[data-add-login-choice]'));
    expect(tiles.map(tile => tile.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    await view.unmount();
  });

  it('says so when the providers cannot be read, and still offers the sign-ins', async () => {
    const failed = await open({ routes: { 'GET /v1/fleet/presets': new FyHttpError('No presets here.', 500, 'x') } });
    await until(() => failed.view.container.querySelector('[data-env-login="failed"]') !== null, 'the failure');
    expect(text(failed.view.container, '[data-env-login="failed"]')).toBe('No presets here.');
    expect(failed.view.container.querySelector('[data-add-login-choice="claude"]')).not.toBeNull();
    await failed.view.unmount();

    const none = await open({ routes: { 'GET /v1/fleet/presets': { presets: [] } } });
    expect(none.view.container.querySelector('[data-add-login-choice="claude"]')).not.toBeNull();
    expect(none.view.container.querySelector('[data-provider-grid]')).toBeNull();
    await none.view.unmount();
  });

  it('says it is reading the providers while they load', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise(resolve => {
      answer = resolve;
    });
    const base = scripted({ ...READS(), 'GET /v1/fleet/presets': { presets: [] } });
    // The providers answer only when the test says so; everything else answers at once.
    const client: FleetClient = {
      request: (path, schema, init) =>
        path === '/v1/fleet/presets' ? pending.then(value => schema.parse(value)) : base.request(path, schema, init),
    };
    const events: string[] = [];
    const view = await mount(
      <Host createClient={async () => client} tool={machine()} online checking={false} events={events} />,
    );
    expect(text(view.container, '[data-env-login="loading"]')).toBe('Reading the providers on studio-mac…');
    answer({ presets: [] });
    await view.unmount();
  });
});

describe('AddLogin · a subscription sign-in', () => {
  it('folds to the tile chosen, asks for a Name, and one click makes the login, its runtime and the sign-in', async () => {
    const { view, calls, events } = await open({ routes: CLAUDE_SIGNS_IN });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    expect(c.querySelector('[data-add-login-choices]')).toBeNull();
    expect(text(c, '[data-add-login-chosen="signin"]')).toBe('Claude CodeClaude subscriptionChange');
    expect(text(c, '[data-add-login-name] label')).toBe('Name');
    expect(c.querySelector<HTMLInputElement>('#add-login-name')?.placeholder).toBe('e.g. work, personal');
    expect(text(c, '[data-add-login-name-hint]')).toBe(
      'So you can tell it from your other 2 Claude Code logins. Saved as claude-login.',
    );
    await nameIt(c, 'side');
    expect(text(c, '[data-add-login-name-hint]')).toBe(
      'So you can tell it from your other 2 Claude Code logins. Saved as claude-side.',
    );
    // Ticked by default: a login that nothing runs on does nothing. Named after the login, not the profile.
    const runtime = must(c.querySelector<HTMLInputElement>('[data-add-login-runtime="claude-side"] input'), 'it');
    expect(runtime.checked).toBe(true);
    expect(text(c, '[data-add-login-runtime="claude-side"]')).toBe(
      'Also make the runtime claude-sideRuns Claude Code on this login, with the Default profile.',
    );
    expect(submit(c).textContent).toBe('Sign in and make claude-side');

    await click(submit(c), 'Sign in and make claude-side');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(changeBodies(calls)).toEqual([
      { kind: 'credential.add', id: 'claude-side', harness: 'claude', label: 'side' },
      {
        kind: 'runtime.put',
        name: 'claude-side',
        credential: 'claude-side',
        profile: 'Default',
        agent: false,
        create: true,
      },
    ]);
    expect(only(calls, APPLY)).toHaveLength(2);
    expect(only(calls, LOGIN)).toHaveLength(1);
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'claude-side' });
    expect(c.querySelector('[data-add-login-change]')).toBeNull();
    expect(text(c, '[data-add-login-added]')).toBe('Added side (claude-side)');
    expect(text(c, '[data-add-login-runtime-made="claude-side"]')).toBe('Made the runtime claude-side');
    expect(c.textContent).toContain('https://claude.ai/oauth/authorize?code=true');
    const link = must(c.querySelector<HTMLAnchorElement>('[data-open-sign-in]'), 'Open sign-in page');
    expect(link.href).toBe('https://claude.ai/oauth/authorize?code=true');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');

    await type(c.querySelector('textarea'), 'code-from-page');
    await click(
      Array.from(c.querySelectorAll('button')).find(button => button.textContent === 'Finish sign-in') ?? null,
      'Finish sign-in',
    );
    await until(() => c.querySelector('[data-add-login-done]') !== null, 'signed in');
    expect(only(calls, `POST ${FLOW}`)[0]?.body).toEqual({ code: 'code-from-page' });
    expect(text(c, '[data-add-login-done] > p')).toBe('Signed in to Claude Code as new@example.com');
    expect(events).toEqual([]);
    // Done leaves straight away: nothing is left to lose.
    await click(c.querySelector('[data-add-login-finish]'), 'Done');
    expect(events).toEqual(['added claude-side']);
    await click(c.querySelector('[data-add-login-back]'), 'Logins');
    expect(events).toEqual(['added claude-side', 'left']);
    await view.unmount();
  });

  it('shows what happens next for Claude Code and for Codex, and not for an API-key provider', async () => {
    const { view } = await open({ existing: [] });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    expect(text(c, '[data-add-login-next] h4')).toBe('What happens next');
    const steps = (): string[] =>
      Array.from(c.querySelectorAll('[data-add-login-next] li')).map(item => item.textContent ?? '');
    expect(steps()).toEqual([
      '1studio-mac starts Claude Code’s sign-in and shows you a link here.',
      '2Open the link and sign in with the Claude account you want here.Already signed in to Claude in this browser as someone else? Open the link in a private window, or sign out of claude.ai first.',
      '3Claude shows a code. Paste it back here.',
    ]);
    await nameIt(c, 'side');
    expect(steps()[1]).toContain('Open the link and sign in with the Claude account you want for "side".');
    expect(text(c, '[data-add-login-next] > p')).toBe(
      'Your password stays on Claude Code’s page. The login is kept on studio-mac.',
    );

    await click(c.querySelector('[data-add-login-change]'), 'Change');
    await click(c.querySelector('[data-add-login-choice="codex"]'), 'the Codex tile');
    await nameIt(c, 'side');
    expect(steps()[1]).toContain('sign in with the ChatGPT account you want for "side".');
    expect(steps()[1]).toContain('sign out of chatgpt.com first.');
    expect(steps()[2]).toBe('3Enter the code this page shows on the Codex page. This page finishes by itself.');

    await click(c.querySelector('[data-add-login-change]'), 'Change');
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    expect(c.querySelector('[data-add-login-next]')).toBeNull();
    expect(c.querySelector('#add-login-name')).toBeNull();
    await view.unmount();
  });

  it('asks for a Name only when the machine already has a login of that tool', async () => {
    const first = await open({ existing: [], routes: CLAUDE_SIGNS_IN });
    const f = first.view.container;
    await click(f.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    expect(text(f, '[data-add-login-name-hint]')).toBe('Optional. Saved as claude-login.');
    await nameIt(f, 'home');
    expect(text(f, '[data-add-login-name-hint]')).toBe('Saved as claude-home.');
    await nameIt(f, '');
    await click(submit(f), 'Sign in');
    await until(() => f.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(changeBodies(first.calls)[0]).toEqual({ kind: 'credential.add', id: 'claude-login', harness: 'claude' });
    await first.view.unmount();

    const second = await open({ routes: CLAUDE_SIGNS_IN });
    const c = second.view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    // Said when Sign in is pressed, and nothing is sent.
    expect(c.querySelector('[data-add-login-name-error]')).toBeNull();
    await click(submit(c), 'Sign in');
    expect(text(c, '[data-add-login-name-error]')).toBe('Give it a name so you can tell the two apart.');
    expect(changeBodies(second.calls)).toEqual([]);
    await nameIt(c, '---');
    expect(text(c, '[data-add-login-name-error]')).toBe('Use at least one letter or digit.');
    expect(submit(c).disabled).toBe(true);
    await nameIt(c, 'x'.repeat(41));
    expect(text(c, '[data-add-login-name-error]')).toBe('Keep it to 40 characters.');
    await nameIt(c, 'Personal');
    expect(text(c, '[data-add-login-name-error]')).toBe(
      'You already have a Claude Code login named Personal. Pick another name.',
    );
    expect(submit(c).disabled).toBe(true);
    await nameIt(c, 'side');
    expect(c.querySelector('[data-add-login-name-error]')).toBeNull();
    expect(submit(c).disabled).toBe(false);
    // A Codex login named work does not block a Claude Code one.
    await second.view.unmount();
  });

  it('names the one other login of the tool in the hint, with its email and label', async () => {
    const { view } = await open({ existing: [credential({ id: 'claude-personal', label: 'personal' })] });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await nameIt(c, 'Side Gig');
    expect(text(c, '[data-add-login-name-hint]')).toBe(
      'So you can tell it from your other Claude Code login, you@example.com (personal). Saved as claude-side-gig.',
    );
    await view.unmount();
  });

  it('never shows claude-claude- or "already has a runtime", with a claude-default runtime and profile on the machine', async () => {
    const runtimes = { ...RUNTIMES, runtimes: RUNTIMES.runtimes.map(item => ({ ...item, profile: 'claude-default' })) };
    const profiles = {
      ...DATA.profiles,
      profiles: DATA.profiles.profiles.map(item => ({ ...item, name: 'claude-default' })),
    };
    const { view } = await open({ runtimes, profiles });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    expect(c.textContent).not.toContain('claude-claude');
    await nameIt(c, 'side');
    expect(c.textContent).not.toContain('claude-claude');
    expect(c.textContent).not.toContain('already has a runtime');
    const box = must(c.querySelector<HTMLInputElement>('[data-add-login-runtime] input'), 'the box');
    expect(box.checked).toBe(true);
    expect(c.querySelector('[data-add-login-runtime]')?.getAttribute('data-add-login-runtime')).toBe('claude-side');
    expect(text(c, '[data-add-login-runtime]')).toContain('with the claude-default profile.');
    await view.unmount();
  });

  it('can turn the runtime off, and Change starts the choice over', async () => {
    const { view, calls } = await open({ runtimes: RUNTIMES, routes: CLAUDE_SIGNS_IN });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await nameIt(c, 'side');
    const runtime = must(c.querySelector<HTMLInputElement>('[data-add-login-runtime] input'), 'the runtime choice');
    expect(runtime.checked).toBe(true);
    expect(c.querySelector('[data-add-login-runtime]')?.getAttribute('data-add-login-runtime')).toBe('claude-side');
    await click(runtime, 'the runtime choice');
    expect(submit(c).textContent).toBe('Sign in to Claude Code');
    await click(runtime, 'the runtime choice');
    expect(submit(c).textContent).toBe('Sign in and make claude-side');
    await click(runtime, 'the runtime choice');
    await click(submit(c), 'Sign in to Claude Code');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(changeBodies(calls)).toEqual([
      { kind: 'credential.add', id: 'claude-side', harness: 'claude', label: 'side' },
    ]);
    expect(c.querySelector('[data-add-login-runtime-made]')).toBeNull();
    await view.unmount();
  });

  it('says when no profile can make a runtime, and only signs in', async () => {
    const { view, calls } = await open({
      runtimes: { ...RUNTIMES, runtimes: [] },
      profiles: { ...DATA.profiles, profiles: [] },
      routes: CLAUDE_SIGNS_IN,
    });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await nameIt(c, 'side');
    expect(text(c, '[data-add-login-runtime="none"]')).toBe(
      'No profile runs Claude Code yet, so no runtime is made. Add one later in Runtimes.',
    );
    expect(submit(c).textContent).toBe('Sign in to Claude Code');
    await click(submit(c), 'Sign in to Claude Code');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(changeBodies(calls)).toHaveLength(1);
    await view.unmount();
  });

  it('says a login that could not be made, and makes nothing', async () => {
    const { view, calls } = await open({
      refuse: () =>
        new FyHttpError(
          'Account setup changes are switched off on this machine for now.',
          409,
          'fleet_change_disabled',
        ),
    });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await nameIt(c, 'side');
    await click(submit(c), 'the one button');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(text(c, '[data-change-refusal]')).toBe('Account setup changes are switched off on this machine for now.');
    expect(only(calls, APPLY)).toHaveLength(0);
    expect(only(calls, LOGIN)).toHaveLength(0);
    expect(submit(c).textContent).toBe('Sign in and make claude-side');
    // Nothing was made, so the choice can still change.
    expect(c.querySelector('[data-add-login-change]')).not.toBeNull();
    await view.unmount();
  });

  it('keeps the login when its runtime is refused, says so, and still signs it in', async () => {
    const { view, calls } = await open({
      routes: CLAUDE_SIGNS_IN,
      refuse: change =>
        change.kind === 'runtime.put'
          ? new FyHttpError('claude-default is taken.', 409, 'fleet_change_refused')
          : undefined,
    });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await nameIt(c, 'side');
    await click(submit(c), 'the one button');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(text(c, '[data-add-login-runtime-refused]')).toBe(
      'The login is added, but its runtime was not: claude-default is taken. Add it later in Runtimes.',
    );
    // The runtime's refusal is said beside the login, never left on the sign-in's own button.
    expect(c.querySelector('[data-change-refusal]')).toBeNull();
    expect(only(calls, LOGIN)).toHaveLength(1);
    await view.unmount();
  });

  it('a sign-in that will not start leaves the login made and starts from its own panel', async () => {
    let answer: unknown = new FyHttpError(
      'Claude Code is not installed on studio-mac.',
      409,
      'fleet_login_unavailable',
    );
    const { view, calls } = await open({ runtimes: RUNTIMES, routes: { [LOGIN]: () => answer } });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await nameIt(c, 'side');
    await click(submit(c), 'Sign in and make claude-side');
    await until(() => c.querySelector('[data-add-login-start-refused]') !== null, 'the refusal');
    expect(text(c, '[data-add-login-start-refused]')).toBe('Claude Code is not installed on studio-mac.');
    expect(c.querySelector('[data-credential-sign-in="start"]')).not.toBeNull();

    answer = claudeFlow('awaiting-code', 'claude');
    await click(c.querySelector('[data-credential-sign-in="start"] [data-change-submit]'), 'its own start');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(only(calls, LOGIN)).toHaveLength(2);
    expect(changeBodies(calls)).toHaveLength(2);
    await view.unmount();
  });

  it('signs in to Codex with its device code, polling until it is approved', async () => {
    const fresh = { ...credential({ id: 'codex-side', harness: 'codex' }) };
    delete fresh.email;
    let approved = false;
    const awaiting = {
      harness: 'codex',
      flowId: 'flow-1',
      credentialId: 'codex-side',
      identity: 'codex:new',
      startedAt: '2026-10-13T08:00:00.000Z',
      expiresAt: '2026-10-13T08:10:00.000Z',
      state: 'awaiting-approval',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: '0IER-FFQW6',
    };
    const { view, calls, events } = await open(
      {
        fresh,
        runtimes: RUNTIMES,
        routes: {
          [LOGIN]: awaiting,
          [`GET ${FLOW}`]: () => {
            if (!approved) return awaiting;
            const { verificationUrl: _url, userCode: _code, ...rest } = awaiting;
            return { ...rest, state: 'complete' };
          },
        },
      },
      { pollMs: 5 },
    );
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="codex"]'), 'the Codex tile');
    expect(text(c, '[data-add-login-chosen]')).toContain('ChatGPT subscription');
    await nameIt(c, 'side');
    await click(submit(c), 'Sign in and make codex-side');
    await until(() => c.querySelector('[data-codex-login="awaiting-approval"]') !== null, 'the device code');
    expect(changeBodies(calls)[0]).toEqual({
      kind: 'credential.add',
      id: 'codex-side',
      harness: 'codex',
      label: 'side',
    });
    expect(c.querySelector('[data-open-sign-in]')?.getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    approved = true;
    await until(() => c.querySelector('[data-add-login-done]') !== null, 'signed in');
    expect(text(c, '[data-add-login-done] > p')).toBe('Signed in to Codex as Codex login');
    await click(c.querySelector('[data-add-login-finish]'), 'Done');
    expect(events).toEqual(['added codex-side']);
    await view.unmount();
  });
});

describe('AddLogin · the same account twice (E26)', () => {
  const SAME = { fresh: credential({ id: 'claude-side', label: 'side' }), runtimes: RUNTIMES, routes: CLAUDE_SIGNS_IN };

  it('asks whether the browser signed in as the wrong account, instead of going straight to labels', async () => {
    const { view } = await open(SAME);
    const c = view.container;
    await signInToClaude(c);
    expect(text(c, '[data-add-login-done] > p')).toBe('Signed in to Claude Code as you@example.com');
    expect(text(c, '[data-add-login-same-account] p')).toBe(
      'This is the same Claude account as your login personal (you@example.com). Did your browser sign in as the wrong account?',
    );
    expect(text(c, '[data-add-login-different-account]')).toBe('Sign in with a different account');
    expect(text(c, '[data-add-login-keep-both]')).toBe('Keep both');
    expect(c.querySelector('[data-add-login-finish]')).toBeNull();
    await view.unmount();
  });

  it('Sign in with a different account signs the login out and starts its sign-in again, with the tip in bold', async () => {
    const { view, calls } = await open(SAME);
    const c = view.container;
    await signInToClaude(c);
    await click(c.querySelector('[data-add-login-different-account]'), 'Sign in with a different account');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the new Claude link');
    expect(changeBodies(calls).slice(2)).toEqual([{ kind: 'credential.signout', id: 'claude-side' }]);
    expect(only(calls, LOGIN)).toHaveLength(2);
    expect(only(calls, LOGIN)[1]?.body).toMatchObject({ credentialId: 'claude-side', restart: true });
    const tip = must(c.querySelector('[data-add-login-other-account-tip]'), 'the tip');
    expect(tip.textContent).toContain('Open the link in a private window');
    expect(tip.className).toContain('font-semibold');
    expect(c.querySelector('[data-add-login-same-account]')).toBeNull();
    await view.unmount();
  });

  it('shows the new link and finishes the NEW flow when the restart answers late', async () => {
    const second = {
      ...claudeFlow('awaiting-code', 'claude'),
      flowId: 'flow-2',
      verificationUrl: 'https://claude.ai/oauth/authorize?code=true&second=1',
    };
    const { view, calls } = await open({
      ...SAME,
      restartDelayMs: 150,
      routes: {
        [LOGIN]: (call: Call) =>
          (call.body as { restart?: boolean }).restart === true ? second : claudeFlow('awaiting-code', 'claude'),
        [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete', 'claude') },
        'POST /v1/fleet/login/flow-2': {
          outcome: 'accepted',
          flow: { ...second, state: 'complete', verificationUrl: undefined },
        },
      },
    });
    const c = view.container;
    await signInToClaude(c);
    await click(c.querySelector('[data-add-login-different-account]'), 'Sign in with a different account');
    await until(() => c.querySelector('[data-add-login-restarting]') !== null, 'the restart pending');
    // While the restart is in flight the old, completed flow's link is not on screen.
    expect(c.querySelector('[data-open-sign-in]')).toBeNull();
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the new Claude link');
    expect(c.querySelector('[data-open-sign-in]')?.getAttribute('href')).toBe(
      'https://claude.ai/oauth/authorize?code=true&second=1',
    );
    await type(c.querySelector('textarea'), 'code-from-second-page');
    await click(
      Array.from(c.querySelectorAll('button')).find(button => button.textContent === 'Finish sign-in') ?? null,
      'Finish sign-in',
    );
    await until(() => only(calls, 'POST /v1/fleet/login/flow-2').length === 1, 'finish posted to flow-2');
    expect(only(calls, `POST ${FLOW}`)).toHaveLength(1);
    await view.unmount();
  });

  it('Keep both finishes at once when both logins already have different labels', async () => {
    const { view, events } = await open(SAME);
    const c = view.container;
    await signInToClaude(c);
    await click(c.querySelector('[data-add-login-keep-both]'), 'Keep both');
    expect(events).toEqual(['added claude-side']);
    expect(c.querySelector('[data-add-login-label]')).toBeNull();
    await view.unmount();
  });

  it('Keep both asks for both labels when neither login has one, and saves both', async () => {
    let added = false;
    const codexOnly = CREDENTIALS.credentials.filter(item => item.harness === 'codex');
    const { view, calls, events } = await open({
      fresh: credential({ id: 'claude-login' }),
      runtimes: RUNTIMES,
      routes: {
        ...CLAUDE_SIGNS_IN,
        'GET /v1/fleet/credentials': () =>
          listOf(
            added
              ? [...codexOnly, credential({ id: 'claude-personal' }), credential({ id: 'claude-login' })]
              : codexOnly,
          ),
      },
      refuse: change => {
        if (change.kind === 'credential.add') added = true;
        return undefined;
      },
    });
    const c = view.container;
    // A first Claude Code login needs no Name, so none is given.
    await signInToClaude(c, '');
    await click(c.querySelector('[data-add-login-keep-both]'), 'Keep both');
    expect(text(c, '[data-add-login-label] > p')).toBe(
      'You already have a Claude Code login for you@example.com. Label both so you can tell them apart.',
    );
    await type(c.querySelector('#add-login-label-old'), 'personal');
    await type(c.querySelector('#add-login-label-new'), 'work');
    expect(c.querySelector('[data-add-login-label-error]')).toBeNull();
    await click(submit(c), 'Save labels');
    await until(() => events.length > 0, 'added');
    expect(changeBodies(calls).slice(-2)).toEqual([
      { kind: 'credential.label', id: 'claude-personal', label: 'personal' },
      { kind: 'credential.label', id: 'claude-login', label: 'work' },
    ]);
    await view.unmount();
  });

  it('Keep both asks only for the new login’s label when the older one has a label', async () => {
    let added = false;
    const codexOnly = CREDENTIALS.credentials.filter(item => item.harness === 'codex');
    const { view, calls, events } = await open({
      fresh: credential({ id: 'claude-login' }),
      runtimes: RUNTIMES,
      routes: {
        ...CLAUDE_SIGNS_IN,
        'GET /v1/fleet/credentials': () =>
          listOf(
            added
              ? [
                  ...codexOnly,
                  credential({ id: 'claude-personal', label: 'personal' }),
                  credential({ id: 'claude-login' }),
                ]
              : codexOnly,
          ),
      },
      refuse: change => {
        if (change.kind === 'credential.add') added = true;
        return undefined;
      },
    });
    const c = view.container;
    await signInToClaude(c, '');
    await click(c.querySelector('[data-add-login-keep-both]'), 'Keep both');
    expect(c.querySelector('#add-login-label-old')).toBeNull();
    await type(c.querySelector('#add-login-label-new'), 'work');
    await click(submit(c), 'Save labels');
    await until(() => events.length > 0, 'added');
    expect(changeBodies(calls).at(-1)).toEqual({ kind: 'credential.label', id: 'claude-login', label: 'work' });
    await view.unmount();
  });

  it('says why a different-account sign-in will not start, and why the sign-out was refused', async () => {
    let logins = 0;
    const next = (): number => {
      logins += 1;
      return logins;
    };
    const started = await open({
      ...SAME,
      routes: {
        'POST /v1/fleet/login': () =>
          next() === 1
            ? claudeFlow('awaiting-code', 'claude')
            : new FyHttpError('Claude Code is not installed on studio-mac.', 409, 'fleet_login_unavailable'),
        [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete', 'claude') },
      },
    });
    const c = started.view.container;
    await signInToClaude(c);
    await click(c.querySelector('[data-add-login-different-account]'), 'Sign in with a different account');
    await until(() => c.querySelector('[data-add-login-start-refused]') !== null, 'the refusal');
    expect(text(c, '[data-add-login-start-refused]')).toBe('Claude Code is not installed on studio-mac.');
    await started.view.unmount();

    const refused = await open({
      ...SAME,
      refuse: change =>
        change.kind === 'credential.signout'
          ? new FyHttpError('Signing out is switched off on studio-mac.', 409, 'fleet_change_refused')
          : undefined,
    });
    const d = refused.view.container;
    await signInToClaude(d);
    await click(d.querySelector('[data-add-login-different-account]'), 'Sign in with a different account');
    await until(() => d.querySelector('[data-add-login-same-account] [role="alert"]') !== null, 'the refusal');
    expect(text(d, '[data-add-login-same-account] [role="alert"]')).toBe('Signing out is switched off on studio-mac.');
    expect(d.querySelector('[data-add-login-same-account]')).not.toBeNull();
    await refused.view.unmount();
  });

  it('Keep both asks only for the older login’s label when it has none, and a refusal stays with its refusal', async () => {
    let refuse = true;
    const { view, calls, events } = await open({
      ...SAME,
      existing: [credential({ id: 'claude-personal' })],
      refuse: change =>
        change.kind === 'credential.label' && refuse
          ? new FyHttpError(`Could not label ${change.id}.`, 409, 'fleet_change_refused')
          : undefined,
    });
    const c = view.container;
    await signInToClaude(c);
    await click(c.querySelector('[data-add-login-keep-both]'), 'Keep both');
    expect(text(c, '[data-add-login-label] > p')).toBe(
      'You already have a Claude Code login for you@example.com. Label the one that has no label.',
    );
    expect(c.querySelector('#add-login-label-new')).toBeNull();
    const older = must(c.querySelector<HTMLInputElement>('#add-login-label-old'), 'the old label');
    expect(older.value).toBe('');
    expect(text(c, '[data-add-login-label-error]')).toBe('Give each login a label.');
    expect(submit(c).disabled).toBe(true);
    await type(older, 'side');
    expect(text(c, '[data-add-login-label-error]')).toBe('Use two different labels.');
    await type(older, 'personal');
    expect(c.querySelector('[data-add-login-label-error]')).toBeNull();
    expect(c.textContent).toContain('Used by 0 runtimes.');
    await click(submit(c), 'Save labels');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(text(c, '[data-change-refusal]')).toBe('Could not label claude-personal.');
    expect(events).toEqual([]);
    refuse = false;
    await click(submit(c), 'Save labels');
    await until(() => events.length > 0, 'added');
    expect(changeBodies(calls).at(-1)).toEqual({ kind: 'credential.label', id: 'claude-personal', label: 'personal' });
    expect(events).toEqual(['added claude-side']);
    await view.unmount();
  });
});

describe('AddLogin · an API-key provider', () => {
  it('asks only for its key, then one click stores it, adds the login and its runtime, and offers the Test', async () => {
    const { view, calls, events } = await open();
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    expect(text(c, '[data-add-login-chosen="preset"]')).toBe('DeepSeekClaude + CodexChange');
    expect(c.querySelector('[data-add-login-fields="deepseek"] [data-one-click="deepseek"]')).not.toBeNull();
    // The providers stay on this screen, so the form has no way back of its own.
    expect(c.querySelector('[data-one-click-back]')).toBeNull();
    expect(c.querySelectorAll('[data-env-secret-input]')).toHaveLength(1);
    expect(submit(c).textContent).toBe('Add login and runtime');
    expect(submit(c).disabled).toBe(true);
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'a-pasted-deepseek-key');
    await click(submit(c), 'Add login and runtime');
    await until(() => c.querySelector('[data-add-login-runtime-made]') !== null, 'the runtime made');
    const order = calls.map(call => `${call.method} ${call.path}`).filter(key => key === STORE || key === CHANGES);
    expect(order).toEqual([STORE, CHANGES, CHANGES]);
    expect(changeBodies(calls)).toEqual([
      {
        kind: 'credential.add',
        id: 'deepseek',
        harness: 'claude',
        store: 'environment',
        preset: 'deepseek',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: secretRef('DEEPSEEK_API_KEY'),
          DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY'),
        },
      },
      // One login drives both CLIs, so the runtime says which it runs.
      {
        kind: 'runtime.put',
        name: 'claude-deepseek',
        credential: 'deepseek',
        profile: 'Default',
        harness: 'claude',
        agent: false,
        create: true,
      },
    ]);
    expect(c.innerHTML).not.toContain('a-pasted-deepseek-key');
    expect(text(c, '[data-add-login-done] > p[role="status"]')).toBe('Added deepseek');
    expect(c.querySelector('[data-login-test-run]')).not.toBeNull();
    expect(c.querySelector('[data-add-login-change]')).toBeNull();
    await click(c.querySelector('[data-add-login-finish]'), 'Done');
    expect(events).toEqual(['added deepseek']);
    await view.unmount();
  });

  it('adds only the login when the runtime is turned off', async () => {
    const { view, calls } = await open();
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await click(c.querySelector('[data-add-login-runtime] input'), 'the runtime choice');
    expect(submit(c).textContent).toBe('Add login');
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'another-key');
    await click(submit(c), 'Add login');
    await until(() => c.querySelector('[data-add-login-done]') !== null, 'added');
    expect(changeBodies(calls)).toHaveLength(1);
    expect(c.querySelector('[data-add-login-runtime-made], [data-add-login-runtime-refused]')).toBeNull();
    await view.unmount();
  });

  it('keeps the form with the refusal when the login is refused, the key already stored', async () => {
    const { view, calls } = await open({
      refuse: () => new FyHttpError('Account setup changes are switched off on studio-mac for now.', 409, 'x'),
    });
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'refused-path-key');
    await click(submit(c), 'Add login and runtime');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(text(c, '[data-change-refusal]')).toBe('Account setup changes are switched off on studio-mac for now.');
    expect(c.querySelector('[data-env-secret-set="DEEPSEEK_API_KEY"]')).not.toBeNull();
    expect(c.querySelector('[data-add-login-done]')).toBeNull();
    expect(only(calls, APPLY)).toHaveLength(0);
    await view.unmount();
  });

  it('a Codex-only provider makes a Codex runtime when no Codex runtime runs here', async () => {
    const { view, calls } = await open({ runtimes: { ...RUNTIMES, runtimes: [] } });
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="azure-openai"]'), 'Azure');
    expect(c.querySelector('[data-add-login-runtime]')?.getAttribute('data-add-login-runtime')).toBe(
      'codex-azure-openai',
    );
    await type(c.querySelector('[data-env-variable="AZURE_OPENAI_RESOURCE"] input'), 'acme');
    await type(c.querySelector('[data-env-secret-input="AZURE_OPENAI_API_KEY"]'), 'azure-key');
    await click(submit(c), 'Add login and runtime');
    await until(() => c.querySelector('[data-add-login-runtime-made]') !== null, 'the runtime made');
    // A login that drives one CLI runs it: the runtime names no harness.
    expect(changeBodies(calls)[1]).toEqual({
      kind: 'runtime.put',
      name: 'codex-azure-openai',
      credential: 'azure-openai',
      profile: 'Default',
      agent: false,
      create: true,
    });
    await view.unmount();
  });

  it('recognises a pasted block and opens its provider filled in; Back from the paste is the tiles', async () => {
    const { view, calls } = await open();
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="paste"]'), 'Paste variables');
    expect(text(c, '[data-add-login-chosen="paste"]')).toBe('Paste variablesChange');
    await click(c.querySelector('[data-paste-back]'), 'All providers');
    expect(c.querySelector('[data-add-login-choices]')).not.toBeNull();
    await click(c.querySelector('[data-provider-tile="paste"]'), 'Paste variables');
    await type(
      c.querySelector('[data-paste-input]'),
      'export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nexport ANTHROPIC_AUTH_TOKEN=sk-pasted-deepseek-secret',
    );
    await click(c.querySelector('[data-paste-read]'), 'Read');
    await click(c.querySelector('[data-paste-continue]'), 'Continue');
    expect(c.querySelector('[data-one-click="deepseek"] [data-one-click-prefilled]')).not.toBeNull();
    expect(c.innerHTML).not.toContain('sk-pasted-deepseek-secret');
    await click(submit(c), 'Add login and runtime');
    await until(() => c.querySelector('[data-add-login-done]') !== null, 'added');
    expect(only(calls, STORE).map(call => call.body)).toEqual([
      { name: 'DEEPSEEK_API_KEY', value: 'sk-pasted-deepseek-secret' },
    ]);
    await view.unmount();
  });
});

describe('AddLogin · leaving and pausing', () => {
  it('leaves at once with nothing chosen, and asks first once a provider is chosen', async () => {
    const { view, events } = await open({ routes: CLAUDE_SIGNS_IN });
    const c = view.container;
    await click(c.querySelector('[data-add-login-back]'), 'Logins');
    expect(events).toEqual(['left']);

    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await click(c.querySelector('[data-add-login-back]'), 'Logins');
    expect(text(c, '[data-add-login-confirm]')).toBe('Stop adding a login?No new login is added.StopKeep going');
    expect(c.querySelector('[data-add-login-back]')).toBeNull();
    await click(c.querySelector('[data-add-login-keep]'), 'Keep going');
    expect(c.querySelector('[data-one-click="deepseek"]')).not.toBeNull();

    await click(c.querySelector('[data-add-login-change]'), 'Change');
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await nameIt(c, 'side');
    await click(submit(c), 'the one button');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    await click(c.querySelector('[data-add-login-back]'), 'Logins');
    expect(text(c, '[data-add-login-confirm] > p:nth-child(2)')).toBe(
      'The login side (claude-side) is kept as Needs sign-in. Sign it in later from its own page, or remove it there.',
    );
    await click(c.querySelector('[data-add-login-stop]'), 'Stop');
    expect(events).toEqual(['left', 'left']);
    await view.unmount();
  });

  it('pauses on a machine that is asleep, renders nothing that could send, and retries', async () => {
    const asleep = await open({}, { online: false });
    const c = asleep.view.container;
    expect(text(c, '[data-add-login-paused]')).toContain('studio-mac is asleep or offline');
    expect(c.querySelector('[data-add-login-choices], [data-change-submit]')).toBeNull();
    await click(c.querySelector('[data-add-login-retry]'), 'Retry');
    expect(asleep.events).toEqual(['retry']);
    await asleep.view.unmount();

    const checking = await open({}, { online: false, checking: true });
    const retry = must(checking.view.container.querySelector<HTMLButtonElement>('[data-add-login-retry]'), 'Retry');
    expect(retry.textContent).toBe('Checking…');
    expect(retry.disabled).toBe(true);
    await checking.view.unmount();
  });
});

describe('AddLogin · progress', () => {
  it('says what it is doing while the runtime is made, and offers Done only once it is', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const { view } = await open({ hold });
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'held-key');
    await click(submit(c), 'Add login and runtime');
    await until(() => c.querySelector('[data-add-login-working]') !== null, 'the progress line');
    expect(text(c, '[data-add-login-working]')).toBe('Making claude-deepseek…');
    expect(must(c.querySelector<HTMLButtonElement>('[data-add-login-finish]'), 'Done').disabled).toBe(true);
    release();
    await until(() => c.querySelector('[data-add-login-runtime-made]') !== null, 'the runtime made');
    expect(c.querySelector('[data-add-login-working]')).toBeNull();
    expect(must(c.querySelector<HTMLButtonElement>('[data-add-login-finish]'), 'Done').disabled).toBe(false);
    await view.unmount();
  });
});

describe('AddLogin · Ollama on this machine', () => {
  const REFRESH = 'POST /v1/models/local/refresh';
  const withOllama = { 'GET /v1/fleet/presets': { presets: [...PROVIDERS.presets, OLLAMA] } };

  it('reads Ollama once, says what it found on the tile, and shows the panel on the Ollama form only', async () => {
    const { view, calls } = await open({ routes: { ...withOllama, [REFRESH]: localModelsFixture('found') } });
    const c = view.container;
    await until(
      () => c.querySelector('[data-provider-tile="ollama-codex"] [data-provider-tile-local]') !== null,
      'the tile line',
    );
    expect(only(calls, REFRESH)).toHaveLength(1);
    await click(c.querySelector('[data-provider-tile="ollama-codex"]'), 'the Ollama tile');
    expect(c.querySelector('[data-local-models-panel]')?.getAttribute('data-local-models-panel')).toBe('found');
    await view.unmount();
  });

  it('shows no panel on another provider’s form', async () => {
    const { view } = await open({ routes: { ...withOllama, [REFRESH]: localModelsFixture('found') } });
    const c = view.container;
    await click(c.querySelector('[data-provider-tile]:not([data-provider-tile="ollama-codex"])'), 'another tile');
    expect(c.querySelector('[data-local-models-panel]')).toBeNull();
    await view.unmount();
  });
});
