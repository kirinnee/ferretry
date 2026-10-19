import { describe, expect, it } from 'bun:test';
import type { FleetCredentialList, FleetCredentialView, FleetMachineView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { AddLogin } from '../../../../../src/features/fleet/credentials/add-login.tsx';
import { secretRef } from '../../../../../src/features/fleet/credentials/environment-model.ts';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { useMachineData } from '../../../../../src/features/fleet/runtimes/machine-data.ts';
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
  READS,
  RUNTIMES,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';
import { PROVIDERS } from './environment-support.ts';

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
  const client = scripted(
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

/** Through a Claude Code sign-in to "Signed in": the tile, the button, the code. */
const signInToClaude = async (c: HTMLElement): Promise<void> => {
  await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
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
  it('folds to the tile chosen, asks only to sign in, and one click makes the login, its runtime and the sign-in', async () => {
    const { view, calls, events } = await open({ routes: CLAUDE_SIGNS_IN });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    expect(c.querySelector('[data-add-login-choices]')).toBeNull();
    expect(text(c, '[data-add-login-chosen="signin"]')).toBe('Claude CodeClaude subscriptionChange');
    expect(text(c, '[data-add-login-fields="claude"] > p')).toBe(
      'You sign in on Claude Code’s own page; the login is kept on studio-mac, and nothing here sees your password.',
    );
    // No runtime runs Claude Code here yet, so the button makes one.
    const runtime = must(c.querySelector<HTMLInputElement>('[data-add-login-runtime="claude-default"] input'), 'it');
    expect(runtime.checked).toBe(true);
    expect(text(c, '[data-add-login-runtime="claude-default"]')).toBe(
      'Also create the runtime claude-defaultClaude Code · Default profile',
    );
    expect(submit(c).textContent).toBe('Sign in and create claude-default');

    await click(submit(c), 'Sign in and create claude-default');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(changeBodies(calls)).toEqual([
      { kind: 'credential.add', id: 'claude', harness: 'claude' },
      {
        kind: 'runtime.put',
        name: 'claude-default',
        credential: 'claude',
        profile: 'Default',
        agent: false,
        create: true,
      },
    ]);
    expect(only(calls, APPLY)).toHaveLength(2);
    expect(only(calls, LOGIN)).toHaveLength(1);
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'claude' });
    expect(c.querySelector('[data-add-login-change]')).toBeNull();
    expect(text(c, '[data-add-login-runtime-made="claude-default"]')).toBe('Created the runtime claude-default');
    expect(c.textContent).toContain('https://claude.ai/oauth/authorize?code=true');

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
    expect(events).toEqual(['added claude']);
    await click(c.querySelector('[data-add-login-back]'), 'Logins');
    expect(events).toEqual(['added claude', 'left']);
    await view.unmount();
  });

  it('makes no runtime when one already runs that CLI, unless asked to', async () => {
    const { view, calls } = await open({ runtimes: RUNTIMES, routes: CLAUDE_SIGNS_IN });
    const c = view.container;
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    const runtime = must(c.querySelector<HTMLInputElement>('[data-add-login-runtime] input'), 'the runtime choice');
    expect(runtime.checked).toBe(false);
    expect(text(c, '[data-add-login-runtime]')).toContain('Claude Code already has a runtime here');
    expect(c.querySelector('[data-add-login-runtime]')?.getAttribute('data-add-login-runtime')).toBe(
      'claude-default-2',
    );
    expect(submit(c).textContent).toBe('Sign in to Claude Code');
    await click(runtime, 'the runtime choice');
    expect(submit(c).textContent).toBe('Sign in and create claude-default-2');
    await click(runtime, 'the runtime choice');
    // Change starts the choice over, the runtime default with it.
    await click(c.querySelector('[data-add-login-change]'), 'Change');
    expect(c.querySelector('[data-add-login-choices]')).not.toBeNull();
    await click(c.querySelector('[data-add-login-choice="claude"]'), 'the Claude Code tile');
    await click(submit(c), 'Sign in to Claude Code');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(changeBodies(calls)).toEqual([{ kind: 'credential.add', id: 'claude', harness: 'claude' }]);
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
    await click(submit(c), 'the one button');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(text(c, '[data-change-refusal]')).toBe('Account setup changes are switched off on this machine for now.');
    expect(only(calls, APPLY)).toHaveLength(0);
    expect(only(calls, LOGIN)).toHaveLength(0);
    expect(submit(c).textContent).toBe('Sign in and create claude-default');
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
    await click(submit(c), 'Sign in to Claude Code');
    await until(() => c.querySelector('[data-add-login-start-refused]') !== null, 'the refusal');
    expect(text(c, '[data-add-login-start-refused]')).toBe('Claude Code is not installed on studio-mac.');
    expect(c.querySelector('[data-credential-sign-in="start"]')).not.toBeNull();

    answer = claudeFlow('awaiting-code', 'claude');
    await click(c.querySelector('[data-credential-sign-in="start"] [data-change-submit]'), 'its own start');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    expect(only(calls, LOGIN)).toHaveLength(2);
    expect(changeBodies(calls)).toHaveLength(1);
    await view.unmount();
  });

  it('signs in to Codex with its device code, polling until it is approved', async () => {
    const fresh = { ...credential({ id: 'codex-2', harness: 'codex' }) };
    delete fresh.email;
    let approved = false;
    const awaiting = {
      harness: 'codex',
      flowId: 'flow-1',
      credentialId: 'codex-2',
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
    await click(submit(c), 'Sign in to Codex');
    await until(() => c.querySelector('[data-codex-login="awaiting-approval"]') !== null, 'the device code');
    expect(changeBodies(calls)).toEqual([{ kind: 'credential.add', id: 'codex-2', harness: 'codex' }]);
    approved = true;
    await until(() => c.querySelector('[data-add-login-done]') !== null, 'signed in');
    expect(text(c, '[data-add-login-done] > p')).toBe('Signed in to Codex as Codex login');
    await click(c.querySelector('[data-add-login-finish]'), 'Done');
    expect(events).toEqual(['added codex-2']);
    await view.unmount();
  });
});

describe('AddLogin · Label (E26)', () => {
  it('asks for two different labels when this email already has a login, inline, and saves both', async () => {
    const { view, calls, events } = await open({
      fresh: credential({ id: 'claude' }),
      runtimes: RUNTIMES,
      routes: CLAUDE_SIGNS_IN,
    });
    const c = view.container;
    await signInToClaude(c);
    expect(text(c, '[data-add-login-done] > p')).toBe('Signed in to Claude Code as you@example.com');
    const finish = must(c.querySelector('[data-add-login-finish]'), 'the next button');
    expect(finish.textContent).toBe('Next: label them');
    await click(finish, 'Next: label them');

    expect(text(c, '[data-add-login-label] > p')).toBe(
      'You already have a Claude Code login for you@example.com. Label both so you can tell them apart.',
    );
    const older = must(c.querySelector<HTMLInputElement>('#add-login-label-old'), 'the old label');
    const newer = must(c.querySelector<HTMLInputElement>('#add-login-label-new'), 'the new label');
    expect(older.value).toBe('personal');
    expect(newer.value).toBe('work');
    expect(c.textContent).toContain('Used by 3 runtimes.');
    expect(c.querySelector('[data-stepper-position]')).toBeNull();
    const save = (): HTMLButtonElement => submit(c);
    expect(save().textContent).toBe('Save labels');

    await type(newer, 'personal');
    expect(text(c, '[data-add-login-label-error]')).toBe('Use two different labels.');
    expect(save().disabled).toBe(true);
    await type(older, 'home');
    await type(newer, ' side ');
    expect(c.querySelector('[data-add-login-label-error]')).toBeNull();
    await click(save(), 'Save labels');
    await until(() => events.length > 0, 'added');
    expect(changeBodies(calls).slice(1)).toEqual([
      { kind: 'credential.label', id: 'claude-personal', label: 'home' },
      { kind: 'credential.label', id: 'claude', label: 'side' },
    ]);
    expect(events).toEqual(['added claude']);
    await view.unmount();
  });

  it('a twin labelled work makes the new one "side", and a refused label stays with its refusal', async () => {
    let refuseId: string | null = 'claude-work';
    const { view, calls, events } = await open({
      existing: [credential({ id: 'claude-work', label: 'work' })],
      fresh: credential({ id: 'claude' }),
      runtimes: RUNTIMES,
      routes: CLAUDE_SIGNS_IN,
      refuse: change =>
        change.kind === 'credential.label' && change.id === refuseId
          ? new FyHttpError(`Could not label ${change.id}.`, 409, 'fleet_change_refused')
          : undefined,
    });
    const c = view.container;
    await signInToClaude(c);
    await click(c.querySelector('[data-add-login-finish]'), 'Next: label them');
    expect(must(c.querySelector<HTMLInputElement>('#add-login-label-old'), 'old').value).toBe('work');
    expect(must(c.querySelector<HTMLInputElement>('#add-login-label-new'), 'new').value).toBe('side');
    await click(submit(c), 'Save labels');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(text(c, '[data-change-refusal]')).toBe('Could not label claude-work.');
    refuseId = 'claude';
    await click(submit(c), 'Save labels');
    await until(() => text(c, '[data-change-refusal]') === 'Could not label claude.', 'the second refusal');
    expect(only(calls, APPLY)).toHaveLength(2);
    expect(events).toEqual([]);
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
        name: 'claude-default',
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
    expect(c.querySelector('[data-add-login-runtime]')?.getAttribute('data-add-login-runtime')).toBe('codex-default');
    await type(c.querySelector('[data-env-variable="AZURE_OPENAI_RESOURCE"] input'), 'acme');
    await type(c.querySelector('[data-env-secret-input="AZURE_OPENAI_API_KEY"]'), 'azure-key');
    await click(submit(c), 'Add login and runtime');
    await until(() => c.querySelector('[data-add-login-runtime-made]') !== null, 'the runtime made');
    // A login that drives one CLI runs it: the runtime names no harness.
    expect(changeBodies(calls)[1]).toEqual({
      kind: 'runtime.put',
      name: 'codex-default',
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
    await click(submit(c), 'the one button');
    await until(() => c.querySelector('[data-claude-login="awaiting-code"]') !== null, 'the Claude link');
    await click(c.querySelector('[data-add-login-back]'), 'Logins');
    expect(text(c, '[data-add-login-confirm] > p:nth-child(2)')).toBe(
      'The login you added is kept, and can be signed in from its own page.',
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
