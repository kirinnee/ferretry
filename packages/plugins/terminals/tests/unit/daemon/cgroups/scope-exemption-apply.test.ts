import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENT_SCOPE_PREFIX,
  agentScopeCommand,
  agentScopeInPlacement,
  agentScopeName,
  type CgroupCommandPort,
  CgroupError,
  commandFailureMessage,
  FLEET_SLICE,
  failureText,
  isWardenItself,
  launchIsExempt,
  MAX_LINEAGE_DEPTH,
  placedUnderSlice,
  resolveFleetExemption,
  runCgroupCommand,
  type SessionSpawnFacts,
  type SessionSpawnFactsPort,
  safeUnitPart,
  slicePropertyCommand,
  sliceCgroupPath,
} from '../../../src/lib/cgroups/index.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/index.ts';

const runner = (results: readonly { code: number; stdout?: string; stderr?: string }[]): CgroupCommandPort => {
  const queue = [...results];
  return {
    execute: async () => {
      const next = queue.shift() ?? { code: 0 };
      return { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
    },
  };
};

describe('naming and recognising units', () => {
  it('should derive both names from the product scope rather than a literal', () => {
    // Arrange / Act / Assert
    should(FLEET_SLICE).equal('ferretry_fleet.slice');
    should(AGENT_SCOPE_PREFIX).equal('ferretry-agent-');
  });

  it('should name the fleet slice as a direct child of the user manager, so its weight is weighed against app.slice', () => {
    // Arrange / Act / Assert — systemd reads a dash as hierarchy: `ferretry-fleet.slice` would sit inside
    // `ferretry.slice`, a sibling of app.slice, and take that parent's whole weight as its only busy child
    should(sliceCgroupPath(FLEET_SLICE)).deepEqual(['ferretry_fleet.slice']);
    should(FLEET_SLICE).not.containEql('-');
  });

  it('should derive the nested cgroup path systemd gives a dashed slice name', () => {
    // Arrange / Act / Assert
    should(sliceCgroupPath('ferretry-fleet.slice')).deepEqual(['ferretry.slice', 'ferretry-fleet.slice']);
    should(sliceCgroupPath('a-b-c.slice')).deepEqual(['a.slice', 'a-b.slice', 'a-b-c.slice']);
    should(sliceCgroupPath('solo.slice')).deepEqual(['solo.slice']);
  });

  it('should reduce anything a unit name may not hold to a dash', () => {
    // Arrange / Act / Assert
    should(safeUnitPart('a/b c:d')).equal('a-b-c-d');
  });

  it('should keep a readable stand-in when a value reduces to nothing', () => {
    // Arrange / Act / Assert — otherwise the scope would be named `--<nonce>.scope`.
    should(safeUnitPart('///')).equal('session');
  });

  it('should bound a unit part so one long id cannot produce an unusable name', () => {
    // Arrange / Act / Assert
    should(safeUnitPart('x'.repeat(200))).have.length(96);
  });

  it('should carry a nonce so a relaunch cannot collide with a deactivating scope', () => {
    // Arrange / Act
    const first = agentScopeName('s-1', 'aaaa');
    const second = agentScopeName('s-1', 'bbbb');

    // Assert
    should(first).equal('ferretry-agent-s-1-aaaa.scope');
    should(first).not.equal(second);
  });

  it('should read the RUNNING scope out of a placement rather than rebuilding the name', () => {
    // Arrange
    const placement =
      '0::/user.slice/user-1000.slice/user@1000.service/ferretry_fleet.slice/ferretry-agent-s1-9f.scope';

    // Act / Assert
    should(agentScopeInPlacement(placement)).equal('ferretry-agent-s1-9f.scope');
  });

  it('should find the scope on whichever hierarchy line carries it', () => {
    // Arrange
    const placement = ['1:name=systemd:/nowhere', `0::/${AGENT_SCOPE_PREFIX}s2-ab.scope`].join('\n');

    // Act / Assert
    should(agentScopeInPlacement(placement)).equal('ferretry-agent-s2-ab.scope');
  });

  it('should answer with nothing when the pid is in no managed scope', () => {
    // Arrange / Act / Assert
    should(agentScopeInPlacement('0::/user.slice/user@1000.service/app.slice/some.service')).be.undefined();
  });

  it('should ignore a line with no path at all rather than treating it as a placement', () => {
    // Arrange / Act / Assert
    should(agentScopeInPlacement('garbage-with-no-separator')).be.undefined();
  });

  it('should never mistake a controller list for a placement', () => {
    // Arrange / Act / Assert — the prefix appears before the path's separator, so it is not a path.
    should(agentScopeInPlacement(`1:${AGENT_SCOPE_PREFIX}x.scope`)).be.undefined();
  });

  it('should prove a pid is under the fleet slice when it is', () => {
    // Arrange / Act / Assert
    should(placedUnderSlice('0::/user@1000.service/ferretry_fleet.slice/x.scope', FLEET_SLICE)).be.true();
  });

  it('should prove a pid is outside the fleet slice when it is', () => {
    // Arrange / Act / Assert
    should(placedUnderSlice('0::/user@1000.service/app.slice/fyd.service', FLEET_SLICE)).be.false();
  });

  it('should treat the slice itself as under itself, so a leaf directly inside it still counts', () => {
    // Arrange / Act / Assert
    should(placedUnderSlice('0::/ferretry_fleet.slice', FLEET_SLICE)).be.true();
  });

  it('should ignore a line with no path when proving placement', () => {
    // Arrange / Act / Assert
    should(placedUnderSlice('no-path-here', FLEET_SLICE)).be.false();
  });

  it('should compose the aggregate property change as a runtime-only set-property', () => {
    // Arrange / Act
    const argv = slicePropertyCommand('a.slice', ['CPUWeight=50', 'MemoryMax=99']);

    // Assert
    should(argv).deepEqual([
      'systemctl',
      '--user',
      'set-property',
      '--runtime',
      'a.slice',
      'CPUWeight=50',
      'MemoryMax=99',
    ]);
  });

  it('should compose a transient collected scope under the fleet slice with both caps', () => {
    // Arrange / Act
    const argv = agentScopeCommand({
      scope: 'ferretry-agent-s1-ab.scope',
      slice: FLEET_SLICE,
      properties: ['CPUWeight=100', 'MemoryMax=7'],
      command: ['claude', '--flag'],
    });

    // Assert
    should(argv).deepEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=ferretry-agent-s1-ab.scope',
      `--slice=${FLEET_SLICE}`,
      '--property=CPUWeight=100',
      '--property=MemoryMax=7',
      '--',
      'claude',
      '--flag',
    ]);
  });
});

describe('deciding which sessions may never be capped', () => {
  const reader = (documents: Readonly<Record<string, SessionSpawnFacts | undefined>>): SessionSpawnFactsPort => ({
    facts: async id => documents[id],
  });

  it('should exempt a session the spawn labelled as supervision', async () => {
    // Arrange / Act / Assert — the ONE marker production actually writes.
    should(await resolveFleetExemption('w1', reader({ w1: { label: WARDEN_LABEL } }))).equal('exempt');
  });

  it('should tolerate surrounding whitespace on the durable label', async () => {
    // Arrange / Act / Assert
    should(await resolveFleetExemption('w1', reader({ w1: { label: `  ${WARDEN_LABEL}  ` } }))).equal('exempt');
  });

  it('should exempt a session whose durable stamp records warden descent', async () => {
    // Arrange / Act / Assert — read for the day it exists; see this module's declared GAP.
    should(await resolveFleetExemption('c1', reader({ c1: { wardenLineage: true } }))).equal('exempt');
  });

  it('should exempt a child by WALKING to the warden that spawned it', async () => {
    // Arrange — the only mechanism that works on a real host today: the child carries no stamp, and
    // nothing in this daemon writes one, so descent has to be read from the parent link.
    const documents = reader({ child: { parent: 'w1' }, w1: { label: WARDEN_LABEL } });

    // Act / Assert
    should(await resolveFleetExemption('child', documents)).equal('exempt');
  });

  it('should exempt a grandchild through a chain of ordinary spawns', async () => {
    // Arrange
    const documents = reader({ leaf: { parent: 'mid' }, mid: { parent: 'w1' }, w1: { label: WARDEN_LABEL } });

    // Act / Assert
    should(await resolveFleetExemption('leaf', documents)).equal('exempt');
  });

  it('should cap an ordinary agent', async () => {
    // Arrange / Act / Assert
    should(await resolveFleetExemption('s1', reader({ s1: { label: 'my-batch', wardenLineage: false } }))).equal(
      'governed',
    );
  });

  it('should cap a session with no spawn markers at all', async () => {
    // Arrange / Act / Assert
    should(await resolveFleetExemption('s1', reader({ s1: {} }))).equal('governed');
  });

  it('should cap a session whose ancestry leads nowhere near supervision', async () => {
    // Arrange
    const documents = reader({ s1: { parent: 'p1' }, p1: { parent: 'p0' }, p0: {} });

    // Act / Assert
    should(await resolveFleetExemption('s1', documents)).equal('governed');
  });

  it('should NOT read a pruned ancestor as descent, which would uncap the whole fleet', async () => {
    // Arrange — a finished warden is pruned while its children still run, so this is the COMMON case.
    // Shielding on it would silently exempt every session whose parent has been collected.
    const documents = reader({ s1: { parent: 'gone' } });

    // Act / Assert — the same rule warden/detect.ts states for its own backstop.
    should(await resolveFleetExemption('s1', documents)).equal('governed');
  });

  it('should stop at a cycle rather than reading the same documents forever', async () => {
    // Arrange
    const documents = reader({ a: { parent: 'b' }, b: { parent: 'a' } });

    // Act / Assert
    should(await resolveFleetExemption('a', documents)).equal('governed');
  });

  it('should stop at the depth bound rather than walking an unbounded chain on one request', async () => {
    // Arrange — a chain longer than the bound, ending at a warden the walk must NOT reach.
    const documents: Record<string, SessionSpawnFacts> = { deep: { label: WARDEN_LABEL } };
    let previous = 'deep';
    for (let index = 0; index <= MAX_LINEAGE_DEPTH + 2; index += 1) {
      documents[`n${index}`] = { parent: previous };
      previous = `n${index}`;
    }

    // Act / Assert
    should(await resolveFleetExemption(previous, reader(documents))).equal('governed');
  });

  it('should call a session whose OWN document is unreadable unknown, never governed', async () => {
    // Arrange / Act / Assert
    should(await resolveFleetExemption('missing', reader({}))).equal('unknown');
  });

  it('should call a session whose own read THREW unknown as well', async () => {
    // Arrange
    const throwing: SessionSpawnFactsPort = {
      facts: async () => {
        throw new Error('EACCES');
      },
    };

    // Act / Assert
    should(await resolveFleetExemption('s1', throwing)).equal('unknown');
  });

  it('should let a LAUNCH leave both supervision and the unreadable uncapped', () => {
    // Arrange / Act / Assert — starving the watchdog is worse than one uncapped agent; the reporting
    // half warns about exactly the unknown case, so the choice is never silent.
    should(launchIsExempt('exempt')).be.true();
    should(launchIsExempt('unknown')).be.true();
    should(launchIsExempt('governed')).be.false();
  });

  it('should recognise supervision from either marker without walking', () => {
    // Arrange / Act / Assert
    should(isWardenItself({ label: WARDEN_LABEL })).be.true();
    should(isWardenItself({ wardenLineage: true })).be.true();
    should(isWardenItself({ label: 'ordinary' })).be.false();
  });
});

describe('talking to the host manager', () => {
  it('should accept a command the manager ran', async () => {
    // Arrange / Act / Assert
    await runCgroupCommand(runner([{ code: 0 }]), ['systemctl'], 'unused');
  });

  it('should raise the manager OWN words when it refuses', async () => {
    // Arrange / Act / Assert
    await should(
      runCgroupCommand(runner([{ code: 1, stderr: 'Failed to connect to bus' }]), ['systemctl'], 'fallback'),
    ).be.rejectedWith(/Failed to connect to bus/u);
  });

  it('should classify a refusal as a host failure rather than a bad request', async () => {
    // Arrange
    let failure: string | undefined;

    // Act
    await runCgroupCommand(runner([{ code: 1, stderr: 'no' }]), ['systemctl'], 'fallback').catch(error => {
      failure = error instanceof CgroupError ? error.failure : undefined;
    });

    // Assert
    should(failure).equal('failed');
  });

  it('should fall back to standard output when the manager said nothing on the error stream', () => {
    // Arrange / Act / Assert
    should(commandFailureMessage({ stdout: ' loud ', stderr: '  ' }, 'fallback')).equal('loud');
  });

  it('should fall back to the caller description when the manager said nothing at all', () => {
    // Arrange / Act / Assert
    should(commandFailureMessage({ stdout: '', stderr: '' }, 'could not configure a.slice')).equal(
      'could not configure a.slice',
    );
  });

  it('should report a thrown non-error without turning it into an unreadable object', () => {
    // Arrange / Act / Assert
    should(failureText('plain string')).equal('plain string');
  });

  it('should report an error by its message', () => {
    // Arrange / Act / Assert
    should(failureText(new Error('the reason'))).equal('the reason');
  });
});
