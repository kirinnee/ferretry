import { describe, expect, it } from 'bun:test';
import type { WardenAccount, WardenConfig, WardenLogin } from '@ferretry/protocol';
import { useState } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { WardenSettingsForm, wardenPrivacyNote } from '../../../src/features/warden/warden-settings-form.tsx';
import {
  type JevKeyStatus,
  wardenConfigPatchFrom,
  wardenFormErrors,
} from '../../../src/features/warden/warden-settings-model.ts';
import type { PickerAccount } from '../../../src/lib/account-picker-catalog.ts';
import { render, run } from '../../support/react.ts';
import { wardenConfig } from '../../support/warden.ts';

interface HarnessProps {
  readonly initial: WardenConfig;
  readonly jevKey?: JevKeyStatus;
  readonly loginOptions?: readonly WardenAccount[];
  readonly runtimes?: readonly PickerAccount[];
  readonly login?: WardenLogin;
  readonly machineDefault?: string;
  readonly speedupsHref?: string;
  readonly browserHref?: string;
  readonly onNavigate?: (to: string) => void;
  readonly changes: WardenConfig[];
}

/** The form is controlled: this holds the value the way Settings and onboarding do. */
function Harness({
  initial,
  jevKey = { state: 'set' },
  loginOptions,
  runtimes,
  login,
  machineDefault,
  speedupsHref,
  browserHref,
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
      {...(runtimes === undefined ? {} : { runtimes })}
      {...(login === undefined ? {} : { login })}
      {...(machineDefault === undefined ? {} : { machineDefault })}
      {...(speedupsHref === undefined ? {} : { speedupsHref })}
      {...(browserHref === undefined ? {} : { browserHref })}
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

const BOTH = { layers: { jev: true, llm: true } } as const;
const LLM = { layers: { jev: false, llm: true } } as const;

describe('WardenSettingsForm', () => {
  it('should show the rules always on, hide every layer’s settings and say nothing leaves the machine', () => {
    // Arrange
    const changes: WardenConfig[] = [];

    // Act
    const renderer = render(<Harness initial={wardenConfig()} changes={changes} />);

    // Assert
    const json = text(renderer);
    expect(json).toContain('What leaves this machine: nothing. The rules send nothing anywhere.');
    expect(json).toContain('always on · free');
    expect(json).not.toContain('Investigation (the assigned warden)');
    expect(json).not.toContain('Jev cap ($/day)');
    expect(json).not.toContain('LLM cap ($/day)');
    expect(json).not.toContain('stays quiet for (min)');
    expect(json).not.toContain('May act alone on a verdict');
    expect(json).toContain('No AI runs and nothing is spent.');
    expect(renderer.root.findByProps({ 'aria-label': 'Jev on' }).props['aria-checked']).toBe(false);
    expect(renderer.root.findByProps({ 'aria-label': 'LLM investigation on' }).props['aria-checked']).toBe(false);
    run(() => renderer.unmount());
  });

  it('should turn the Warden off and disable every setting under the switch', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig()} changes={changes} />);
    const toggle = () => renderer.root.findByProps({ 'aria-label': 'Warden on' });

    // Act
    run(() => toggle().props.onClick());

    // Assert
    expect(last(changes).enabled).toBe(false);
    expect(toggle().props['aria-checked']).toBe(false);
    expect(renderer.root.find(node => node.type === 'fieldset' && node.props.disabled === true)).toBeDefined();
    expect(text(renderer)).toContain('The Warden is off.');
    run(() => toggle().props.onClick());
    expect(last(changes).enabled).toBe(true);
    run(() => renderer.unmount());
  });

  it('should link the browser row to Settings › machine › Browser, and only when given the address', () => {
    // Arrange
    const navigated: string[] = [];
    const href = '/d/a/settings#machines/studio/browser';

    // Act
    const linked = render(
      <Harness initial={wardenConfig(BOTH)} changes={[]} browserHref={href} onNavigate={to => navigated.push(to)} />,
    );
    const bare = render(<Harness initial={wardenConfig(BOTH)} changes={[]} />);

    // Assert
    expect(text(linked)).toContain('Close leftover browsers');
    expect(text(linked)).toContain('Settings › machine › Browser');
    const link = linked.root.find(node => node.type === 'a' && node.props.href === href);
    run(() => link.props.onClick({ button: 0, preventDefault: () => {} }));
    expect(navigated).toEqual([href]);
    expect(text(bare)).not.toContain('Settings › machine › Browser');
    for (const renderer of [linked, bare]) run(() => renderer.unmount());
  });

  it('should show the key pill for each key state and the no-key box with its links', () => {
    // Arrange
    const navigated: string[] = [];
    const jev = wardenConfig(BOTH);

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
    const alone = render(
      <Harness
        initial={wardenConfig({ layers: { jev: true, llm: false } })}
        changes={[]}
        jevKey={{ state: 'missing' }}
      />,
    );

    // Assert
    expect(text(set)).toContain('key set');
    expect(text(set)).not.toContain('No Jev key yet.');
    expect(text(set)).not.toContain('Needs a Jev key');
    expect(text(missing)).toContain('needs Jev key');
    expect(text(missing)).toContain('No Jev key yet.');
    expect(text(missing)).toContain('goes to an investigation');
    expect(text(missing)).toContain('https://keys.example.test');
    expect(text(missing)).toContain('Needs a Jev key: until one is added, every flag is investigated.');
    const link = missing.root.find(node => node.type === 'a' && node.props.href === '/d/a/settings#speedups');
    run(() => link.props.onClick({ button: 0, preventDefault: () => {} }));
    expect(navigated).toEqual(['/d/a/settings#speedups']);
    expect(text(unknown)).toContain('key status unknown');
    expect(text(unknown)).toContain('Could not check the Jev key.');
    expect(text(unknown)).toContain('Settings › Speed-ups');
    expect(unknown.root.findAll(node => node.type === 'a')).toHaveLength(0);
    expect(text(alone)).toContain('is shown to you');
    for (const renderer of [set, missing, unknown, alone]) run(() => renderer.unmount());
  });

  it('should switch each layer on and off alone, with its own settings and the privacy note', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig()} changes={changes} />);
    const toggle = (label: string) => renderer.root.findByProps({ 'aria-label': label });

    // Act
    run(() => toggle('Jev on').props.onClick());
    const slider = control(renderer, 'Leaves a flag alone only when at least this sure it is healthy', 'input');
    run(() => slider.props.onChange({ target: { value: '0.9' } }));

    // Assert
    expect(last(changes).layers).toEqual({ jev: true, llm: false });
    expect(slider.props.min).toBe(0.3);
    expect(slider.props.step).toBe(0.05);
    expect(last(changes).guard.threshold).toBe(0.9);
    expect(text(renderer)).toContain('90%');
    expect(text(renderer)).toContain('sent to TypeSafe AI (Jev)');
    expect(text(renderer)).toContain('Jev cap ($/day)');
    expect(text(renderer)).toContain('stays quiet for (min)');
    expect(text(renderer)).not.toContain('Investigations run on your own login');
    run(() => toggle('LLM investigation on').props.onClick());
    expect(last(changes).layers).toEqual({ jev: true, llm: true });
    expect(text(renderer)).toContain('LLM cap ($/day)');
    expect(text(renderer)).toContain('each flag Jev did not clear');
    run(() => toggle('Jev on').props.onClick());
    expect(last(changes).layers).toEqual({ jev: false, llm: true });
    expect(renderer.root.findAll(node => node.type === 'input' && node.props.type === 'range')).toHaveLength(0);
    expect(text(renderer)).toContain('looks at every flag');
    run(() => renderer.unmount());
  });

  it('should let the logins take turns or fall back in order', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig(LLM)} changes={changes} />);

    // Act
    run(() => option(renderer, 'Take turns').props.onChange());

    // Assert
    expect(last(changes).failover.policy).toBe('round_robin');
    run(() => option(renderer, 'First, then the next if it fails').props.onChange());
    expect(last(changes).failover.policy).toBe('fallback');
    run(() => renderer.unmount());
  });

  it('should pick the investigation login, its model and effort, and reorder the failover list', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(
      <Harness
        initial={wardenConfig({ ...LLM, accounts: [{ agent: 'claude-auto-a' }, { agent: 'claude-auto-b' }] })}
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

  it('should offer each login as its name, then its harness and the label the Runtimes tab shows', () => {
    // Arrange
    const runtime = (wrapper: string, displayName: string, kind: PickerAccount['kind']): PickerAccount => ({
      id: '0b6f6b5e-5d7c-4f4e-9d0a-1d1f2a3b4c5d',
      wrapper,
      displayName,
      kind,
      agent: true,
      credentialId: wrapper,
      defaultModel: null,
      models: [],
      available: true,
      unavailableReason: null,
    });
    const renderer = render(
      <Harness
        initial={wardenConfig({ ...LLM, accounts: [] })}
        loginOptions={[{ agent: 'claude-default' }, { agent: 'codex-review' }, { agent: 'claude-bare' }]}
        runtimes={[
          runtime('claude-default', 'Personal Claude', 'claude'),
          runtime('codex-review', 'codex-review', 'codex'),
        ]}
        changes={[]}
      />,
    );

    // Act
    const picker = control(renderer, 'Login', 'select');
    const options = picker.findAllByType('option').map(node => [node.props.value, flat(node)]);

    // Assert: the stored value is the name; the words beside it are for the person choosing.
    expect(options.slice(1)).toEqual([
      ['claude-default', 'claude-default · claude · Personal Claude'],
      ['codex-review', 'codex-review · codex'],
      ['claude-bare', 'claude-bare'],
    ]);
    run(() => renderer.unmount());
  });

  it('should hold a cleared number as NaN, show its error and say "(fix)" in the summary', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig(BOTH)} changes={changes} />);

    // Act
    run(() => control(renderer, 'Investigations at a time', 'input').props.onChange({ target: { value: '' } }));
    run(() =>
      control(renderer, 'A cleared flag stays quiet for (min)', 'input').props.onChange({ target: { value: '0' } }),
    );
    run(() => control(renderer, 'Jev cap ($/day)', 'input').props.onChange({ target: { value: '200' } }));
    run(() => control(renderer, 'LLM cap ($/day)', 'input').props.onChange({ target: { value: '3' } }));
    run(() => control(renderer, 'Max investigations per hour', 'input').props.onChange({ target: { value: '61' } }));

    // Assert
    const value = last(changes);
    expect(Number.isNaN(value.maxAssignedWardens)).toBe(true);
    expect(value.blessMinutes).toBe(0);
    expect(value.caps).toEqual({ jevUsdPerDay: 200, investigationUsdPerDay: 3, maxInvestigationsPerHour: 61 });
    expect(control(renderer, 'Investigations at a time', 'input').props.value).toBe('');
    expect(control(renderer, 'Investigations at a time', 'input').props['aria-invalid']).toBe(true);
    expect(control(renderer, 'LLM cap ($/day)', 'input').props['aria-invalid']).toBeUndefined();
    const json = text(renderer);
    expect(json).toContain('1 to 4.');
    expect(json).toContain('1 to 240 minutes.');
    expect(json).toContain('1 to 60.');
    expect(json).toContain('Enter a cap between $0.01 and $100.');
    expect(json).toContain('(fix)');
    run(() => renderer.unmount());
  });

  it('should show each cap only while its own layer is on', () => {
    // Arrange + Act
    const llm = render(<Harness initial={wardenConfig(LLM)} changes={[]} />);

    // Assert
    expect(text(llm)).toContain('LLM cap ($/day)');
    expect(text(llm)).not.toContain('Jev cap ($/day)');
    run(() => llm.unmount());
  });

  it('should change the sweep interval, the event triggers and what may act alone', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig(LLM)} changes={changes} />);

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
    expect(text(renderer)).toContain('Every 10 min the rules flag anomalies');
    run(() => renderer.unmount());
  });
});

/** The slider row for one act of Jev's, and its pieces. */
const jevRow = (renderer: ReactTestRenderer, act: string) => {
  const row = renderer.root.findByProps({ 'data-warden-jev-act': act });
  return {
    slider: row.find(node => node.type === 'input' && node.props.type === 'range'),
    shown: row.find(node => node.type === 'output'),
    text: flat(row),
  };
};

describe('What Jev may do alone', () => {
  it('should show one slider per act, from 30% to 100%, only while the Jev layer is on', () => {
    // Arrange
    const on = render(<Harness initial={wardenConfig(BOTH)} changes={[]} />);
    const off = render(<Harness initial={wardenConfig(LLM)} changes={[]} />);

    // Act
    const rows = ['nudge', 'resume', 'restart', 'stop'].map(act => jevRow(on, act));

    // Assert
    expect(text(on)).toContain('What Jev may do alone');
    expect(text(on)).toContain('Otherwise the flag goes to an investigation, or to you.');
    expect(rows.map(row => flat(row.shown))).toEqual(['70%', '70%', '70%', '80%']);
    for (const { slider } of rows) {
      expect(slider.props.min).toBe(0.3);
      expect(slider.props.max).toBe(1);
      expect(slider.props.step).toBe(0.05);
    }
    expect(rows[0]?.slider.props['aria-valuetext']).toBe('70% sure');
    expect(text(off)).not.toContain('What Jev may do alone');
    expect(off.root.findAll(node => node.props?.['data-warden-jev-act'] !== undefined)).toHaveLength(0);
    run(() => on.unmount());
    run(() => off.unmount());
  });

  it('should say Never at 100% and send only the act that changed', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig(BOTH)} changes={changes} />);

    // Act
    run(() => jevRow(renderer, 'stop').slider.props.onChange({ target: { value: '1' } }));

    // Assert
    const stop = jevRow(renderer, 'stop');
    expect(last(changes).jevActs).toEqual({ nudge: 0.7, resume: 0.7, restart: 0.7, stop: 1 });
    expect(wardenConfigPatchFrom(wardenConfig(BOTH), last(changes))).toEqual({ jevActs: { stop: 1 } });
    expect(flat(stop.shown)).toBe('Never');
    expect(stop.slider.props['aria-valuetext']).toBe('Never alone');
    expect(flat(jevRow(renderer, 'nudge').shown)).toBe('70%');
    run(() => renderer.unmount());
  });

  it('should disable an act whose may-act-alone switch is off, and say so', () => {
    // Arrange
    const base = wardenConfig(BOTH);
    const renderer = render(
      <Harness initial={{ ...base, mayActAlone: { ...base.mayActAlone, restart: false, stop: false } }} changes={[]} />,
    );

    // Act
    const restart = jevRow(renderer, 'restart');
    const nudge = jevRow(renderer, 'nudge');

    // Assert
    expect(restart.slider.props.disabled).toBe(true);
    expect(restart.text).toContain('Off — the Warden may not restart alone');
    expect(jevRow(renderer, 'stop').text).toContain('Off — the Warden may not stop a ferret alone');
    expect(nudge.slider.props.disabled).toBe(false);
    expect(nudge.text).not.toContain('Off — the Warden may not');
    run(() => renderer.unmount());
  });

  it('should keep the may-act-alone switches within reach while only Jev is on, and re-enable the row from them', () => {
    // Arrange
    const base = wardenConfig({ layers: { jev: true, llm: false } });
    const renderer = render(
      <Harness initial={{ ...base, mayActAlone: { ...base.mayActAlone, nudge: false } }} changes={[]} />,
    );
    expect(jevRow(renderer, 'nudge').slider.props.disabled).toBe(true);

    // Act
    run(() => option(renderer, 'Sends a short').props.onChange({ target: { checked: true } }));

    // Assert
    expect(text(renderer)).toContain('May act alone');
    expect(jevRow(renderer, 'nudge').slider.props.disabled).toBe(false);
    run(() => renderer.unmount());
  });

  it('should name the bar for leaving a flag alone as its own row', () => {
    // Arrange / Act
    const renderer = render(<Harness initial={wardenConfig(BOTH)} changes={[]} />);

    // Assert
    expect(text(renderer)).toContain('Leaves a flag alone only when at least this sure it is healthy');
    expect(text(renderer)).not.toContain('It never acts on a ferret');
    run(() => renderer.unmount());
  });
});

describe('wardenPrivacyNote', () => {
  it('should name what leaves the machine for each mix of layers', () => {
    // Arrange + Act + Assert
    expect(wardenPrivacyNote({ jev: false, llm: false }, 'x')).toBe(
      'What leaves this machine: nothing. The rules send nothing anywhere.',
    );
    expect(wardenPrivacyNote({ jev: false, llm: true }, 'claude-auto-a')).toBe(
      'What leaves this machine: Investigations run on your own login (claude-auto-a) and read the transcript, pane, diffs and CI.',
    );
    expect(wardenPrivacyNote({ jev: true, llm: false }, 'claude-auto-a')).toContain('with every stored secret masked');
    expect(wardenPrivacyNote({ jev: true, llm: false }, 'claude-auto-a')).not.toContain('Investigations');
    expect(wardenPrivacyNote({ jev: true, llm: true }, 'claude-auto-a')).toContain('Investigations run');
  });
});

describe('WardenSettingsForm, when the owner chose no login', () => {
  const unset = wardenConfig({ ...LLM, accounts: [] });
  const options = (renderer: ReactTestRenderer): string[] =>
    control(renderer, 'Login', 'select')
      .findAllByType('option')
      .map(node => String(node.children.join('')));

  it("should list the chosen login's catalog for its model, and offer only the efforts that model takes", () => {
    // Arrange — a GLM login (docs/model-catalog.md): GLM-5.3 takes low and high of the Warden's levels
    const glm: PickerAccount = {
      id: 'rt-glm',
      wrapper: 'claude-glm',
      displayName: 'claude-glm',
      kind: 'claude',
      agent: true,
      credentialId: 'glm',
      defaultModel: 'glm-5.3',
      models: [
        { id: 'glm-5.3', label: 'GLM-5.3', tier: 'best', available: true, efforts: ['low', 'high', 'max'] },
        { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', tier: 'fast', available: true, efforts: [] },
      ],
      modelCatalog: { id: 'zai', label: 'GLM / Z.ai', customIds: false },
      available: true,
      unavailableReason: null,
    };
    const changes: WardenConfig[] = [];
    const renderer = render(
      <Harness
        initial={wardenConfig({ ...LLM, accounts: [{ agent: 'claude-glm' }] })}
        runtimes={[glm]}
        changes={changes}
      />,
    );

    // Assert — the model is a select of the catalog, and medium is not offered
    const select = renderer.root.find(node => node.type === 'select' && String(node.props.id).endsWith('-model'));
    expect(() => option(renderer, 'medium')).toThrow();
    run(() => select.props.onChange({ target: { value: 'glm-5.3-flash' } }));
    expect(last(changes).accounts[0]).toEqual({ agent: 'claude-glm', model: 'glm-5.3-flash' });
    expect(text(renderer)).toContain('takes no reasoning effort, so the investigation');
    run(() => renderer.unmount());
  });

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

  it('should say not set, keep the model closed and say LLM investigations are unavailable', () => {
    // Arrange
    const renderer = render(
      <Harness initial={unset} login={{ source: 'not_set', unknown: [], available: [] }} changes={[]} />,
    );

    // Act / Assert
    expect(options(renderer)).toEqual(['Not set — choose a login']);
    expect(control(renderer, 'Model', 'input').props.disabled).toBe(true);
    expect(text(renderer)).toContain('LLM investigations are unavailable');
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
      <Harness initial={wardenConfig({ ...LLM, accounts: [{ agent: 'claude-spare' }] })} changes={changes} />,
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
        initial={wardenConfig({ ...LLM, accounts: [{ agent: 'legacy-wrapper' }, { agent: 'claude-default' }] })}
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

describe('WardenSettingsForm: moving a ferret that hit a limit', () => {
  const picker = (wrapper: string): PickerAccount => ({
    id: `${wrapper}-id`,
    wrapper,
    displayName: wrapper,
    kind: 'claude',
    agent: true,
    credentialId: wrapper,
    defaultModel: null,
    models: [],
    available: true,
    unavailableReason: null,
  });
  const moving = (changes: Partial<WardenConfig['autoMigrate']> = {}) =>
    wardenConfig({ autoMigrate: { ...wardenConfig().autoMigrate, enabled: true, ...changes } });

  it('should offer it off, even with no AI layer on, and turn it on with the switch', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={wardenConfig()} changes={changes} />);
    const toggle = () => renderer.root.findByProps({ 'aria-label': 'Move the ferret to another login on' });

    // Act
    const before = toggle().props['aria-checked'];
    run(() => toggle().props.onClick());

    // Assert
    expect(before).toBe(false);
    expect(last(changes).autoMigrate.enabled).toBe(true);
    expect(text(renderer)).toContain('Stop its background jobs if they are in the way');
    expect(text(renderer)).toContain('same chat, same card');
    run(() => renderer.unmount());
  });

  it('should drop a trigger, and warn when none is left', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={moving({ when: ['rate_limited'] })} changes={changes} />);

    // Act
    run(() => option(renderer, 'It hits a usage limit').props.onChange({ target: { checked: false } }));

    // Assert
    expect(last(changes).autoMigrate.when).toEqual([]);
    expect(text(renderer)).toContain('Pick at least one, or it never moves anything.');
    run(() => renderer.unmount());
  });

  it('should name logins in the order they are ticked, and go back to any ready login', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(
      <Harness initial={moving()} runtimes={[picker('claude-b'), picker('glm-a')]} changes={changes} />,
    );

    // Act
    run(() => option(renderer, 'Only these, in order').props.onChange());
    run(() => option(renderer, 'glm-a').props.onChange({ target: { checked: true } }));
    const named = last(changes).autoMigrate.targets;
    run(() => option(renderer, 'Any ready login, same provider').props.onChange());

    // Assert
    expect(named).toEqual(['claude-b', 'glm-a']);
    expect(last(changes).autoMigrate.targets).toEqual([]);
    run(() => renderer.unmount());
  });

  it('should offer the least quota a target must have left, and keep what is typed', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={moving()} changes={changes} />);
    const field = () => renderer.root.findByProps({ type: 'number', value: 20 });

    // Act
    run(() => field().props.onChange({ target: { value: '35' } }));

    // Assert
    expect(text(renderer)).toContain('Least quota left on the login it moves to (%)');
    expect(last(changes).autoMigrate.minHeadroomPercent).toBe(35);
    run(() => renderer.unmount());
  });

  it('should hide the wait once the Warden may stop the jobs itself, and say what it stops', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={moving()} changes={changes} />);
    expect(text(renderer)).toContain('Wait for the ferret to stop them (min)');

    // Act
    run(() =>
      option(renderer, 'Stop its background jobs if they are in the way').props.onChange({ target: { checked: true } }),
    );

    // Assert
    expect(last(changes).autoMigrate.forceStopBackground).toBe(true);
    expect(text(renderer)).not.toContain('Wait for the ferret to stop them (min)');
    expect(text(renderer)).toContain('never anything else');
    run(() => renderer.unmount());
  });
});

describe('WardenSettingsForm: moving, the remaining choices', () => {
  const moving = (changes: Partial<WardenConfig['autoMigrate']> = {}) =>
    wardenConfig({ autoMigrate: { ...wardenConfig().autoMigrate, enabled: true, ...changes } });

  it('should tick a trigger back on, last in the list', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={moving({ when: ['budget_exceeded'] })} changes={changes} />);

    // Act
    run(() => option(renderer, 'It hits a usage limit').props.onChange({ target: { checked: true } }));

    // Assert
    expect(last(changes).autoMigrate.when).toEqual(['budget_exceeded', 'rate_limited']);
    run(() => renderer.unmount());
  });

  it('should keep a named list when its own choice is picked again', () => {
    // Arrange
    const changes: WardenConfig[] = [];
    const renderer = render(<Harness initial={moving({ targets: ['glm-a'] })} changes={changes} />);

    // Act
    run(() => option(renderer, 'Only these, in order').props.onChange());

    // Assert
    expect(last(changes).autoMigrate.targets).toEqual(['glm-a']);
    expect(text(renderer)).toContain('Tried in this order: ');
    run(() => renderer.unmount());
  });
});
