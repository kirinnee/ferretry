import { describe, expect, it } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { render, run, runAsync } from '@ferretry/app/testing';
import type { DialogLearnAnswer } from '../../../contract/dialog-rules.ts';
import { WardenDialogRules, WardenDialogRulesView } from '../../../app/features/warden/warden-dialog-rules.tsx';
import { daemonConnection } from '../../../app/lib/machine.ts';
import { WardenClientContext } from '../../../app/lib/warden-client-context.tsx';
import { fakeWardenClient } from '../../support/app/clients.ts';
import { FAKE_PROPOSAL, FAKE_VIEW } from '../../support/app/dialog-rules.ts';

/** The "Screens Ferretry clears" card over a FIXED FAKE screen: no real pane, no real ferret. */

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());
const button = (renderer: ReactTestRenderer, label: string) => {
  const found = renderer.root.findAll(node => node.type === 'button' && node.children.join('') === label)[0];
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
};
const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
};

describe('the screens Ferretry clears', () => {
  const props = { view: FAKE_VIEW, busy: false, onLearn: () => undefined, onConfirm: () => undefined };

  it('should list what it clears by itself, in sentences, and say it never presses a row that trusts', () => {
    // Act
    const shown = text(render(<WardenDialogRulesView {...props} />));

    // Assert
    expect(shown).toContain('Screens Ferretry clears by itself');
    expect(shown).toContain('presses Esc');
    expect(shown).toContain('Continue without using this MCP server');
    expect(shown).toContain('never');
    expect(shown).toContain('Not now');
    const empty = text(render(<WardenDialogRulesView {...props} view={{ builtIn: [], taught: [], pending: [] }} />));
    expect(empty).toContain('None.');
    expect(empty).toContain('Nothing yet.');
  });

  it('should show the row a proposed rule would press, and offer the owner’s yes only for a rule that can be saved', () => {
    // Act
    const proposed = render(<WardenDialogRulesView {...props} proposal={FAKE_PROPOSAL} />);
    const held = render(
      <WardenDialogRulesView
        {...props}
        proposal={{ ...FAKE_PROPOSAL, held: true, rule: undefined, note: 'that row grants something, so it is held.' }}
      />,
    );

    // Assert
    expect(text(proposed)).toContain('the rule would press this');
    expect(text(proposed)).toContain('Save this rule');
    expect(text(held)).not.toContain('Save this rule');
    expect(text(held)).toContain('it is held');
  });

  it('should ask for the ferret by name, and send the trimmed name', () => {
    // Arrange
    const asked: string[] = [];
    const renderer = render(<WardenDialogRulesView {...props} onLearn={name => asked.push(name)} />);
    expect(button(renderer, 'Look at its screen').props.disabled).toBe(true);

    // Act
    run(() => renderer.root.findByType('input').props.onChange({ target: { value: '  ada ' } }));
    run(() => button(renderer, 'Look at its screen').props.onClick());

    // Assert
    expect(asked).toEqual(['ada']);
  });

  it('should confirm a waiting proposal by its ferret', () => {
    // Arrange
    const confirmed: string[] = [];
    const renderer = render(
      <WardenDialogRulesView
        {...props}
        view={{ ...FAKE_VIEW, pending: [FAKE_PROPOSAL] }}
        onConfirm={name => confirmed.push(name)}
      />,
    );

    // Act
    run(() => button(renderer, 'Save this rule').props.onClick());

    // Assert
    expect(confirmed).toEqual(['ada']);
  });
});

describe('the card over a daemon', () => {
  const connection = daemonConnection({ daemonId: 'ws' });

  function Over({ calls }: { readonly calls: string[] }) {
    let saved = false;
    const client = fakeWardenClient({
      dialogRules: async () => ({
        ...FAKE_VIEW,
        taught: saved ? [FAKE_VIEW.builtIn[0] as (typeof FAKE_VIEW.builtIn)[number]] : [],
      }),
      learnDialog: async (request): Promise<DialogLearnAnswer> => {
        calls.push(JSON.stringify(request));
        if (request.confirm === true) saved = true;
        return request.confirm === true
          ? { proposal: FAKE_PROPOSAL, saved: true, heldFor: [] }
          : { proposal: FAKE_PROPOSAL, saved: false, heldFor: [] };
      },
    });
    return (
      <WardenClientContext.Provider value={async () => client}>
        <WardenDialogRules connection={connection} />
      </WardenClientContext.Provider>
    );
  }

  it('should propose, then save on the owner’s yes, and say so', async () => {
    // Arrange
    const calls: string[] = [];
    const renderer = render(<Over calls={calls} />);
    await settle();

    // Act
    run(() => renderer.root.findByType('input').props.onChange({ target: { value: 'ada' } }));
    run(() => button(renderer, 'Look at its screen').props.onClick());
    await settle();
    expect(text(renderer)).toContain('the rule would press this');
    run(() => button(renderer, 'Save this rule').props.onClick());
    await settle();

    // Assert
    expect(calls).toEqual(['{"ferret":"ada"}', '{"ferret":"ada","confirm":true}']);
    expect(text(renderer)).toContain('Saved.');
    expect(text(renderer)).not.toContain('Save this rule');
  });

  it('should say what waits for the owner when the daemon holds the save, and a refusal in its own words', async () => {
    // Arrange
    let mode: 'held' | 'refused' = 'held';
    const client = fakeWardenClient({
      dialogRules: async () => FAKE_VIEW,
      learnDialog: async () => {
        if (mode === 'refused') throw new Error('that ferret is not parked on a dialog right now.');
        return { proposal: FAKE_PROPOSAL, saved: false, heldFor: ['the Warden may press keys to clear a screen'] };
      },
    });
    const renderer = render(
      <WardenClientContext.Provider value={async () => client}>
        <WardenDialogRules connection={connection} />
      </WardenClientContext.Provider>,
    );
    await settle();
    run(() => renderer.root.findByType('input').props.onChange({ target: { value: 'ada' } }));

    // Act
    run(() => button(renderer, 'Look at its screen').props.onClick());
    await settle();
    expect(text(renderer)).toContain('Waiting for your approval');
    mode = 'refused';
    run(() => button(renderer, 'Look at its screen').props.onClick());
    await settle();

    // Assert
    expect(text(renderer)).toContain('not parked on a dialog');
  });

  it('should draw nothing while the daemon has not answered, or cannot', async () => {
    // Arrange
    const client = fakeWardenClient({
      dialogRules: async () => {
        throw new Error('no route');
      },
    });
    const renderer = render(
      <WardenClientContext.Provider value={async () => client}>
        <WardenDialogRules connection={connection} />
      </WardenClientContext.Provider>,
    );

    // Act
    await settle();

    // Assert
    expect(renderer.toJSON()).toBeNull();
  });
});
