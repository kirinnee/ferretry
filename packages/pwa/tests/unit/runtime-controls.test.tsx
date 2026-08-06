import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import {
  CLAUDE_EFFORT_LEVELS,
  ClaudeEffortChoices,
  codexPickerFallbackNeeded,
  effortDisplayName,
  isEffortActionUnsupported,
  isPromptKnownBusy,
  isRuntimeEndpointUnavailable,
  type RuntimeControlCommand,
  RuntimeEffortControls,
  type RuntimeModelCatalogSource,
  RuntimeModelChoices,
  RuntimeModelControls,
  RuntimeReasoningChoices,
  runtimeControlUnavailableMessage,
} from '../../src/components/runtime-controls.tsx';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { RuntimeModelCatalog } from '../../src/lib/runtime-models.ts';
import { interact, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceToken: 'token-a' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceToken: 'token-b' });

const view = (overrides: Parameters<typeof sessionView>[1] = {}): SessionView =>
  sessionView('s-1', {
    ...overrides,
    config: { harness: 'claude', ...overrides.config },
    state: { status: 'running', promptReady: true, ...overrides.state },
  });

const claudeCatalog: RuntimeModelCatalog = {
  harness: 'claude',
  source: 'wrapper-inventory',
  choices: [
    { value: 'claude-opus-5', label: 'Opus 5', description: 'The big one', isDefault: true, reasoningEfforts: [] },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5', reasoningEfforts: [] },
  ],
};

const codexCatalog: RuntimeModelCatalog = {
  harness: 'codex',
  source: 'codex-app-server',
  choices: [
    {
      value: 'gpt-5.6',
      label: 'GPT-5.6',
      defaultReasoningEffort: 'medium',
      reasoningEfforts: [{ value: 'medium', description: 'balanced' }, { value: 'xhigh' }],
    },
  ],
};

/** A catalog source whose answer the test controls, one scope at a time. */
const source = (answer: (daemon: DaemonConnection) => Promise<RuntimeModelCatalog>): RuntimeModelCatalogSource => ({
  load: daemon => answer(daemon),
});

const resolved = (catalog: RuntimeModelCatalog): RuntimeModelCatalogSource => source(() => Promise.resolve(catalog));
const rejected = (reason: unknown): RuntimeModelCatalogSource => source(() => Promise.reject(reason));
const never = (): RuntimeModelCatalogSource => source(() => new Promise<RuntimeModelCatalog>(() => undefined));

interface Sent {
  readonly daemon: DaemonConnection;
  readonly sessionId: string;
  readonly command: RuntimeControlCommand;
  readonly requestId: string;
}

const recorder = (fail?: unknown) => {
  const sent: Sent[] = [];
  return {
    sent,
    api: {
      runtime: async (
        daemon: DaemonConnection,
        sessionId: string,
        command: RuntimeControlCommand,
        requestId: string,
      ) => {
        sent.push({ daemon, sessionId, command, requestId });
        if (fail !== undefined) throw fail;
      },
    },
  };
};

let requestIds = 0;
const nextRequestId = () => `req-${++requestIds}`;

const buttonsOf = (container: HTMLElement): HTMLButtonElement[] => [...container.querySelectorAll('button')];
const byLabel = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    buttonsOf(container).find(button => button.getAttribute('aria-label') === label),
    `a button labelled ${label}`,
  );
const byText = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    buttonsOf(container).find(button => (button.textContent ?? '').includes(text)),
    `a button reading ${text}`,
  );
const click = (button: HTMLButtonElement) =>
  interact(() => button.dispatchEvent(new Event('click', { bubbles: true })));

describe('runtime failure classification', () => {
  test('separates version skew from an ordinary failure', () => {
    expect(isRuntimeEndpointUnavailable({ status: 404, code: 'unknown_route' })).toBe(true);
    expect(isRuntimeEndpointUnavailable({ status: 404, code: 'no_session' })).toBe(false);
    expect(isRuntimeEndpointUnavailable('nope')).toBe(false);
    expect(isRuntimeEndpointUnavailable(null)).toBe(false);
  });

  test('treats a rejected effort action as a daemon that has not learned the verb', () => {
    expect(isEffortActionUnsupported({ status: 400, message: 'unsupported runtime action' })).toBe(true);
    expect(isEffortActionUnsupported({ status: 400, message: 'busy pane' })).toBe(false);
    expect(isEffortActionUnsupported(undefined)).toBe(false);
  });

  test('the skew message names the control and refuses to promise a restart helps', () => {
    expect(runtimeControlUnavailableMessage('model')).toContain('in-session model switching');
    expect(runtimeControlUnavailableMessage('effort')).toContain('restarting the same build will not help');
  });
});

describe('isPromptKnownBusy', () => {
  test('answers only for an explicit false, so an unreported prompt stays unknown', () => {
    // The one predicate the composer's chip and these sheets both read. Three
    // answers, not two: absent is a daemon that did not say, and the daemon's
    // own live pane inspection is what decides that case.
    expect(isPromptKnownBusy(view({ state: { promptReady: false } }).state)).toBe(true);
    expect(isPromptKnownBusy(view({ state: { promptReady: true } }).state)).toBe(false);
    expect(isPromptKnownBusy(view({ state: { promptReady: undefined } }).state)).toBe(false);
  });
});

describe('codexPickerFallbackNeeded', () => {
  const choice = codexCatalog.choices[0]!;
  test('offers the native picker exactly when the live catalog cannot answer', () => {
    expect(codexPickerFallbackNeeded(null, new Error('boom'))).toBe(true);
    expect(codexPickerFallbackNeeded(null, null)).toBe(false);
    expect(codexPickerFallbackNeeded({ ...codexCatalog, choices: [] }, null)).toBe(true);
    expect(codexPickerFallbackNeeded(codexCatalog, null, undefined, true)).toBe(true);
    expect(codexPickerFallbackNeeded(codexCatalog, null, choice)).toBe(false);
    expect(codexPickerFallbackNeeded(codexCatalog, null, { ...choice, reasoningEfforts: [] })).toBe(true);
    // Without `requireChoice`, a not-yet-chosen model is not a reason to fall back.
    expect(codexPickerFallbackNeeded(codexCatalog, null)).toBe(false);
  });
});

describe('effortDisplayName', () => {
  test('spells xhigh out and capitalises the rest', () => {
    expect(effortDisplayName('xhigh')).toBe('Extra high');
    expect(effortDisplayName('medium')).toBe('Medium');
  });
});

describe('RuntimeModelChoices', () => {
  test('reports a catalog failure instead of an empty list', async () => {
    const screen = await mount(
      <RuntimeModelChoices
        choices={null}
        disabled={false}
        error={new Error('catalog exploded')}
        harness="claude"
        onChoose={() => undefined}
      />,
    );
    expect(must(screen.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'catalog exploded',
    );
    await screen.unmount();
  });

  test('shows a loading readout while the catalog is unknown', async () => {
    const screen = await mount(
      <RuntimeModelChoices choices={null} disabled={false} error={null} harness="claude" onChoose={() => undefined} />,
    );
    expect(screen.container.textContent).toContain('Loading account-aware model choices');
    await screen.unmount();
  });

  test('says so when the account advertises nothing', async () => {
    const screen = await mount(
      <RuntimeModelChoices choices={[]} disabled={false} error={null} harness="claude" onChoose={() => undefined} />,
    );
    expect(screen.container.textContent).toContain('does not advertise any in-place model choices');
    await screen.unmount();
  });

  test('renders a real list, marks current and default, and hides a redundant value line', async () => {
    const chosen: string[] = [];
    const screen = await mount(
      <RuntimeModelChoices
        choices={claudeCatalog.choices}
        currentModel="claude-sonnet-5"
        disabled={false}
        error={null}
        harness="claude"
        onChoose={choice => chosen.push(choice.value)}
        submittingModel="claude-opus-5"
      />,
    );

    // A labelled list must be a real `<ul>`: `aria-label` on a div has no role.
    const list = must(screen.container.querySelector('ul'), 'the choice list');
    expect(list.getAttribute('aria-label')).toBe('Switch claude model in place');
    expect(list.querySelectorAll('li').length).toBe(2);

    const current = byLabel(screen.container, 'Switch model in place to claude-sonnet-5, current');
    expect(current.getAttribute('aria-current')).toBe('true');
    // label === value, so the mono second line is suppressed.
    expect(current.querySelectorAll('.mono').length).toBe(0);

    const pending = byLabel(screen.container, 'Switch model in place to Opus 5');
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.textContent).toContain('Default');
    expect(pending.textContent).toContain('The big one');
    expect(must(pending.querySelector('.mono'), 'the value line').textContent).toBe('claude-opus-5');

    await click(current);
    expect(chosen).toEqual(['claude-sonnet-5']);
    await screen.unmount();
  });

  test('tells a Codex reader the list is a first step', async () => {
    const screen = await mount(
      <RuntimeModelChoices
        choices={codexCatalog.choices}
        disabled
        error={null}
        harness="codex"
        onChoose={() => undefined}
      />,
    );
    expect(screen.container.textContent).toContain('then one of its advertised reasoning levels');
    expect(byText(screen.container, 'GPT-5.6').disabled).toBe(true);
    await screen.unmount();
  });
});

describe('RuntimeReasoningChoices', () => {
  test('refuses to render a level list a model never advertised', async () => {
    const screen = await mount(
      <RuntimeReasoningChoices
        disabled={false}
        model={{ ...codexCatalog.choices[0]!, reasoningEfforts: [] }}
        onChoose={() => undefined}
      />,
    );
    expect(must(screen.container.querySelector('[role="alert"]'), 'the alert').textContent).toContain(
      'did not advertise any supported reasoning levels',
    );
    await screen.unmount();
  });

  test('marks the current and default levels and reports the chosen one', async () => {
    const chosen: string[] = [];
    const screen = await mount(
      <RuntimeReasoningChoices
        currentEffort="xhigh"
        disabled={false}
        model={codexCatalog.choices[0]!}
        onChoose={effort => chosen.push(effort)}
        submittingEffort="medium"
      />,
    );
    const medium = byLabel(screen.container, 'Set GPT-5.6 reasoning to Medium');
    expect(medium.getAttribute('aria-busy')).toBe('true');
    expect(medium.textContent).toContain('Default');
    expect(medium.textContent).toContain('balanced');

    const current = byLabel(screen.container, 'Set GPT-5.6 reasoning to Extra high, current');
    expect(current.getAttribute('aria-current')).toBe('true');

    await click(current);
    expect(chosen).toEqual(['xhigh']);
    await screen.unmount();
  });
});

describe('ClaudeEffortChoices', () => {
  test('offers exactly the four persistable levels as real list items', async () => {
    const chosen: string[] = [];
    const screen = await mount(<ClaudeEffortChoices disabled={false} onChoose={level => chosen.push(level)} />);
    const list = must(screen.container.querySelector('ul'), 'the level list');
    expect(list.getAttribute('aria-label')).toBe('Set Claude reasoning effort');
    expect(list.querySelectorAll('li').length).toBe(CLAUDE_EFFORT_LEVELS.length);
    await click(byLabel(screen.container, 'Set reasoning effort to xhigh'));
    expect(chosen).toEqual(['xhigh']);
    await screen.unmount();
  });
});

describe('RuntimeModelControls', () => {
  const props = (overrides: Partial<Parameters<typeof RuntimeModelControls>[0]> = {}) => ({
    api: recorder().api,
    canControl: true,
    catalogs: resolved(claudeCatalog),
    daemon: alpha,
    newRequestId: nextRequestId,
    onClose: () => undefined,
    open: true,
    view: view(),
    ...overrides,
  });

  test('refuses a finished session and never fetches a catalog for it', async () => {
    let loads = 0;
    const catalogs = source(() => {
      loads += 1;
      return Promise.resolve(claudeCatalog);
    });
    const screen = await mount(
      <RuntimeModelControls {...props({ catalogs, view: view({ state: { status: 'completed' } }) })} />,
    );
    expect(screen.container.textContent).toContain('requires a running session');
    expect(loads).toBe(0);
    await screen.unmount();
  });

  test('refuses a read-only daemon', async () => {
    const screen = await mount(<RuntimeModelControls {...props({ canControl: false })} />);
    expect(screen.container.textContent).toContain('read-only');
    await screen.unmount();
  });

  test('warns while the pane is busy and disables every choice', async () => {
    const screen = await mount(<RuntimeModelControls {...props({ view: view({ state: { promptReady: false } }) })} />);
    expect(screen.container.textContent).toContain('Wait for an idle prompt before switching model');
    expect(byText(screen.container, 'Opus 5').disabled).toBe(true);
    await screen.unmount();
  });

  test('attempts the switch when the daemon reported no readiness at all, and surfaces its refusal', async () => {
    // ABSENT IS UNKNOWN, NOT BUSY. The shipping daemon omits `promptReady` for
    // idle sessions whose POST it then accepts after inspecting the live pane,
    // so a missing field must not pre-refuse. The pane inspection is what makes
    // deferring safe: when the pane really is mid-turn the daemon says so, and
    // that sentence is what the reader is shown.
    // Arrange
    const unknown = view({ state: { promptReady: undefined } });
    const { api, sent } = recorder({
      status: 409,
      message: 'a runtime control is available only while the harness is waiting at an idle prompt',
    });
    const screen = await mount(<RuntimeModelControls {...props({ api, view: unknown })} />);

    // Assert — nothing is pre-refused on no evidence.
    expect(unknown.state.promptReady).toBeUndefined();
    expect(screen.container.textContent).not.toContain('Wait for an idle prompt');
    expect(byText(screen.container, 'Opus 5').disabled).toBe(false);

    // Act — the attempt reaches the daemon, which is the authority on the pane.
    await click(byText(screen.container, 'Opus 5'));

    // Assert
    expect(sent).toHaveLength(1);
    expect(sent[0]?.command).toEqual({ action: 'model', model: 'claude-opus-5' });
    expect(must(screen.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'waiting at an idle prompt',
    );
    await screen.unmount();
  });

  test('sends a Claude switch to the daemon it was handed, with a fresh request id', async () => {
    const submitted: string[] = [];
    const { api, sent } = recorder();
    const screen = await mount(
      <RuntimeModelControls {...props({ api, onSwitchSubmitted: () => submitted.push('pending') })} />,
    );
    await click(byText(screen.container, 'Opus 5'));

    expect(submitted).toEqual(['pending']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.daemon).toBe(alpha);
    expect(sent[0]!.sessionId).toBe('s-1');
    expect(sent[0]!.command).toEqual({ action: 'model', model: 'claude-opus-5' });
    expect(sent[0]!.requestId).toMatch(/^req-\d+$/);
    expect(screen.container.textContent).toContain('Verification updates after the next model response');
    await screen.unmount();
  });

  test('reports a failed switch and hands the host back its readout', async () => {
    const failed: string[] = [];
    const { api } = recorder({ status: 500, message: 'pane is gone' });
    const screen = await mount(
      <RuntimeModelControls {...props({ api, onSwitchFailed: () => failed.push('rolled back') })} />,
    );
    await click(byText(screen.container, 'Opus 5'));
    expect(failed).toEqual(['rolled back']);
    expect(must(screen.container.querySelector('[role="alert"]'), 'the failure').textContent).toContain('pane is gone');
    await screen.unmount();
  });

  test('turns a missing runtime route into an update-the-daemon notice, not a red error', async () => {
    const { api } = recorder({ status: 404, code: 'unknown_route' });
    const screen = await mount(<RuntimeModelControls {...props({ api })} />);
    await click(byText(screen.container, 'Opus 5'));
    expect(must(screen.container.querySelector('[role="alert"]'), 'the skew notice').textContent).toContain(
      'older than this web UI',
    );
    await screen.unmount();
  });

  test('takes Codex through model then reasoning, and applies both as one command', async () => {
    const { api, sent } = recorder();
    const codex = view({ config: { harness: 'codex' }, state: { observedModel: 'gpt-5.6' } });
    const screen = await mount(
      <RuntimeModelControls {...props({ api, catalogs: resolved(codexCatalog), view: codex })} />,
    );

    await click(byText(screen.container, 'GPT-5.6'));
    expect(sent).toHaveLength(0);
    expect(screen.container.textContent).toContain('The switch stays pending until Codex reports');

    // The second step must be leavable by keyboard, so focus is moved to Back.
    expect(document.activeElement).toBe(byText(screen.container, 'Back to models'));

    await click(byLabel(screen.container, 'Set GPT-5.6 reasoning to Extra high'));
    expect(sent[0]!.command).toEqual({ action: 'model', model: 'gpt-5.6', effort: 'xhigh' });
    expect(screen.container.textContent).toContain('Codex confirmed gpt-5.6 · xhigh');
    await screen.unmount();
  });

  test('returns to the model list from the reasoning step', async () => {
    const codex = view({ config: { harness: 'codex' } });
    const screen = await mount(<RuntimeModelControls {...props({ catalogs: resolved(codexCatalog), view: codex })} />);
    await click(byText(screen.container, 'GPT-5.6'));
    await click(byText(screen.container, 'Back to models'));
    expect(screen.container.textContent).toContain('then one of its advertised reasoning levels');
    await screen.unmount();
  });

  test('falls back to the native picker and closes the sheet once Terminal is showing', async () => {
    const { api, sent } = recorder();
    const closed: string[] = [];
    const codex = view({ config: { harness: 'codex' } });
    const screen = await mount(
      <RuntimeModelControls
        {...props({
          api,
          catalogs: resolved({ ...codexCatalog, choices: [] }),
          onClose: () => closed.push('closed'),
          onOpenTerminal: () => true,
          view: codex,
        })}
      />,
    );
    await click(byText(screen.container, 'Use native picker in Terminal'));
    expect(sent[0]!.command).toEqual({ action: 'model' });
    expect(closed).toEqual(['closed']);
    await screen.unmount();
  });

  test('claims no switch when the host could not show Terminal', async () => {
    const codex = view({ config: { harness: 'codex' } });
    const screen = await mount(
      <RuntimeModelControls
        {...props({ catalogs: resolved({ ...codexCatalog, choices: [] }), onOpenTerminal: () => false, view: codex })}
      />,
    );
    await click(byText(screen.container, 'Use native picker in Terminal'));
    expect(screen.container.textContent).toContain('No switch is claimed until Codex reports one');
    await screen.unmount();
  });

  test('discards a catalog whose harness does not match the session', async () => {
    const screen = await mount(<RuntimeModelControls {...props({ catalogs: resolved(codexCatalog) })} />);
    expect(must(screen.container.querySelector('[role="alert"]'), 'the mismatch alert').textContent).toContain(
      'codex model catalog for a claude session',
    );
    await screen.unmount();
  });

  test('surfaces a catalog rejection through the choice list', async () => {
    const screen = await mount(<RuntimeModelControls {...props({ catalogs: rejected(new Error('offline')) })} />);
    expect(screen.container.textContent).toContain('Account-aware model choices are unavailable: offline');
    await screen.unmount();
  });

  test('never fetches while the sheet is closed, and forgets the Codex step on close', async () => {
    let loads = 0;
    const catalogs = source(() => {
      loads += 1;
      return Promise.resolve(codexCatalog);
    });
    const codex = view({ config: { harness: 'codex' } });
    const closedProps = props({ catalogs, open: false, view: codex });
    const screen = await mount(<RuntimeModelControls {...closedProps} />);
    expect(loads).toBe(0);

    await screen.render(<RuntimeModelControls {...closedProps} open />);
    expect(loads).toBe(1);
    await click(byText(screen.container, 'GPT-5.6'));
    expect(screen.container.textContent).toContain('Back to models');

    await screen.render(<RuntimeModelControls {...closedProps} open={false} />);
    await screen.render(<RuntimeModelControls {...closedProps} open />);
    expect(screen.container.textContent).not.toContain('Back to models');
    await screen.unmount();
  });

  test('a daemon switch discards the previous daemon’s catalog and notice', async () => {
    const seen: string[] = [];
    const catalogs = source(daemon => {
      seen.push(daemon.daemonId);
      return Promise.resolve(daemon === alpha ? claudeCatalog : { ...claudeCatalog, choices: [] });
    });
    const first = props({ catalogs });
    const screen = await mount(<RuntimeModelControls {...first} />);
    await click(byText(screen.container, 'Opus 5'));
    expect(screen.container.textContent).toContain('Model command sent');

    await screen.render(<RuntimeModelControls {...first} daemon={beta} />);
    expect(seen).toEqual(['alpha', 'beta']);
    expect(screen.container.textContent).not.toContain('Model command sent');
    expect(screen.container.textContent).toContain('does not advertise any in-place model choices');
    expect(
      must(screen.container.querySelector('[data-daemon-id]'), 'the scope marker').getAttribute('data-daemon-id'),
    ).toBe('beta');
    await screen.unmount();
  });

  test('mints its own request id when the host does not supply one', async () => {
    const { api, sent } = recorder();
    const screen = await mount(<RuntimeModelControls {...props({ api, newRequestId: undefined })} />);
    await click(byText(screen.container, 'Opus 5'));
    expect(sent[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await screen.unmount();
  });

  test('reports nothing while the catalog is still in flight', async () => {
    const screen = await mount(<RuntimeModelControls {...props({ catalogs: never() })} />);
    expect(screen.container.textContent).toContain('Loading account-aware model choices');
    await screen.unmount();
  });
});

describe('RuntimeEffortControls', () => {
  const props = (overrides: Partial<Parameters<typeof RuntimeEffortControls>[0]> = {}) => ({
    api: recorder().api,
    canControl: true,
    catalogs: resolved(codexCatalog),
    daemon: alpha,
    newRequestId: nextRequestId,
    onClose: () => undefined,
    view: view(),
    ...overrides,
  });

  test('refuses a finished session', async () => {
    const screen = await mount(<RuntimeEffortControls {...props({ view: view({ state: { status: 'stopped' } }) })} />);
    expect(screen.container.textContent).toContain('requires a running session');
    await screen.unmount();
  });

  test('refuses a read-only daemon', async () => {
    const screen = await mount(<RuntimeEffortControls {...props({ canControl: false })} />);
    expect(screen.container.textContent).toContain('read-only');
    await screen.unmount();
  });

  test('warns while the pane is busy', async () => {
    const screen = await mount(<RuntimeEffortControls {...props({ view: view({ state: { promptReady: false } }) })} />);
    expect(screen.container.textContent).toContain('Wait for an idle prompt before changing the reasoning level');
    await screen.unmount();
  });

  test('attempts a level when the daemon reported no readiness at all', async () => {
    // The reasoning sheet answers the third state the same way the model sheet
    // does: absent is unknown, the attempt goes out, and the live pane decides.
    // Arrange
    const unknown = view({ state: { promptReady: undefined } });
    const { api, sent } = recorder();
    const screen = await mount(<RuntimeEffortControls {...props({ api, view: unknown })} />);

    // Assert
    expect(screen.container.textContent).not.toContain('Wait for an idle prompt');
    expect(byLabel(screen.container, 'Set reasoning effort to high').disabled).toBe(false);

    // Act
    await click(byLabel(screen.container, 'Set reasoning effort to high'));

    // Assert
    expect(sent[0]!.command).toEqual({ action: 'effort', effort: 'high' });
    await screen.unmount();
  });

  test('holds a level back on an explicitly busy pane rather than sending it', async () => {
    // `false` IS evidence, so this one never leaves the browser.
    // Arrange
    const { api, sent } = recorder();
    const screen = await mount(
      <RuntimeEffortControls {...props({ api, view: view({ state: { promptReady: false } }) })} />,
    );

    // Act
    await click(byLabel(screen.container, 'Set reasoning effort to high'));

    // Assert
    expect(sent).toHaveLength(0);
    expect(byLabel(screen.container, 'Set reasoning effort to high').disabled).toBe(true);
    await screen.unmount();
  });

  test('persists a Claude level and tells the host it was sent, never observed', async () => {
    const { api, sent } = recorder();
    const persisted: string[] = [];
    const screen = await mount(
      <RuntimeEffortControls {...props({ api, onClaudeEffortSent: level => persisted.push(level) })} />,
    );
    await click(byLabel(screen.container, 'Set reasoning effort to high'));
    expect(sent[0]!.command).toEqual({ action: 'effort', effort: 'high' });
    expect(sent[0]!.daemon).toBe(alpha);
    expect(persisted).toEqual(['high']);
    expect(screen.container.textContent).toContain('Effort set to high');
    await screen.unmount();
  });

  test('treats a rejected effort verb as version skew rather than a red error', async () => {
    const { api } = recorder({ status: 400, message: 'unknown runtime action' });
    const screen = await mount(<RuntimeEffortControls {...props({ api })} />);
    await click(byLabel(screen.container, 'Set reasoning effort to low'));
    expect(must(screen.container.querySelector('[role="alert"]'), 'the skew notice').textContent).toContain(
      'older than this web UI',
    );
    await screen.unmount();
  });

  test('reports an ordinary Claude failure', async () => {
    const { api } = recorder(new Error('daemon said no'));
    const screen = await mount(<RuntimeEffortControls {...props({ api })} />);
    await click(byLabel(screen.container, 'Set reasoning effort to medium'));
    expect(must(screen.container.querySelector('[role="alert"]'), 'the failure').textContent).toContain(
      'daemon said no',
    );
    await screen.unmount();
  });

  test('never reads a catalog for a Claude session', async () => {
    let loads = 0;
    const catalogs = source(() => {
      loads += 1;
      return Promise.resolve(claudeCatalog);
    });
    const screen = await mount(<RuntimeEffortControls {...props({ catalogs })} />);
    expect(loads).toBe(0);
    await screen.unmount();
  });

  test('drives the Codex native picker for the observed model', async () => {
    const { api, sent } = recorder();
    const submitted: string[] = [];
    const codex = view({
      config: { harness: 'codex' },
      state: { observedModel: 'gpt-5.6', observedReasoningEffort: 'medium' },
    });
    const screen = await mount(
      <RuntimeEffortControls {...props({ api, onSwitchSubmitted: () => submitted.push('pending'), view: codex })} />,
    );
    await click(byLabel(screen.container, 'Set GPT-5.6 reasoning to Extra high'));
    expect(submitted).toEqual(['pending']);
    expect(sent[0]!.command).toEqual({ action: 'model', model: 'gpt-5.6', effort: 'xhigh' });
    expect(screen.container.textContent).toContain('Codex confirmed gpt-5.6 · xhigh');
    await screen.unmount();
  });

  test('rolls the host readout back when a Codex switch fails', async () => {
    const failed: string[] = [];
    const { api } = recorder({ status: 503, message: 'app-server down' });
    const codex = view({ config: { harness: 'codex' }, state: { observedModel: 'gpt-5.6' } });
    const screen = await mount(
      <RuntimeEffortControls {...props({ api, onSwitchFailed: () => failed.push('rolled back'), view: codex })} />,
    );
    await click(byLabel(screen.container, 'Set GPT-5.6 reasoning to Medium'));
    expect(failed).toEqual(['rolled back']);
    expect(screen.container.textContent).toContain('app-server down');
    await screen.unmount();
  });

  test('turns a missing route into version skew during a Codex switch', async () => {
    const { api } = recorder({ status: 404, code: 'unknown_route' });
    const codex = view({ config: { harness: 'codex' }, state: { observedModel: 'gpt-5.6' } });
    const screen = await mount(<RuntimeEffortControls {...props({ api, view: codex })} />);
    await click(byLabel(screen.container, 'Set GPT-5.6 reasoning to Medium'));
    expect(must(screen.container.querySelector('[role="alert"]'), 'the skew notice').textContent).toContain(
      'older than this web UI',
    );
    await screen.unmount();
  });

  test('says the observed model left the catalog rather than guessing a level', async () => {
    const codex = view({ config: { harness: 'codex' }, state: { observedModel: 'gpt-4' } });
    const screen = await mount(<RuntimeEffortControls {...props({ view: codex })} />);
    expect(screen.container.textContent).toContain('The observed model (gpt-4) is not in this account');
    await screen.unmount();
  });

  test('names the missing observation when the daemon reported none at all', async () => {
    const codex = view({ config: { harness: 'codex' } });
    const screen = await mount(<RuntimeEffortControls {...props({ view: codex })} />);
    expect(screen.container.textContent).toContain('The observed model (unknown)');
    await screen.unmount();
  });

  test('shows a loading readout for a Codex catalog still in flight', async () => {
    const codex = view({ config: { harness: 'codex' } });
    const screen = await mount(<RuntimeEffortControls {...props({ catalogs: never(), view: codex })} />);
    expect(screen.container.textContent).toContain('Loading account-aware reasoning choices');
    await screen.unmount();
  });

  test('reports a Codex catalog failure and offers the Terminal fallback', async () => {
    const { api, sent } = recorder();
    const closed: string[] = [];
    const codex = view({ config: { harness: 'codex' } });
    const screen = await mount(
      <RuntimeEffortControls
        {...props({
          api,
          catalogs: rejected(new Error('no app-server')),
          onClose: () => closed.push('closed'),
          onOpenTerminal: () => true,
          view: codex,
        })}
      />,
    );
    expect(screen.container.textContent).toContain('Account-aware reasoning choices are unavailable: no app-server');
    await click(byText(screen.container, 'Use native picker in Terminal'));
    expect(sent[0]!.command).toEqual({ action: 'model' });
    expect(closed).toEqual(['closed']);
    await screen.unmount();
  });

  test('claims no Codex switch when Terminal could not be shown', async () => {
    const codex = view({ config: { harness: 'codex' } });
    const screen = await mount(
      <RuntimeEffortControls
        {...props({ catalogs: rejected(new Error('no app-server')), onOpenTerminal: () => false, view: codex })}
      />,
    );
    await click(byText(screen.container, 'Use native picker in Terminal'));
    expect(screen.container.textContent).toContain('No switch is claimed until Codex reports one');
    await screen.unmount();
  });

  test('reports a failed fallback, and version skew separately', async () => {
    const codex = view({ config: { harness: 'codex' } });
    const catalogs = rejected(new Error('no app-server'));
    const failing = await mount(
      <RuntimeEffortControls {...props({ api: recorder(new Error('picker refused')).api, catalogs, view: codex })} />,
    );
    await click(byText(failing.container, 'Use native picker in Terminal'));
    expect(failing.container.textContent).toContain('picker refused');
    await failing.unmount();

    const skewed = await mount(
      <RuntimeEffortControls
        {...props({ api: recorder({ status: 404, code: 'unknown_route' }).api, catalogs, view: codex })}
      />,
    );
    await click(byText(skewed.container, 'Use native picker in Terminal'));
    expect(skewed.container.textContent).toContain('older than this web UI');
    await skewed.unmount();
  });

  test('mints its own request id when the host does not supply one', async () => {
    const { api, sent } = recorder();
    const screen = await mount(<RuntimeEffortControls {...props({ api, newRequestId: undefined })} />);
    await click(byLabel(screen.container, 'Set reasoning effort to low'));
    expect(sent[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await screen.unmount();
  });

  test('a daemon switch clears the notice that belonged to the previous daemon', async () => {
    const { api } = recorder();
    const base = props({ api });
    const screen = await mount(<RuntimeEffortControls {...base} />);
    await click(byLabel(screen.container, 'Set reasoning effort to high'));
    expect(screen.container.textContent).toContain('Effort set to high');

    await screen.render(<RuntimeEffortControls {...base} daemon={beta} />);
    expect(screen.container.textContent).not.toContain('Effort set to high');
    await screen.unmount();
  });
});
