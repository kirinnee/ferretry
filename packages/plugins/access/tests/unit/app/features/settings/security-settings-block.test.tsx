/**
 * The security settings block: every setting with its value and bounds, a Save bar that stays off until a number has changed and
 * allowed number, a loosening that is never offered to a caller who may not make it, and one sentence
 * for every failure.
 */

import { describe, expect, it } from 'bun:test';
import {
  SECURITY_WIDEN_REFUSED_CODE,
  type SecuritySettings,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/core-gate/contract';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import { SecuritySettingsBlock } from '../../../../../app/features/settings/security-settings-block.tsx';
import { daemonConnection, FyHttpError } from '../../../../../app/shell-grants.ts';
import { SECURITY_SETTING_COPY, type SecuritySettingsClient } from '../../../../../app/lib/security-settings-client.ts';
import { must } from '../../../../support/app/dom.ts';
import { render, run, runAsync } from '../../../../support/app/react.ts';

const connection = daemonConnection({
  daemonId: 'daemon-alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});

const COMMAND = 'fy daemon security set';
const SETTINGS: SecuritySettings = {
  stepUpWindowMinutes: 15,
  deviceKeyRotationDays: 30,
  unlockOnOpen: true,
  unlockValidityHours: 8,
  stepUpOnActions: false,
  idleExpiryDays: 30,
};
const view = (
  over: Partial<SecuritySettingsView> = {},
  settings: Partial<SecuritySettings> = {},
): SecuritySettingsView => ({
  settings: { ...SETTINGS, ...settings },
  source: 'document',
  mayWiden: false,
  widenCommand: COMMAND,
  ...over,
});

interface Ledger {
  readonly patches: SecuritySettingsPatch[];
}

/** A machine that answers `first` to the read and `change` (or a refusal) to each PATCH. */
const machine = (
  first: SecuritySettingsView | Error,
  change: (patch: SecuritySettingsPatch) => { view: SecuritySettingsView; devicesExpiring: number } | Error,
  ledger: Ledger = { patches: [] },
): (() => Promise<SecuritySettingsClient>) => {
  const client = {
    request: async (_path: string, _schema: unknown, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as SecuritySettingsPatch;
        ledger.patches.push(patch);
        const answer = change(patch);
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (first instanceof Error) throw first;
      return first;
    },
  } as unknown as SecuritySettingsClient;
  return async () => client;
};

const mountBlock = async (create: () => Promise<SecuritySettingsClient>): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer | undefined;
  await runAsync(async () => {
    renderer = render(<SecuritySettingsBlock connection={connection} createClient={create} />);
  });
  return must(renderer, 'the rendered block');
};

const marked = (block: ReactTestRenderer, marker: string, value?: string) =>
  block.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props[marker] !== undefined &&
      (value === undefined || node.props[marker] === value),
  );

const text = (block: ReactTestRenderer): string => JSON.stringify(block.toJSON()).replace(/\\"/g, '"');

const typeInto = async (block: ReactTestRenderer, field: string, value: string): Promise<void> => {
  const input = must(marked(block, 'data-security-input', field)[0], `${field} input`);
  await runAsync(async () => {
    input.props.onChange({ currentTarget: { value } });
  });
};

/** The real switch button inside the span that carries a `data-security-switch` mark. */
const switchIn = (mark: ReactTestInstance | undefined) =>
  mark?.find(node => typeof node.type === 'string' && node.props.role === 'switch');

/** The radio for one common choice ("unlockValidityHours:168"): the real Segmented's input, found by its group's name. */
const choiceFor = (block: ReactTestRenderer, id: string) => {
  const [field, value] = id.split(':') as [keyof typeof SECURITY_SETTING_COPY, string];
  const group = block.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.role === 'radiogroup' &&
      node.props['aria-label'] === `${SECURITY_SETTING_COPY[field].label}: common choices`,
  )[0];
  return group?.findAll(node => node.type === 'input' && node.props.value === value)[0];
};

const press = async (block: ReactTestRenderer, marker: string, value: string): Promise<void> => {
  if (marker === 'data-security-preset') {
    const radio = must(choiceFor(block, value), `choice ${value}`);
    await runAsync(async () => {
      radio.props.onChange();
    });
    return;
  }
  const mark = must(marked(block, marker, value)[0], `${marker}=${value}`);
  const button = marker === 'data-security-switch' ? must(switchIn(mark), `switch ${value}`) : mark;
  await runAsync(async () => {
    button.props.onClick();
  });
};

const saveButton = (block: ReactTestRenderer, _field: string) => marked(block, 'data-security-save', 'form')[0];

describe('SecuritySettingsBlock reading', () => {
  it('shows each setting with its value and its bounds, in plain units', async () => {
    // Arrange / Act
    const block = await mountBlock(machine(view({}, { stepUpOnActions: true }), () => new Error('unused')));

    // Assert
    expect(text(block)).toContain('15 minutes');
    expect(text(block)).toContain('Allowed: 0 to 60 minutes.');
    expect(text(block)).toContain('Allowed: 7 to 90 days.');
    expect(text(block)).toContain('Allowed: 1 hour to 7 days.');
    expect(text(block)).toContain('30 days');
    expect(text(block)).toContain('A change confirmation lasts');
    should(marked(block, 'data-security-value', 'unlockOnOpen')[0]?.children).eql(['On']);
    should(marked(block, 'data-security-value', 'stepUpOnActions')[0]?.children).eql(['On']);
    should(marked(block, 'data-security-damaged')).be.empty();
    run(() => block.unmount());
  });

  it('says both switches in the owner’s words, and hides the change window while it asks for nothing', async () => {
    // Arrange / Act
    const block = await mountBlock(machine(view(), () => new Error('unused')));

    // Assert
    expect(text(block)).toContain('Unlock with a passkey on opening');
    expect(text(block)).toContain('A device must unlock this machine with its passkey before it can do anything.');
    expect(text(block)).toContain('An unlock lasts');
    expect(text(block)).toContain('Ask again for each change');
    expect(text(block)).toContain(
      'Ask for a passkey again before changes, terminals and other sensitive acts, even while unlocked.',
    );
    should(marked(block, 'data-security-value', 'stepUpOnActions')[0]?.children).eql(['Off']);
    should(marked(block, 'data-security-setting', 'stepUpWindowMinutes')).be.empty();
    expect(text(block)).not.toContain('A change confirmation lasts');
    run(() => block.unmount());
  });

  it('says a machine that could not read its settings is using its strictest reading', async () => {
    // Arrange / Act
    const block = await mountBlock(machine(view({ source: 'damaged' }), () => new Error('unused')));

    // Assert
    should(marked(block, 'data-security-damaged')).have.length(1);
    expect(text(block)).toContain('strictest reading');
    run(() => block.unmount());
  });

  it('says the settings could not be read, never invented ones', async () => {
    // Arrange / Act
    const block = await mountBlock(machine(new Error('offline'), () => new Error('unused')));

    // Assert
    should(marked(block, 'data-security-settings-state')[0]?.props['data-security-settings-state']).equal('failed');
    expect(text(block)).toContain('did not answer its security settings');
    should(marked(block, 'data-security-input')).be.empty();
    run(() => block.unmount());
  });

  it('shows a reading state, and ignores an answer after unmount', async () => {
    // Arrange
    let release: (client: SecuritySettingsClient) => void = () => undefined;
    const block = await mountBlock(() => new Promise(resolve => (release = resolve)));
    should(marked(block, 'data-security-settings-state')[0]?.props['data-security-settings-state']).equal('loading');

    // Act
    run(() => block.unmount());
    await runAsync(async () => release(await machine(view(), () => new Error('unused'))()));

    // Assert
    should(block.toJSON()).be.null();
  });

  it('ignores a failed read that lands after unmount', async () => {
    // Arrange
    let fail: (reason: Error) => void = () => undefined;
    const block = await mountBlock(() => new Promise((_resolve, reject) => (fail = reject)));

    // Act
    run(() => block.unmount());
    await runAsync(async () => fail(new Error('late')));

    // Assert
    should(block.toJSON()).be.null();
  });
});

describe('SecuritySettingsBlock narrowing', () => {
  it('sends only the changed field, then shows the new value and what it unpaired', async () => {
    // Arrange
    const ledger: Ledger = { patches: [] };
    const block = await mountBlock(machine(view(), patch => ({ view: view({}, patch), devicesExpiring: 2 }), ledger));

    // Act
    await typeInto(block, 'idleExpiryDays', '10');
    should(saveButton(block, 'idleExpiryDays')?.props.disabled).equal(false);
    await press(block, 'data-security-save', 'form');

    // Assert
    should(ledger.patches).eql([{ idleExpiryDays: 10 }]);
    expect(text(block)).toContain('10 days');
    expect(text(block)).toContain('This will unpair 2 devices that have not been used within the new period.');
    should(saveButton(block, 'idleExpiryDays')?.props.disabled).equal(true);
    should(marked(block, 'data-security-failure-settings')).be.empty();
    run(() => block.unmount());
  });

  it('keeps Save off for an unchanged number', async () => {
    // Arrange
    const block = await mountBlock(machine(view(), () => new Error('unused')));

    // Act
    await typeInto(block, 'idleExpiryDays', '30');

    // Assert
    should(saveButton(block, 'idleExpiryDays')?.props.disabled).equal(true);
    run(() => block.unmount());
  });

  it('turns the unlock on, which tightens, from a caller who may not loosen', async () => {
    // Arrange
    const ledger: Ledger = { patches: [] };
    const block = await mountBlock(
      machine(view({}, { unlockOnOpen: false }), patch => ({ view: view({}, patch), devicesExpiring: 0 }), ledger),
    );
    should(switchIn(marked(block, 'data-security-switch', 'unlockOnOpen')[0])?.props.disabled).equal(false);

    // Act
    await press(block, 'data-security-switch', 'unlockOnOpen');

    // Assert
    should(ledger.patches).eql([{ unlockOnOpen: true }]);
    should(marked(block, 'data-security-value', 'unlockOnOpen')[0]?.children).eql(['On']);
    expect(text(block)).toContain('Unlock with a passkey on opening: now on.');
    run(() => block.unmount());
  });

  it('turns asking again on, which tightens, and then offers the change window', async () => {
    // Arrange
    const ledger: Ledger = { patches: [] };
    const block = await mountBlock(
      machine(view(), patch => ({ view: view({}, { ...patch }), devicesExpiring: 0 }), ledger),
    );
    should(switchIn(marked(block, 'data-security-switch', 'stepUpOnActions')[0])?.props.disabled).equal(false);
    should(marked(block, 'data-security-setting', 'stepUpWindowMinutes')).be.empty();

    // Act
    await press(block, 'data-security-switch', 'stepUpOnActions');

    // Assert
    should(ledger.patches).eql([{ stepUpOnActions: true }]);
    expect(text(block)).toContain('Ask again for each change: now on.');
    should(marked(block, 'data-security-setting', 'stepUpWindowMinutes')).have.length(1);
    run(() => block.unmount());
  });
});

describe('SecuritySettingsBlock loosening', () => {
  it('disables Save and says to go to the machine for a number that would loosen', async () => {
    // Arrange
    const ledger: Ledger = { patches: [] };
    const block = await mountBlock(machine(view(), () => new Error('unused'), ledger));

    // Act
    await typeInto(block, 'idleExpiryDays', '60');

    // Assert
    should(saveButton(block, 'idleExpiryDays')?.props.disabled).equal(true);
    expect(text(block)).toContain(`Loosening this can only be done at the machine: run ${COMMAND} idleExpiryDays 60.`);
    should(ledger.patches).be.empty();
    run(() => block.unmount());
  });

  it('switches each switch off only at the machine, and says so in one sentence', async () => {
    // Arrange
    const block = await mountBlock(machine(view({}, { stepUpOnActions: true }), () => new Error('unused')));

    // Assert
    for (const field of ['unlockOnOpen', 'stepUpOnActions'])
      should(switchIn(marked(block, 'data-security-switch', field)[0])?.props.disabled).equal(true);
    should(marked(block, 'data-security-note', 'unlockOnOpen')).have.length(1);
    should(marked(block, 'data-security-note', 'stepUpOnActions')).have.length(1);
    expect(text(block)).toContain(`Loosening this can only be done at the machine: run ${COMMAND} unlockOnOpen false.`);
    expect(text(block)).toContain(
      `Loosening this can only be done at the machine: run ${COMMAND} stepUpOnActions false.`,
    );
    run(() => block.unmount());
  });

  it('allows loosening where the caller is on the machine, with no sentence about it', async () => {
    // Arrange
    const ledger: Ledger = { patches: [] };
    const block = await mountBlock(
      machine(
        view({ mayWiden: true }, { unlockOnOpen: true }),
        patch => ({ view: view({ mayWiden: true }, { unlockOnOpen: true, ...patch }), devicesExpiring: 0 }),
        ledger,
      ),
    );

    // Act
    await typeInto(block, 'idleExpiryDays', '60');
    should(saveButton(block, 'idleExpiryDays')?.props.disabled).equal(false);
    await press(block, 'data-security-save', 'form');
    await press(block, 'data-security-switch', 'unlockOnOpen');

    // Assert
    should(ledger.patches).eql([{ idleExpiryDays: 60 }, { unlockOnOpen: false }]);
    expect(text(block)).not.toContain('Loosening this');
    run(() => block.unmount());
  });
});

describe('SecuritySettingsBlock raising how long an unlock lasts (up to a week, with a passkey)', () => {
  it('offers the common choices, the current one pressed, each said in its own unit', async () => {
    // Arrange / Act
    const block = await mountBlock(machine(view(), () => new Error('unused')));

    // Assert
    const radios = block.root.findAll(
      node =>
        node.type === 'input' &&
        node.props.type === 'radio' &&
        ['1', '8', '24', '72', '168'].includes(node.props.value as string) &&
        choiceFor(block, `unlockValidityHours:${node.props.value as string}`) === node,
    );
    should(radios.map(node => node.props.value)).eql(['1', '8', '24', '72', '168']);
    for (const words of ['1 hour', '8 hours', '1 day', '3 days', '7 days']) expect(text(block)).toContain(words);
    should(radios.filter(node => node.props.checked === true).map(node => node.props.value)).eql(['8']);
    run(() => block.unmount());
  });

  it('lets a device raise it with a passkey: Save stays on and one sentence says the passkey is asked for', async () => {
    // Arrange
    const ledger: Ledger = { patches: [] };
    const block = await mountBlock(
      machine(view(), patch => ({ view: view({}, patch as Partial<SecuritySettings>), devicesExpiring: 0 }), ledger),
    );

    // Act
    await press(block, 'data-security-preset', 'unlockValidityHours:168');

    // Assert
    should(marked(block, 'data-security-input', 'unlockValidityHours')[0]?.props.value).equal('168');
    should(saveButton(block, 'unlockValidityHours')?.props.disabled).equal(false);
    should(marked(block, 'data-security-note-kind', 'passkey')).have.length(1);
    expect(text(block)).toContain('Raising this asks for your passkey, then takes effect at once.');
    should(marked(block, 'data-security-note-kind', 'at-machine')).be.empty();

    // Act
    await press(block, 'data-security-save', 'form');

    // Assert
    should(ledger.patches).eql([{ unlockValidityHours: 168 }]);
    should(marked(block, 'data-security-value', 'unlockValidityHours')[0]?.children).eql(['7 days']);
    expect(text(block)).toContain('An unlock lasts: now 7 days.');
    run(() => block.unmount());
  });

  it('says nothing about a passkey for a shorter unlock, or on the machine', async () => {
    // Arrange
    const shorter = await mountBlock(machine(view(), () => new Error('unused')));
    const atMachine = await mountBlock(machine(view({ mayWiden: true }), () => new Error('unused')));

    // Act
    await press(shorter, 'data-security-preset', 'unlockValidityHours:1');
    await press(atMachine, 'data-security-preset', 'unlockValidityHours:168');

    // Assert
    should(marked(shorter, 'data-security-note', 'unlockValidityHours')).be.empty();
    should(marked(atMachine, 'data-security-note', 'unlockValidityHours')).be.empty();
    run(() => shorter.unmount());
    run(() => atMachine.unmount());
  });

  it('says a passkey that was not confirmed changed nothing, and keeps the choice', async () => {
    // Arrange
    const refused = new FyHttpError('needs a passkey', 403, STEP_UP_REQUIRED_CODE);
    const block = await mountBlock(machine(view(), () => refused));

    // Act
    await press(block, 'data-security-preset', 'unlockValidityHours:72');
    await press(block, 'data-security-save', 'form');

    // Assert
    expect(text(block)).toContain('This change needs your passkey, and it was not confirmed. Nothing was changed.');
    should(marked(block, 'data-security-input', 'unlockValidityHours')[0]?.props.value).equal('72');
    run(() => block.unmount());
  });
});

describe('SecuritySettingsBlock refusals', () => {
  it('refuses a number outside the bounds in one sentence and never sends it', async () => {
    // Arrange
    const ledger: Ledger = { patches: [] };
    const block = await mountBlock(machine(view(), () => new Error('unused'), ledger));

    // Act
    await typeInto(block, 'deviceKeyRotationDays', '3');

    // Assert
    expect(text(block)).toContain('Enter a whole number from 7 to 90.');
    should(saveButton(block, 'deviceKeyRotationDays')?.props.disabled).equal(true);
    should(ledger.patches).be.empty();
    run(() => block.unmount());
  });

  it('turns a machine refusal into one sentence, never its code, and keeps the draft', async () => {
    // Arrange
    const refusal = new FyHttpError('refused', 403, SECURITY_WIDEN_REFUSED_CODE);
    const block = await mountBlock(machine(view({ mayWiden: true }, { stepUpOnActions: true }), () => refusal));

    // Act
    await typeInto(block, 'stepUpWindowMinutes', '5');
    await press(block, 'data-security-save', 'form');

    // Assert
    expect(text(block)).toContain(
      `Loosening this can only be done at the machine: run ${COMMAND} stepUpWindowMinutes 5.`,
    );
    expect(text(block)).not.toContain(SECURITY_WIDEN_REFUSED_CODE);
    expect(text(block)).not.toMatch(/<[a-z]+>/u);
    should(saveButton(block, 'stepUpWindowMinutes')).not.be.undefined();
    should(marked(block, 'data-security-notice')).be.empty();
    run(() => block.unmount());
  });

  it('says a failed switch changed nothing', async () => {
    // Arrange
    const block = await mountBlock(machine(view(), () => new Error('offline')));

    // Act
    await press(block, 'data-security-switch', 'stepUpOnActions');

    // Assert
    expect(text(block)).toContain('The setting was not changed. Try again.');
    should(marked(block, 'data-security-value', 'stepUpOnActions')[0]?.children).eql(['Off']);
    run(() => block.unmount());
  });
});
