/**
 * The Codex branches of the harness-facing groups that no other test reaches (E-276 PR 1): each still branches on the
 * harness for now, and the move PRs that replace a branch with a kit member must find it pinned here first.
 */
import { describe, expect, it } from 'bun:test';
import { priorServersOf } from '../../../daemon/lib/account/adapt.ts';
import { harnessFactsOf } from '../../../daemon/lib/service/harness-facts.ts';
import { autonomousPreparation } from '../../../daemon/lib/wrappers.ts';
import { REAL_KITS } from '../../support/real-kits.ts';
import { twoHarnessWorld, wrapperText } from '../../support/two-harness-world.ts';

const SERVERS: Record<string, { command: string; args: string[] }> = {
  files: { command: 'files-server', args: ['--stdio'] },
};

describe('priorServersOf', () => {
  it('should answer no prior servers for Codex, whose document keeps none of them', () => {
    expect(priorServersOf('codex', () => SERVERS)).toEqual({});
  });

  it('should answer Claude the servers as its document spells them', () => {
    expect(Object.keys(priorServersOf('claude', () => SERVERS))).toEqual(['files']);
  });

  it('should not read the servers of a harness whose document keeps none', () => {
    let read = false;
    priorServersOf('codex', () => {
      read = true;
      return SERVERS;
    });
    expect(read).toBe(false);
  });
});

describe('autonomousPreparation', () => {
  it('should have Codex trust the launch folder and seed no first run', () => {
    expect(autonomousPreparation('codex')).toEqual({ seedFirstRun: false, trustLaunchFolder: true });
  });

  it('should have Claude seed its first run and trust no folder', () => {
    expect(autonomousPreparation('claude', REAL_KITS.get('claude'))).toEqual({
      seedFirstRun: true,
      trustLaunchFolder: false,
    });
  });
});

describe('the harness command a service plan execs', () => {
  const CODEX = '/opt/harness/bin/codex';

  it('should exec the located absolute path in the Codex wrapper', async () => {
    const { service, plans } = twoHarnessWorld({ locate: harness => (harness === 'codex' ? CODEX : undefined) });
    await service.publishFromFiles();
    const text = wrapperText(plans[0]!, 'codex-default');
    expect(text).toContain(`\nexec '${CODEX}' "$@"\n`);
    // Claude was not located: it keeps its bare command.
    expect(wrapperText(plans[0]!, 'claude-default')).toContain('\nexec claude "$@"\n');
  });

  it('should exec the bare command when the lookup finds nothing', async () => {
    const { service, plans } = twoHarnessWorld({ locate: () => undefined });
    await service.publishFromFiles();
    const text = wrapperText(plans[0]!, 'codex-default');
    expect(text).toContain('\nexec codex "$@"\n');
    expect(text).not.toContain(CODEX);
  });

  it('should name only the harnesses the lookup located', () => {
    expect(harnessFactsOf({ locate: harness => (harness === 'codex' ? CODEX : undefined) }).harnessCommands).toEqual({
      codex: CODEX,
    });
    expect(harnessFactsOf({ locate: () => undefined }).harnessCommands).toEqual({});
  });
});
