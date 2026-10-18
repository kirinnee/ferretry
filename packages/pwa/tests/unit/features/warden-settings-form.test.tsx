import { describe, expect, it } from 'bun:test';
import type { WardenAccount, WardenConfig, WardenLogin } from '@ferretry/protocol';
import { useState } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import { WardenSettingsForm, wardenPrivacyNote } from '../../../src/features/warden/warden-settings-form.tsx';
import { type JevKeyStatus, wardenFormErrors } from '../../../src/features/warden/warden-settings-model.ts';
import { render, run } from '../../support/react.ts';
import { wardenConfig } from '../../support/warden.ts';

interface HarnessProps {
  readonly initial: WardenConfig;
  readonly jevKey?: JevKeyStatus;
  readonly loginOptions?: readonly WardenAccount[];
  readonly login?: WardenLogin;
  readonly machineDefault?: string;
  readonly speedupsHref?: string;
  readonly onNavigate?: (to: string) => void;
  readonly changes: WardenConfig[];
}

/** The form is controlled: this holds the value the way Settings and onboarding do. */
function Harness({
  initial,
  jevKey = { state: 'set' },
  loginOptions,
  login,
  machineDefault,
  speedupsHref,
  onNavigate,
  changes,
}: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <WardenSettingsForm
      value={value}
      onChange={next => {
        changes.push(next);
        setValue(next);
      }}
      jevKey={jevKey}
      errors={wardenFormErrors(value)}
      {...(loginOptions === undefined ? {} : { loginOptions })}
      {...(login === undefined ? {} : { login })}
      {...(machineDefault === undefined ? {} : { machineDefault })}
      {...(speedupsHref === undefined ? {} : { speedupsHref })}
      {...(onNavigate === undefined ? {} : { onNavigate })}
    />
  );
}

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

/** The `<label>` whose first child is this text, and the one control inside it. */
const control = (renderer: ReactTestRenderer, label: string, type: string): ReactTestInstance => {
  const host = renderer.root.find(node => node.type === 'label' && node.children[0] === label);
  return host.find(node => node.type === type);
};

/** Every string under a node, in order. */
const flat = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(flat).join('');

/** A radio or checkbox by the words beside it: the tightest label that carries them. */
const option = (renderer: ReactTestRenderer, words: string): ReactTestInstance => {
  const labels = renderer.root
    .findAll(node => node.type === 'label' && flat(node).includes(words))
    .sort((left, right) => flat(left).length - flat(right).length);
  const label = labels[0];
  if (label === undefined) throw new Error(`no option says ${words}`);
  return label.find(node => node.type === 'input');
};

const last = (changes: WardenConfig[]): WardenConfig => {
  const value = changes.at(-1);
  if (value === undefined) throw new Error('no change was reported');
  return value;
};

describe('WardenSettingsForm', () => {
  it('should hide every AI section and say nothing leaves the machine under Rules only', () => {
    // Arrange
    const changes: WardenConfig[] = [];

    // Act
    const renderer = render(<Harness initial={wardenConfig({ triage: 'rules' })} changes={changes} />);

    // Assert
    const json = text(renderer);
    expect(json).toContain('What leaves this machine: nothing. Rules only sends nothing anywhere.');
    expect(json).not.toContain('Investigation (the assigned warden)');
    expect(json).not.toContain('Daily caps');
    expect(json).not.toContain('May act alone on a verdict');
    expect(json).toContain('free');
    expect(json).toContain('No AI runs and nothing is spent.');
    run(() => renderer.unmount());
  });

  it('should turn the Warden off and disable every setting under the switch', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig()} changes={changes} />);
    const toggle = renderer.root.findByProps({ role: 'switch' });

    // Act
    run(() => toggle.props.onClick());

    // Assert
    expect(last(changes).enabled).toBe(false);
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
    expect(renderer.root.find(node => node.type === 'fieldset' && node.props.disabled === true)).toBeDefined();
    expect(text(renderer)).toContain('The Warden is off.');
    run(() => renderer.root.findByProps({ role: 'switch' }).props.onClick());
    expect(last(changes).enabled).toBe(true);
    run(() => renderer.unmount());
  });

  it('should show the key pill for each key state and the no-key box with its links', () => {
    // Arrange
    const navigated: string[] = [];
    const jev = wardenConfig({ triage: 'jev' });

    // Act
    const set = render(<Harness initial={jev} changes={[]} jevKey={{ state: 'set' }} />);
    const missing = render(
      <Harness
        initial={jev}
        changes={[]}
        jevKey={{ state: 'missing', keyUrl: 'https://keys.example.test' }}
        speedupsHref="/d/a/settings#speedups"
        onNavigate={to => navigated.push(to)}
      />,
    );
    const unknown = render(<Harness initial={jev} changes={[]} jevKey={{ state: 'unknown' }} />);

    // Assert
    expect(text(set)).toContain('key set');
    expect(text(set)).not.toContain('No Jev key yet.');
    expect(text(set)).not.toContain('Needs a Jev key');
    expect(text(missing)).toContain('needs Jev key');
    expect(text(missing)).toContain('No Jev key yet.');
    expect(text(missing)).toContain('https://keys.example.test');
    expect(text(missing)).toContain('Needs a Jev key: until one is added, every flag is investigated.');
    const link = missing.root.find(node => node.type === 'a' && node.props.href === '/d/a/settings#speedups');
    run(() => link.props.onClick({ button: 0, preventDefault: () => {} }));
    expect(navigated).toEqual(['/d/a/settings#speedups']);
    expect(text(unknown)).toContain('key status unknown');
    expect(text(unknown)).toContain('Could not check the Jev key.');
    expect(text(unknown)).toContain('Settings › Speed-ups');
    expect(unknown.root.findAll(node => node.type === 'a')).toHaveLength(0);
    for (const renderer of [set, missing, unknown]) run(() => renderer.unmount());
  });

  it('should move the triage, the threshold and the privacy note together', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig({ triage: 'rules' })} changes={changes} />);

    // Act
    run(() => option(renderer, 'Jev guard').props.onChange());
    const slider = renderer.root.find(node => node.type === 'input' && node.props.type === 'range');
    run(() => slider.props.onChange({ target: { value: '0.9' } }));

    // Assert
    expect(last(changes).triage).toBe('jev');
    expect(last(changes).guard.threshold).toBe(0.9);
    expect(text(renderer)).toContain('0.90');
    expect(text(renderer)).toContain('sent to TypeSafe AI (Jev)');
    run(() => option(renderer, 'LLM only').props.onChange());
    expect(last(changes).triage).toBe('llm');
    expect(renderer.root.findAll(node => node.type === 'input' && node.props.type === 'range')).toHaveLength(0);
    run(() => renderer.unmount());
  });

  it('should pick the investigation login, its model and effort, and reorder the failover list', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(
      <Harness
        initial={wardenConfig({ triage: 'llm', accounts: [{ agent: 'claude-auto-a' }, { agent: 'claude-auto-b' }] })}
        loginOptions={[{ agent: 'claude-auto-a' }, { agent: 'codex-auto-c', model: 'gpt' }]}
        changes={changes}
      />,
    );

    // Act + Assert: a login from the options moves to the head of the failover order.
    run(() => control(renderer, 'Login', 'select').props.onChange({ target: { value: 'codex-auto-c' } }));
    expect(last(changes).accounts).toEqual([
      { agent: 'codex-auto-c', model: 'gpt' },
      { agent: 'claude-auto-a' },
      { agent: 'claude-auto-b' },
    ]);
    const count = changes.length;
    run(() => control(renderer, 'Login', 'select').props.onChange({ target: { value: 'nobody' } }));
    expect(changes).toHaveLength(count);

    run(() => control(renderer, 'Model', 'input').props.onChange({ target: { value: '  ' } }));
    expect(last(changes).accounts[0]).toEqual({ agent: 'codex-auto-c' });
    run(() => control(renderer, 'Model', 'input').props.onChange({ target: { value: 'sonnet' } }));
    expect(last(changes).accounts[0]).toEqual({ agent: 'codex-auto-c', model: 'sonnet' });

    run(() => option(renderer, 'high').props.onChange());
    expect(last(changes).investigation.effort).toBe('high');

    run(() => renderer.root.findByProps({ 'aria-label': 'Move claude-auto-a up' }).props.onClick());
    expect(last(changes).accounts.map(account => account.agent)).toEqual([
      'claude-auto-a',
      'codex-auto-c',
      'claude-auto-b',
    ]);
    run(() => renderer.root.findByProps({ 'aria-label': 'Move claude-auto-a down' }).props.onClick());
    expect(last(changes).accounts[1]?.agent).toBe('claude-auto-a');
    expect(renderer.root.findByProps({ 'aria-label': 'Move codex-auto-c up' }).props.disabled).toBe(true);
    expect(text(renderer)).toContain('Investigations run on your own login (codex-auto-c)');
    run(() => renderer.unmount());
  });

  it('should hold a cleared number as NaN, show its error and say "(fix)" in the summary', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig({ triage: 'jev' })} changes={changes} />);

    // Act
    run(() => control(renderer, 'Investigations at a time', 'input').props.onChange({ target: { value: '' } }));
    run(() => control(renderer, 'Blessing lasts (min)', 'input').props.onChange({ target: { value: '0' } }));
    run(() => control(renderer, 'Jev ($/day)', 'input').props.onChange({ target: { value: '200' } }));
    run(() => control(renderer, 'Investigations ($/day)', 'input').props.onChange({ target: { value: '3' } }));
    run(() => control(renderer, 'Max investigations per hour', 'input').props.onChange({ target: { value: '61' } }));

    // Assert
    const value = last(changes);
    expect(Number.isNaN(value.maxAssignedWardens)).toBe(true);
    expect(value.blessMinutes).toBe(0);
    expect(value.caps).toEqual({ jevUsdPerDay: 200, investigationUsdPerDay: 3, maxInvestigationsPerHour: 61 });
    expect(control(renderer, 'Investigations at a time', 'input').props.value).toBe('');
    expect(control(renderer, 'Investigations at a time', 'input').props['aria-invalid']).toBe(true);
    expect(control(renderer, 'Investigations ($/day)', 'input').props['aria-invalid']).toBeUndefined();
    const json = text(renderer);
    expect(json).toContain('1 to 4.');
    expect(json).toContain('1 to 240 minutes.');
    expect(json).toContain('1 to 60.');
    expect(json).toContain('Enter a cap between $0.01 and $100.');
    expect(json).toContain('(fix)');
    run(() => renderer.unmount());
  });

  it('should show the Jev cap only for Jev triage', () => {
    // Arrange + Act
    const llm = render(<Harness initial={wardenConfig({ triage: 'llm' })} changes={[]} />);

    // Assert
    expect(text(llm)).toContain('Investigations ($/day)');
    expect(text(llm)).not.toContain('Jev ($/day)');
    run(() => llm.unmount());
  });

  it('should change the sweep interval, the event triggers and what may act alone', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig({ triage: 'llm' })} changes={changes} />);

    // Act
    run(() => option(renderer, '10 min').props.onChange());
    run(() => option(renderer, 'Pane died').props.onChange({ target: { checked: false } }));
    run(() => option(renderer, 'Stop a ferret').props.onChange({ target: { checked: true } }));

    // Assert
    const value = last(changes);
    expect(value.intervalMinutes).toBe(10);
    expect(value.events).toEqual({ turnEnd: true, question: true, paneDied: false });
    expect(value.mayActAlone.stop).toBe(true);
    expect(text(renderer)).not.toContain('stopping always asks you first');
    expect(text(renderer)).toContain('Every 10 min the sweep flags anomalies');
    run(() => renderer.unmount());
  });
});

describe('wardenPrivacyNote', () => {
  it('should name what leaves the machine for each triage', () => {
    // Arrange + Act + Assert
    expect(wardenPrivacyNote('rules', 'x')).toBe(
      'What leaves this machine: nothing. Rules only sends nothing anywhere.',
    );
    expect(wardenPrivacyNote('llm', 'claude-auto-a')).toBe(
      'What leaves this machine: Investigations run on your own login (claude-auto-a) and read the transcript, pane, diffs and CI.',
    );
    expect(wardenPrivacyNote('jev', 'claude-auto-a')).toContain('with every stored secret masked');
  });
});

describe('WardenSettingsForm, when the owner chose no login', () => {
  const unset = wardenConfig({ triage: 'llm', accounts: [] });
  const options = (renderer: ReactTestRenderer): string[] =>
    control(renderer, 'Login', 'select')
      .findAllByType('option')
      .map(node => String(node.children.join('')));

  it('should run on the machine default, and let a model be pinned on it', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(
      <Harness
        initial={unset}
        machineDefault="claude-default"
        login={{ source: 'machine_default', unknown: [], available: ['claude-default'] }}
        loginOptions={[{ agent: 'claude-default' }]}
        changes={changes}
      />,
    );

    // Assert
    expect(options(renderer)[0]).toBe('Machine default — claude-default');
    expect(text(renderer)).toContain('None chosen: investigations run on this machine’s default runtime');
    expect(text(renderer)).toContain('Investigations run on your own login (claude-default)');

    // Act: a model pinned on the stand-in makes it the owner's choice.
    run(() => control(renderer, 'Model', 'input').props.onChange({ target: { value: 'haiku' } }));

    // Assert
    expect(last(changes).accounts).toEqual([{ agent: 'claude-default', model: 'haiku' }]);
    run(() => renderer.unmount());
  });

  it('should say not set, keep the model closed and say LLM triage is unavailable', () => {
    // Arrange
    const renderer = render(
      <Harness initial={unset} login={{ source: 'not_set', unknown: [], available: [] }} changes={[]} />,
    );

    // Act / Assert
    expect(options(renderer)).toEqual(['Not set — choose a login']);
    expect(control(renderer, 'Model', 'input').props.disabled).toBe(true);
    expect(text(renderer)).toContain('LLM triage is unavailable');
    run(() => control(renderer, 'Model', 'input').props.onChange({ target: { value: 'x' } }));
    run(() => renderer.unmount());
  });

  it('should fall back to plain words for a daemon that predates the login facts', () => {
    // Arrange
    const renderer = render(<Harness initial={unset} changes={[]} />);

    // Act / Assert
    expect(options(renderer)).toEqual(['The machine’s default runtime']);
    run(() => renderer.unmount());
  });

  it('should hand the choice back to the machine default from the empty option', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(
      <Harness initial={wardenConfig({ triage: 'llm', accounts: [{ agent: 'claude-spare' }] })} changes={changes} />,
    );

    // Act
    run(() => control(renderer, 'Login', 'select').props.onChange({ target: { value: '' } }));

    // Assert
    expect(last(changes).accounts).toEqual([]);
    run(() => renderer.unmount());
  });

  it('should name every unknown login — the chosen ones, or the machine default — and keep it in place', () => {
    // Arrange
    const chosen = render(
      <Harness
        initial={wardenConfig({ triage: 'llm', accounts: [{ agent: 'legacy-wrapper' }, { agent: 'claude-default' }] })}
        login={{ source: 'configured', unknown: ['legacy-wrapper'], available: ['claude-default'] }}
        changes={[]}
      />,
    );
    const standIn = render(
      <Harness
        initial={unset}
        machineDefault="gone-runtime"
        login={{ source: 'machine_default', unknown: ['gone-runtime'], available: ['claude-default'] }}
        changes={[]}
      />,
    );

    // Act / Assert
    expect(chosen.root.findAll(node => node.props['data-warden-unknown-login'] === '')).toHaveLength(1);
    expect(text(chosen)).toContain('legacy-wrapper');
    expect(control(chosen, 'Login', 'select').props.value).toBe('legacy-wrapper');
    expect(standIn.root.findAll(node => node.props['data-warden-unknown-login'] === '')).toHaveLength(1);
    expect(text(standIn)).toContain('gone-runtime');
    for (const renderer of [chosen, standIn]) run(() => renderer.unmount());
  });
});
