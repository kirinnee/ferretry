import { describe, it } from 'bun:test';
import should from 'should';
import { defaultFleetHarness } from '../../src/lib/harness.ts';

describe('defaultFleetHarness', () => {
  it('should prefer Claude when both harnesses can launch', () => {
    should(
      defaultFleetHarness([
        { kind: 'codex', launchable: ['/bin/codex'] },
        { kind: 'claude', launchable: ['/bin/claude'] },
      ]),
    ).equal('claude');
  });

  it('should use Codex when only Codex can launch', () => {
    should(
      defaultFleetHarness([
        { kind: 'claude', launchable: [] },
        { kind: 'codex', launchable: ['/bin/codex'] },
      ]),
    ).equal('codex');
  });

  it('should answer nothing without positive launch evidence', () => {
    should(defaultFleetHarness([{ kind: 'claude', launchable: [] }])).be.undefined();
    should(defaultFleetHarness([])).be.undefined();
  });
});
