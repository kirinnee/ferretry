import { describe, it } from 'bun:test';
import should from 'should';
import { type FailoverCandidateInput, selectFailoverTarget } from '../../../src/lib/quota-failover/index.ts';
import { account, healthyRow, spentRow, usageRow } from './fixtures.ts';

const input = (overrides: Partial<FailoverCandidateInput> = {}): FailoverCandidateInput => ({
  sourceAgent: 'agent-a',
  sourceHarness: 'claude',
  pool: ['agent-a', 'agent-b', 'agent-c'],
  accounts: [account('agent-a'), account('agent-b'), account('agent-c')],
  usage: [spentRow('agent-a'), healthyRow('agent-b', 40), healthyRow('agent-c', 10)],
  headroomPercent: 80,
  barred: new Map(),
  ...overrides,
});

describe('selectFailoverTarget', () => {
  it('should pick the emptiest confirmed account in the pool', () => {
    // Act
    const selection = selectFailoverTarget(input());

    // Assert — the emptiest account is the one most likely to still be there next turn
    should(selection.target).deepEqual({ agent: 'agent-c', spentPercent: 10 });
  });

  it('should say why the account the session is already on was not a target', () => {
    // Act
    const selection = selectFailoverTarget(input());

    // Assert
    should(selection.rejected['agent-a']).equal('it is the account this session is already on');
  });

  it('should say why an eligible runner-up was not chosen', () => {
    // Act
    const selection = selectFailoverTarget(input());

    // Assert — an operator comparing two healthy accounts must see the measurement decided
    should(selection.rejected['agent-b']).equal('usable at 40%, but agent-c is emptier at 10%');
  });

  it('should keep the operator preference order when two candidates measure the same', () => {
    // Arrange
    const selection = selectFailoverTarget(
      input({ usage: [spentRow('agent-a'), healthyRow('agent-b', 30), healthyRow('agent-c', 30)] }),
    );

    // Assert
    should(selection.target?.agent).equal('agent-b');
  });

  it('should refuse an account the ledger bars, quoting the ledger reason', () => {
    // Arrange
    const barred = new Map([['agent-c', 'this session was automatically moved off it 60s ago']]);

    // Act
    const selection = selectFailoverTarget(input({ barred }));

    // Assert — this is the guard that stops two exhausted accounts ping-ponging one session
    should(selection.target?.agent).equal('agent-b');
    should(selection.rejected['agent-c']).equal('this session was automatically moved off it 60s ago');
  });

  it('should refuse a pool entry no single manifest row publishes', () => {
    // Arrange — ambiguity is refused too: two rows sharing an executable is a manifest defect
    const selection = selectFailoverTarget(
      input({ accounts: [account('agent-a'), account('agent-c'), account('agent-c', { id: 'id-twin' })] }),
    );

    // Assert
    should(selection.rejected['agent-b']).equal(
      'no single account in the published fleet manifest is named by this executable',
    );
    should(selection.rejected['agent-c']).equal(
      'no single account in the published fleet manifest is named by this executable',
    );
    should(selection.target).be.undefined();
  });

  it('should refuse a cross-family account with the migration own refusal', () => {
    // Arrange — one definition of what families are compatible, so this can never accept a move the
    // migrator is about to refuse
    const selection = selectFailoverTarget(
      input({
        accounts: [account('agent-a'), account('agent-b', { kind: 'codex' }), account('agent-c', { kind: 'codex' })],
      }),
    );

    // Assert
    should(selection.target).be.undefined();
    should(selection.rejected['agent-b']).match(/a migration continues one conversation under a new account/);
  });

  it('should refuse an account the manifest itself declares unavailable', () => {
    // Arrange
    const selection = selectFailoverTarget(
      input({
        accounts: [
          account('agent-a'),
          account('agent-b', { available: false, unavailableReason: 'the host has no wrapper for it' }),
          account('agent-c'),
        ],
      }),
    );

    // Assert
    should(selection.rejected['agent-b']).equal('the host has no wrapper for it');
  });

  it('should refuse an unavailable account that gave no reason, in its own words', () => {
    // Arrange
    const selection = selectFailoverTarget(
      input({ accounts: [account('agent-a'), account('agent-b', { available: false }), account('agent-c')] }),
    );

    // Assert
    should(selection.rejected['agent-b']).equal('the fleet manifest declares this account unavailable');
  });

  it('should refuse an account the feed has never scored', () => {
    // Arrange
    const selection = selectFailoverTarget(input({ usage: [spentRow('agent-a'), healthyRow('agent-c', 10)] }));

    // Assert
    should(selection.rejected['agent-b']).equal('the usage feed has no reading for this account');
    should(selection.target?.agent).equal('agent-c');
  });

  it('should find nothing, with a reason for every account, when the whole pool is out of tokens', () => {
    // Arrange — this is the outcome an operator has to act on, so it must never be silent
    const selection = selectFailoverTarget(
      input({ usage: [spentRow('agent-a'), spentRow('agent-b'), usageRow('agent-c', { ok: false })] }),
    );

    // Assert
    should(selection.target).be.undefined();
    should(Object.keys(selection.rejected).sort()).deepEqual(['agent-a', 'agent-b', 'agent-c']);
    should(selection.rejected['agent-b']).equal('the account is at its usage limit');
  });

  it('should find nothing from an empty pool without inventing a reason', () => {
    // Arrange / Act
    const selection = selectFailoverTarget(input({ pool: [] }));

    // Assert
    should(selection).deepEqual({ target: undefined, rejected: {} });
  });
});
