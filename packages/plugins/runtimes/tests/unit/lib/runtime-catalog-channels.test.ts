import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { type CatalogFacts, runtimeCatalog } from '../../../daemon/lib/service/catalog.ts';

/**
 * The read-only fixed-layer view of a Claude agent runtime says whether Ferretry's messages go through Claude's channel
 * for THAT runtime — by the login's organisation type unless machine.yaml says otherwise — so what the app shows is what
 * the wrapper launches.
 */
const model = (machine: Record<string, unknown> = {}) =>
  parseAccountModel({
    version: 1,
    machine,
    credentials: { 'claude-a': { harness: 'claude', store: 'ferretry' } },
    components: {},
    profiles: { empty: { layers: [] } },
    runtimes: { 'claude-run': { credential: 'claude-a', profile: 'empty', agent: true } },
  });

const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'box',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/me',
  acceptsAutoPermissionMode: true,
};

const channelsRow = (organizationType: string | undefined, machine: Record<string, unknown> = {}): unknown => {
  const facts: CatalogFacts =
    organizationType === undefined ? FACTS : { ...FACTS, organizationTypes: { 'claude-a': organizationType } };
  const runtime = runtimeCatalog(model(machine), facts).runtimes.find(candidate => candidate.name === 'claude-run');
  return JSON.stringify(runtime?.fixedLayer ?? {}).includes('Ferretry messages through Claude’s channel');
};

describe('the runtime list’s fixed-layer view of the Claude channel', () => {
  it('should show the channel on for a claude_max login, and off for Enterprise, Team and an unknown one', () => {
    should([
      channelsRow('claude_max'),
      channelsRow('claude_enterprise'),
      channelsRow('claude_team'),
      channelsRow(undefined),
    ]).eql([true, false, false, false]);
  });

  it('should let machine.yaml win in the view as it does at launch', () => {
    should([
      channelsRow('claude_max', { claudeChannels: false }),
      channelsRow('claude_enterprise', { claudeChannels: true }),
    ]).eql([false, true]);
  });
});
