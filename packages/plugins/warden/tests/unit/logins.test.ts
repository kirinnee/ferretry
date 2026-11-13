import { describe, it } from 'bun:test';
import should from 'should';
import { FleetWardenAgents, selectWardenAccount } from '../../daemon/lib/index.ts';
import { account } from '../support/accounts.ts';

const DEFAULT_ID = '0b6f6b5e-5d7c-4f4e-9d0a-1d1f2a3b4c5d';
const REVIEW_ID = '7c1a9f3e-2b4d-4e8f-8a6b-9c0d1e2f3a4b';
const INTERACTIVE_ID = '3e5d7f9a-1c2b-4d6e-8f0a-b1c2d3e4f5a6';

const fleet = [
  account({ id: DEFAULT_ID, agent: 'claude-default' }),
  account({ id: REVIEW_ID, agent: 'codex-review', kind: 'codex' }),
  account({ id: INTERACTIVE_ID, agent: 'claude-personal', mode: 'interactive' }),
];

const subject = (): FleetWardenAgents =>
  new FleetWardenAgents({ accounts: async () => fleet }, async () => 'claude-default');

describe('the logins the Warden can run on', () => {
  it('should be offered by name, never by the manifest id', async () => {
    const installed = await subject().installed();
    should(installed).deepEqual(['claude-default', 'codex-review']);
  });

  it('should let a failover pick the runtime a warden.yaml names', async () => {
    const installedAgents = await subject().installed();
    const picked = selectWardenAccount({
      accounts: [{ agent: 'codex-review' }, { agent: 'claude-default' }],
      installedAgents,
      usage: [],
      state: {},
      nowMs: Date.parse('2026-10-25T12:00:00.000Z'),
    });
    should(picked.exhausted).be.false();
    should(picked.exhausted ? undefined : picked.account.agent).equal('codex-review');
  });
});

describe('the name a stored login reference means', () => {
  it('should keep a name that is already current', async () => {
    should(await subject().currentName('claude-default')).equal('claude-default');
  });

  it('should read a stored id as the login’s name', async () => {
    should(await subject().currentName(REVIEW_ID)).equal('codex-review');
  });

  it('should answer nothing for a reference no login answers to', async () => {
    should(await subject().currentName('ghost')).be.undefined();
  });
});
