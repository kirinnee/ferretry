import { describe, it } from 'bun:test';
import should from 'should';
import { CgroupConfigPatchSchema } from '@ferretry/protocol';
import {
  AGENT_SCOPE_PREFIX,
  agentScopeCommand,
  agentScopeInPlacement,
  agentScopeName,
  applyCgroupConfigPatch,
  cgroupIssueSummary,
  CgroupDocumentReadFailure,
  CgroupError,
  cgroupsSupported,
  cleanCgroupApplyStatus,
  commandFailureMessage,
  defaultCgroupConfig,
  effectiveCgroupLimits,
  failureText,
  FLEET_SLICE,
  isEmptyCgroupConfigPatch,
  parseStoredCgroupApplyStatus,
  parseStoredCgroupConfig,
  pendingCgroupApplyStatus,
  placedUnderSlice,
  runCgroupCommand,
  safeUnitPart,
  unappliedCgroupEvidence,
  isWardenItself,
  launchIsExempt,
  MAX_LINEAGE_DEPTH,
  resolveFleetExemption,
  slicePropertyCommand,
  unitLimits,
  type CgroupCommandPort,
  type CgroupHostFacts,
  type SessionSpawnFacts,
  type SessionSpawnFactsPort,
} from '../../../src/lib/cgroups/index.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/index.ts';

const host = (overrides: Partial<CgroupHostFacts> = {}): CgroupHostFacts => ({
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 8,
  memoryBytes: 32 * 1024 ** 3,
  ...overrides,
});

const runner = (results: readonly { code: number; stdout?: string; stderr?: string }[]): CgroupCommandPort => {
  const queue = [...results];
  return {
    execute: async () => {
      const next = queue.shift() ?? { code: 0 };
      return { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
    },
  };
};

describe('the shipped resource-limit defaults', () => {
  it('should leave enforcement off so a host with no reachable user manager still starts every agent', () => {
    // Arrange / Act / Assert
    should(defaultCgroupConfig.enabled).be.false();
  });

  it('should reserve a tenth of the machine outside the fleet aggregate', () => {
    // Arrange / Act / Assert
    should(defaultCgroupConfig.fleet).deepEqual({ cpuPercent: 90, memoryPercent: 90 });
  });

  it('should keep any single agent below the aggregate it shares', () => {
    // Arrange / Act / Assert
    should(defaultCgroupConfig.perAgent.cpuPercent).be.lessThan(defaultCgroupConfig.fleet.cpuPercent);
  });
});

describe('reading the saved document', () => {
  it('should read an absent document as the defaults with nothing to report', () => {
    // Arrange / Act
    const stored = parseStoredCgroupConfig(undefined);

    // Assert
    should(stored).deepEqual({ config: defaultCgroupConfig, warnings: [] });
  });

  it('should read an explicitly null document as the defaults', () => {
    // Arrange / Act / Assert
    should(parseStoredCgroupConfig(null).config).deepEqual(defaultCgroupConfig);
  });

  it('should fall back to the defaults and SAY SO when the document no longer validates', () => {
    // Arrange / Act
    const stored = parseStoredCgroupConfig({ enabled: true, fleet: { cpuPercent: 900, memoryPercent: 10 } });

    // Assert
    should(stored.config).deepEqual(defaultCgroupConfig);
    should(stored.warnings).have.length(1);
    should(stored.warnings[0]).match(/did not validate/u);
  });

  it('should never leave a document it could not understand able to cap anything', () => {
    // Arrange / Act / Assert
    should(parseStoredCgroupConfig('not a document at all').config.enabled).be.false();
  });

  it('should report a document read failure rather than treating it as a fresh state home', () => {
    // Arrange / Act
    const stored = parseStoredCgroupConfig(new CgroupDocumentReadFailure('EACCES: permission denied'));

    // Assert
    should(stored.config.enabled).be.false();
    should(stored.readFailure).equal('EACCES: permission denied');
    should(stored.warnings.join(' ')).match(/could not be read \(EACCES: permission denied\)/u);
  });

  it('should name the whole document when the failure has no field path', () => {
    // Arrange / Act / Assert
    should(cgroupIssueSummary([{ path: [], message: 'expected object' }])).equal('document: expected object');
  });

  it('should name the failing field path when there is one', () => {
    // Arrange / Act / Assert
    should(cgroupIssueSummary([{ path: ['fleet', 'cpuPercent'], message: 'too big' }])).equal(
      'fleet.cpuPercent: too big',
    );
  });

  it('should report only the first failure, because one cause usually breaks several fields', () => {
    // Arrange / Act
    const summary = cgroupIssueSummary([
      { path: ['a'], message: 'first' },
      { path: ['b'], message: 'second' },
    ]);

    // Assert
    should(summary).equal('a: first');
  });
});

describe('applying an operator patch', () => {
  it('should merge one named share without resetting its sibling', () => {
    // Arrange / Act
    const merged = applyCgroupConfigPatch(defaultCgroupConfig, { fleet: { cpuPercent: 50 } });

    // Assert
    should(merged.fleet).deepEqual({ cpuPercent: 50, memoryPercent: 90 });
  });

  it('should refuse a merge that lets one agent exceed the aggregate it must fit inside', () => {
    // Arrange / Act / Assert — individually legal, jointly impossible.
    should(() => applyCgroupConfigPatch(defaultCgroupConfig, { fleet: { cpuPercent: 10 } })).throw();
  });

  it('should accept turning enforcement on without restating any share', () => {
    // Arrange / Act / Assert
    should(applyCgroupConfigPatch(defaultCgroupConfig, { enabled: true }).enabled).be.true();
  });

  it('should refuse a field the wire does not declare', () => {
    // Arrange / Act / Assert — the route parses through this exact schema, so there is one
    // strictness seam rather than a second one beside it that could drift.
    should(() => CgroupConfigPatchSchema.parse({ enabld: true })).throw();
  });

  it('should treat a patch with no fields as asking for nothing', () => {
    // Arrange / Act / Assert
    should(isEmptyCgroupConfigPatch({})).be.true();
  });

  it('should treat a PRESENT BUT EMPTY section as asking for nothing', () => {
    // Arrange / Act / Assert — `{"fleet":{}}` passes the strict schema and still changes no value.
    should(isEmptyCgroupConfigPatch({ fleet: {}, perAgent: {} })).be.true();
  });

  it('should treat one stated share as a real change', () => {
    // Arrange / Act / Assert
    should(isEmptyCgroupConfigPatch({ perAgent: { cpuPercent: 3 } })).be.false();
  });

  it('should treat an enforcement switch alone as a real change', () => {
    // Arrange / Act / Assert
    should(isEmptyCgroupConfigPatch({ enabled: false })).be.false();
  });
});

describe('reading the record of what a save could not apply', () => {
  const saved = { ...defaultCgroupConfig, enabled: true };
  const refusal = { sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', failure: 'Unit vanished' };
  const status = (overrides: Record<string, unknown> = {}) => ({
    config: saved,
    scopes: [],
    unproven: [],
    ...overrides,
  });
  const evidence = (
    stored: ReturnType<typeof parseStoredCgroupApplyStatus>,
    placements: readonly { sessionId: string; scope?: string; exempt: boolean }[],
  ) => unappliedCgroupEvidence({ stored, placements, slice: FLEET_SLICE });

  it('should read an absent record as ordinary while enforcement has never been enabled', () => {
    // Arrange / Act / Assert
    should(parseStoredCgroupApplyStatus(undefined, defaultCgroupConfig)).deepEqual({
      status: cleanCgroupApplyStatus(defaultCgroupConfig),
      unreadable: false,
      warnings: [],
    });
  });

  it('should treat a missing record beside enabled intent as unknown rather than clean', () => {
    // Arrange / Act
    const stored = parseStoredCgroupApplyStatus(undefined, saved);

    // Assert — this is the crash window between writing intent and recording what reached the host.
    should(stored.unreadable).be.true();
    should(stored.warnings.join(' ')).match(/is absent/u);
  });

  it('should read an explicitly null record like an absent one while enforcement is off', () => {
    // Arrange / Act / Assert
    should(parseStoredCgroupApplyStatus(null, defaultCgroupConfig).unreadable).be.false();
  });

  it('should default the two lists in a record bound to the current config', () => {
    // Arrange / Act
    const stored = parseStoredCgroupApplyStatus({ config: saved }, saved);

    // Assert
    should(stored.status.scopes).be.empty();
    should(stored.status.unproven).be.empty();
  });

  it('should call a record it cannot validate UNREADABLE rather than empty', () => {
    // Arrange / Act
    const stored = parseStoredCgroupApplyStatus({ config: saved, scopes: [{ sessionId: 's1' }] }, saved);

    // Assert — an empty reading would say "nothing failed", which is the opposite of what is known.
    should(stored.unreadable).be.true();
    should(stored.warnings.join(' ')).match(/did not validate/u);
  });

  it('should call a valid record for another config stale rather than current', () => {
    // Arrange / Act
    const stored = parseStoredCgroupApplyStatus(status(), {
      ...saved,
      perAgent: { ...saved.perAgent, cpuPercent: 10 },
    });

    // Assert
    should(stored.unreadable).be.true();
    should(stored.warnings.join(' ')).match(/different resource-limit configuration/u);
  });

  it('should carry an apply-record read failure as conservative evidence', () => {
    // Arrange / Act
    const stored = parseStoredCgroupApplyStatus(new CgroupDocumentReadFailure('EIO: input/output error'), saved);

    // Assert
    should(stored.unreadable).be.true();
    should(stored.warnings.join(' ')).match(/could not be read \(EIO: input\/output error\)/u);
  });

  it('should demand a restart of every governed session while the record is unreadable', () => {
    // Arrange / Act
    const unapplied = evidence(parseStoredCgroupApplyStatus('damaged', saved), [
      { sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', exempt: false },
      { sessionId: 'w1', exempt: true },
    ]);

    // Assert — supervision is never named: it is not inside the aggregate this is about.
    should(unapplied.restart).deepEqual(['s1']);
  });

  it('should keep naming a scope the manager refused while that scope is still the live one', () => {
    // Arrange / Act
    const unapplied = evidence(parseStoredCgroupApplyStatus(status({ scopes: [refusal] }), saved), [
      { sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', exempt: false },
    ]);

    // Assert
    should(unapplied.restart).deepEqual(['s1']);
    should(unapplied.warnings.join(' ')).match(/s1: Unit vanished/u);
  });

  it('should stop applying to a session that has been relaunched into a new scope', () => {
    // Arrange / Act — the nonce is what makes this provable rather than assumed.
    const unapplied = evidence(parseStoredCgroupApplyStatus(status({ scopes: [refusal] }), saved), [
      { sessionId: 's1', scope: 'ferretry-agent-s1-zz.scope', exempt: false },
    ]);

    // Assert
    should(unapplied.restart).be.empty();
    should(unapplied.warnings).be.empty();
  });

  it('should say the saved limits are not in force, and that launches now refuse', () => {
    // Arrange / Act
    const unapplied = evidence(parseStoredCgroupApplyStatus(status({ fleet: 'Failed to connect to bus' }), saved), [
      { sessionId: 's1', exempt: false },
    ]);

    // Assert — three facts at once: the document changed, the host has not got the numbers, and a
    // launch will refuse rather than quietly run uncapped.
    should(unapplied.restart).deepEqual(['s1']);
    should(unapplied.warnings.join(' ')).match(/are not in force on ferretry-fleet\.slice/u);
    should(unapplied.warnings.join(' ')).match(/fail-closed/u);
  });

  it('should keep a named unproven pane conservative after the ledger repairs', () => {
    // Arrange — the save had no safe pid or scope to bind to, so a later shape alone cannot prove
    // whether this is the old incarnation or a replacement.
    const unapplied = evidence(
      parseStoredCgroupApplyStatus(
        status({ unproven: [{ sessionId: 's1', failure: 'the pane incarnation could not be proved' }] }),
        saved,
      ),
      [{ sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', exempt: false }],
    );

    // Assert
    should(unapplied.restart).deepEqual(['s1']);
    should(unapplied.warnings.join(' ')).match(/last save could not prove a safe live pane/u);
  });

  it('should keep every governed pane conservative after an incomplete ledger scan', () => {
    // Arrange / Act
    const unapplied = evidence(
      parseStoredCgroupApplyStatus(status({ incomplete: 'the pane ledger could not be enumerated (EIO)' }), saved),
      [
        { sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', exempt: false },
        { sessionId: 'w1', exempt: true },
      ],
    );

    // Assert
    should(unapplied.restart).deepEqual(['s1']);
    should(unapplied.warnings.join(' ')).match(/could not be enumerated \(EIO\)/u);
  });

  it('should make a write-ahead record conservative for an identical-config interrupted save', () => {
    // Arrange / Act
    const unapplied = evidence(parseStoredCgroupApplyStatus(pendingCgroupApplyStatus(saved), saved), [
      { sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', exempt: false },
    ]);

    // Assert
    should(unapplied.restart).deepEqual(['s1']);
    should(unapplied.warnings.join(' ')).match(/did not finish recording/u);
  });
});

describe('converting percentages into what a host manager accepts', () => {
  it('should read a CPU percentage as a share of the WHOLE machine', () => {
    // Arrange / Act / Assert — 80% of eight CPUs is 640%, not 80%.
    should(unitLimits({ cpuPercent: 80, memoryPercent: 50 }, host()).cpuQuota).equal('640%');
  });

  it('should give memory as decimal bytes rather than a percentage', () => {
    // Arrange / Act
    const limits = unitLimits({ cpuPercent: 1, memoryPercent: 50 }, host({ memoryBytes: 1_000 }));

    // Assert
    should(limits.memoryMax).equal('500');
  });

  it('should never round a share down to a cap nothing can run inside', () => {
    // Arrange / Act
    const limits = unitLimits({ cpuPercent: 0.01, memoryPercent: 0.01 }, host({ cpus: 1, memoryBytes: 10 }));

    // Assert
    should(limits).deepEqual({ cpuQuota: '1%', memoryMax: '1' });
  });

  it('should report both levels against the same measured host', () => {
    // Arrange / Act
    const effective = effectiveCgroupLimits(
      { enabled: true, fleet: { cpuPercent: 90, memoryPercent: 90 }, perAgent: { cpuPercent: 25, memoryPercent: 25 } },
      host({ cpus: 4, memoryBytes: 1_000_000 }),
    );

    // Assert
    should(effective).deepEqual({
      cpus: 4,
      memoryBytes: 1_000_000,
      fleet: { cpuQuota: '360%', memoryMax: '900000' },
      perAgent: { cpuQuota: '100%', memoryMax: '250000' },
    });
  });

  it('should call a Linux host with the unified hierarchy supported', () => {
    // Arrange / Act / Assert
    should(cgroupsSupported(host())).be.true();
  });

  it('should refuse a platform whose user manager this daemon cannot ask', () => {
    // Arrange / Act / Assert
    should(cgroupsSupported(host({ platform: 'darwin' }))).be.false();
  });

  it('should refuse a Linux host that is not on the unified hierarchy', () => {
    // Arrange / Act / Assert
    should(cgroupsSupported(host({ unifiedHierarchy: false }))).be.false();
  });
});

describe('naming and recognising units', () => {
  it('should derive both names from the product scope rather than a literal', () => {
    // Arrange / Act / Assert
    should(FLEET_SLICE).equal('ferretry-fleet.slice');
    should(AGENT_SCOPE_PREFIX).equal('ferretry-agent-');
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
      '0::/user.slice/user-1000.slice/user@1000.service/ferretry-fleet.slice/ferretry-agent-s1-9f.scope';

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
    should(placedUnderSlice('0::/user@1000.service/ferretry-fleet.slice/x.scope', FLEET_SLICE)).be.true();
  });

  it('should prove a pid is outside the fleet slice when it is', () => {
    // Arrange / Act / Assert
    should(placedUnderSlice('0::/user@1000.service/app.slice/fyd.service', FLEET_SLICE)).be.false();
  });

  it('should treat the slice itself as under itself, so a leaf directly inside it still counts', () => {
    // Arrange / Act / Assert
    should(placedUnderSlice('0::/ferretry-fleet.slice', FLEET_SLICE)).be.true();
  });

  it('should ignore a line with no path when proving placement', () => {
    // Arrange / Act / Assert
    should(placedUnderSlice('no-path-here', FLEET_SLICE)).be.false();
  });

  it('should compose the aggregate property change as a runtime-only set-property', () => {
    // Arrange / Act
    const argv = slicePropertyCommand('a.slice', { cpuQuota: '640%', memoryMax: '99' });

    // Assert
    should(argv).deepEqual([
      'systemctl',
      '--user',
      'set-property',
      '--runtime',
      'a.slice',
      'CPUQuota=640%',
      'MemoryMax=99',
    ]);
  });

  it('should compose a transient collected scope under the fleet slice with both caps', () => {
    // Arrange / Act
    const argv = agentScopeCommand({
      scope: 'ferretry-agent-s1-ab.scope',
      slice: FLEET_SLICE,
      limits: { cpuQuota: '200%', memoryMax: '7' },
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
      '--property=CPUQuota=200%',
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
