import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileResumeTurnStore } from '../../../../../daemon/adapters/session/resume/file-resume-turn-store.ts';
import { InMemoryLaunchGate } from '../../../../../daemon/adapters/session/resume/in-memory-launch-gate.ts';
import { NoMonitorSupervision } from '../../../../../daemon/adapters/session/resume/no-monitor-supervision.ts';
import { StorageResumeRepository } from '../../../../../daemon/adapters/session/resume/storage-resume-repository.ts';
import {
  type ResumeLaunchSpec,
  TmuxResumeLauncher,
} from '../../../../../daemon/adapters/session/resume/tmux-resume-launcher.ts';
import { SessionStateFiles } from '../../../../../daemon/lib/state.ts';
import type { SessionLaunchInstructions } from '../../../../../daemon/lib/protocol/session.ts';
import type { SessionCredentialRotator } from '../../../../../daemon/lib/session/lifecycle/types.ts';
import type {
  AccountLaunchEnvironment,
  AccountLaunchRenewal,
} from '../../../../../daemon/lib/session/peers/fleet.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { FakePaneDelivery, FakeTmux } from '../../../../support/daemon/fake-tmux.ts';
import { memoryStorage, sessionConfig, sessionState } from '../../../../support/daemon/storage.ts';

const homes = new Set<string>();
const ID = parseSessionId('session-1');
const PANE = 'fy-session-1';

async function temporaryDirectory(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-resume-test-'));
  homes.add(home);
  return home;
}

/** A configuration the declared schema accepts, as the start wrote it. */
function config(id = 'session-1', overrides: Record<string, unknown> = {}) {
  return sessionConfig(id, { name: 'Revive me', cwd: '/workspace/project', mode: 'auto', turn: 3, ...overrides });
}

/** A pending question the declared schema accepts. */
const QUESTION = { toolUseId: 'tool-1', questions: [{ question: 'Which branch?' }] };

/**
 * The terminals plugin's controller and delivery as the launcher sees them (the injected ports), with the
 * session's pane already open and showing its last frame.
 */
function panes() {
  const tmux = new FakeTmux();
  tmux.open(PANE, { visible: 'the last frame\n> ' });
  return { tmux, delivery: new FakePaneDelivery(tmux) };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('resume turn store', () => {
  it('should write a numbered turn document atomically inside the session directory', async () => {
    // Arrange
    const home = await temporaryDirectory();
    const store = new FileResumeTurnStore(() => join(home, 'sessions', 'session-1'));

    // Act
    const file = await store.writeTurn(ID, 4, 'Continue the assigned task.\n');

    // Assert
    should(file).endWith('turns/turn-004.md');
    should(await readFile(file, 'utf8')).equal('Continue the assigned task.\n');
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('should remove stale completion markers, and tolerate ones that were never written', async () => {
    // Arrange — a `done` marker from the previous turn would end the new turn the moment it starts.
    const home = await temporaryDirectory();
    const directory = join(home, 'sessions', 'session-1');
    const store = new FileResumeTurnStore(() => directory);
    await store.writeTurn(ID, 4, 'anything');
    await writeFile(join(directory, 'done.marker'), 'done', 'utf8');

    // Act
    await store.clearMarkers(ID);
    await store.clearMarkers(ID);

    // Assert
    await should(stat(join(directory, 'done.marker'))).be.rejected();
  });
});

describe('storage resume repository', () => {
  it('should read a durable session as a resume target', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(
      ID,
      config('session-1', {
        label: 'my-batch',
        retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
      }),
    );
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', turn: 3, retryAttempt: 1 }));

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).deepEqual({
      id: ID,
      status: 'stopped',
      mode: 'auto',
      cwd: '/workspace/project',
      label: 'my-batch',
      turn: 3,
      retryAttempt: 1,
      transientRetryBudget: 2,
    });
  });

  it('should take the turn from the document that actually moves', async () => {
    // Both documents carry a turn and only the STATE's is ever updated: a revive records the turn it
    // handed over through `transition({ turn })`, and nothing rewrites the configuration's copy.
    // Reading the configuration first froze every session at the turn it was created on, so the
    // SECOND revive planned the same number again and overwrote the first revive's assignment.
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', turn: 7 }));

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).have.property('turn', 7);
  });

  it('should report nothing for a session that was never written', async () => {
    // Arrange
    const opened = await memoryStorage();

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).be.undefined();
  });

  it('should refuse to guess at a record whose status or mode will not parse', async () => {
    // Arrange — resume replaces terminals, so acting on a record it could not read is the one
    // mistake that costs an operator a live agent. A blank working directory passes the stored schema
    // and is still no place to relaunch in; a status the protocol does not define is refused by the store.
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config('session-1', { cwd: '   ' }));
    await opened.storage.writeState(ID, sessionState('session-1'));
    const other = parseSessionId('session-2');
    await opened.storage.writeConfig(other, config('session-2'));
    await opened.storage.writeState(other, sessionState('session-2'));
    opened.folder.plant(SessionStateFiles, JSON.stringify(sessionState('session-2', { status: 'transcending' })), other);
    const repository = new StorageResumeRepository(opened.storage);

    // Act
    const blank = await repository.read(ID);

    // Assert — no target is guessed at either way.
    should(blank).be.undefined();
    await should(repository.read(other)).be.rejected();
  });

  it('should carry a pending question through, and none for a cleared one', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(
      ID,
      sessionState('session-1', { pendingQuestion: QUESTION, needsHumanKind: 'picker_cleanup' }),
    );
    const other = parseSessionId('session-2');
    await opened.storage.writeConfig(other, config('session-2'));
    await opened.storage.writeState(other, sessionState('session-2', { pendingQuestion: null }));

    // Act
    const repository = new StorageResumeRepository(opened.storage);
    const actual = [await repository.read(ID), await repository.read(other)];

    // Assert
    should(actual[0]?.pendingQuestion).deepEqual({ toolUseId: 'tool-1' });
    should(actual[0]?.needsHumanKind).equal('picker_cleanup');
    should(actual[1]?.pendingQuestion).be.undefined();
  });

  it('should list every readable session and silently skip the unreadable ones', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, sessionState('session-1'));
    const broken = parseSessionId('session-2');
    await opened.storage.writeConfig(broken, config('session-2'));
    await opened.storage.writeState(broken, sessionState('session-2'));
    opened.folder.plant(SessionStateFiles, JSON.stringify(sessionState('session-2', { status: 'nonsense' })), broken);

    // Act
    const actual = await new StorageResumeRepository(opened.storage).list();

    // Assert
    should(actual.map(item => item.id)).deepEqual(['session-1']);
  });

  it('should write the state before it journals the event that describes it', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', needsHumanKind: 'picker_cleanup' }));

    // Act
    const actual = await new StorageResumeRepository(opened.storage).transition(ID, {
      event: 'session.resumed',
      status: 'running',
      retryAttempt: 0,
      reason: 'revived by an operator',
      clearNeedsHuman: true,
    });

    // Assert
    should(actual.status).equal('running');
    should(actual.needsHumanKind).be.undefined();
    should(actual.retryAttempt).equal(0);
    const state = (await opened.storage.readState(ID)) as Record<string, unknown>;
    should(state.reason).equal('revived by an operator');
  });

  it('should replace the launch record on a relaunch and keep it through a transition that launched nothing', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    const before: SessionLaunchInstructions = { sections: [{ id: 'tools', chars: 10 }], mode: 'auto', questions: false };
    const after: SessionLaunchInstructions = {
      sections: [
        { id: 'tools', chars: 10 },
        { id: 'pack', chars: 20 },
      ],
      mode: 'auto',
      questions: false,
    };
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', launchInstructions: before }));
    const repository = new StorageResumeRepository(opened.storage);

    // Act
    await repository.transition(ID, { event: 'session.resuming', status: 'starting' });
    const kept = (await opened.storage.readState(ID)) as Record<string, unknown>;
    await repository.transition(ID, { event: 'session.resumed', status: 'running', launchInstructions: after });
    const replaced = (await opened.storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should(kept.launchInstructions).deepEqual(before);
    should(replaced.launchInstructions).deepEqual(after);
  });

  it('should clear a pending question on the transition that abandons it', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', pendingQuestion: QUESTION }));

    // Act
    const actual = await new StorageResumeRepository(opened.storage).transition(ID, {
      event: 'session.question_cancelled',
      clearPendingQuestion: true,
      data: { abandoned: true },
    });

    // Assert
    should(actual.pendingQuestion).be.undefined();
  });

  it('should refuse to report success for a transition it can no longer read back', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config('session-1', { cwd: '   ' }));
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped' }));

    // Act / Assert
    await should(
      new StorageResumeRepository(opened.storage).transition(ID, { event: 'session.resumed', status: 'running' }),
    ).be.rejectedWith(/unreadable after a resume transition/u);
  });
});

describe('tmux resume launcher', () => {
  const SPEC: ResumeLaunchSpec = {
    tmuxSession: PANE,
    mode: 'auto',
    cwd: '/workspace/project',
    command: ['/opt/fleet/bin/agent'],
  };

  function launcher(
    tmux: FakeTmux,
    delivery = new FakePaneDelivery(tmux),
    snapshots?: { write(id: string, text: string): Promise<void> },
  ) {
    return new TmuxResumeLauncher(tmux, async () => SPEC, delivery, snapshots);
  }

  it('should observe a live prompt-ready pane', async () => {
    // Arrange
    const { tmux } = panes();

    // Act
    const actual = await launcher(tmux).observe(ID);

    // Assert
    should(actual).deepEqual({ alive: true, dead: false, promptReady: true });
  });

  it('should capture the final frame before the pane is destroyed', async () => {
    // Arrange
    const { tmux } = panes();
    const writes: Array<readonly [string, string]> = [];
    const subject = launcher(tmux, undefined, { write: async (id, text) => void writes.push([id, text]) });

    // Act
    await subject.snapshot(ID);

    // Assert
    should(writes).have.length(1);
    should(writes[0]?.[0]).equal(ID);
    should(writes[0]?.[1]).containEql('the last frame');
  });

  it('should address only this session name when it kills or relaunches', async () => {
    // Arrange
    const { tmux } = panes();
    const subject = launcher(tmux);

    // Act
    await subject.kill(ID, 'cleanup before resume');
    await subject.relaunch(ID);

    // Assert
    const addressed = tmux.calls
      .flat()
      .filter((argument): argument is string => typeof argument === 'string' && argument.startsWith('fy-'));
    should(new Set(addressed)).deepEqual(new Set([PANE]));
    should(tmux.methods()).deepEqual(['stop', 'launch']);
  });

  it('should hand the replacement pane the session identity and the environment it already had', async () => {
    // A PANE READS ITS ENVIRONMENT AT LAUNCH, so whatever a revive omits is gone for the rest of that
    // incarnation. This path passed no environment at all: a revived teammate lost its board
    // capability, and — with `FY_SESSION_ID` now the way an agent names itself — would have come back
    // unable to attribute a single message, which reads as the peer having gone quiet rather than as a
    // relaunch defect. The identity is derived from the id, so it survives an absent spec environment.
    // Arrange
    const tmux = new FakeTmux();
    const withStoredEnvironment = new TmuxResumeLauncher(
      tmux,
      async () => ({ ...SPEC, env: { FY_SESSION_BOARD_CAPABILITY: 'stored-secret' } }),
      new FakePaneDelivery(tmux),
    );

    // Act
    await withStoredEnvironment.relaunch(ID);
    // The same revive for a session that has no stored environment at all, which is the normal case.
    await launcher(tmux).relaunch(ID);

    // Assert
    const launches = tmux.launches;
    should(launches).have.length(2);
    should(launches[0]?.env).containEql({ FY_SESSION_BOARD_CAPABILITY: 'stored-secret', FY_SESSION_ID: ID });
    should(launches[1]?.env).containEql({ FY_SESSION_ID: ID });
    should(launches[1]?.command).deepEqual(['/opt/fleet/bin/agent']);
  });

  it('should relaunch with the hypermedia default of the session mode, and let a stored switch win', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const revive = async (mode: 'auto' | 'interactive', env: Record<string, string>) => {
      await new TmuxResumeLauncher(tmux, async () => ({ ...SPEC, env, mode }), new FakePaneDelivery(tmux)).relaunch(ID);
    };

    // Act
    await revive('interactive', {});
    await revive('auto', {});
    await revive('auto', { FY_HYPERMEDIA: '1' });

    // Assert
    should(tmux.launches.map(launch => launch.env?.FY_HYPERMEDIA)).deepEqual(['1', '0', '1']);
  });

  it('should answer what the replacement pane was told when it knows the binary name, and nothing otherwise', async () => {
    // Arrange — what the pane was told is the runtimes plugin's to render (the injected `describe`); the
    // launcher's part is asking it with the binary name and the very environment the pane launched with.
    const tmux = new FakeTmux();
    const asked: { readonly fy: string; readonly env: Readonly<Record<string, string>> }[] = [];
    const named = new TmuxResumeLauncher(
      tmux,
      async () => ({
        ...SPEC,
        env: { FY_SESSION_MODE: 'interactive', FY_LEARNING_PASSIVE: '1' },
        mode: 'interactive',
      }),
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'zz',
      undefined,
      (fy, env) => {
        asked.push({ fy, env });
        return { sections: [{ id: 'tools', chars: 1 }], mode: 'interactive', questions: true };
      },
    );

    // Act
    const told = await named.relaunch(ID);
    const untold = await launcher(tmux).relaunch(ID);

    // Assert
    should(told).deepEqual({ sections: [{ id: 'tools', chars: 1 }], mode: 'interactive', questions: true });
    should(asked).have.length(1);
    should(asked[0]?.fy).equal('zz');
    should(asked[0]?.env).deepEqual(tmux.launches[0]?.env);
    should(untold).be.undefined();
  });

  it('should relaunch with the argv built at launch rather than the one recorded', async () => {
    // A revive used to REPLAY the recorded argv, so whatever the daemon learned to put on a launch
    // since — a Read rule, the model the owner switched to — never reached the replacement process.
    // Arrange
    const { tmux } = panes();
    const built: string[] = [];
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => ({
        ...SPEC,
        command: ['/opt/fleet/bin/agent', '--model', 'recorded'],
        relaunch: async () => {
          built.push('built');
          return ['/opt/fleet/bin/agent', '--model', 'current'];
        },
      }),
      new FakePaneDelivery(tmux),
    );

    // Act — only the relaunch builds; reading the pane must not record a launch that never happened.
    await subject.observe(ID);
    await subject.relaunch(ID);

    // Assert
    should(built).deepEqual(['built']);
    should(tmux.launches[0]?.command).deepEqual(['/opt/fleet/bin/agent', '--model', 'current']);
  });

  it('should refuse to relaunch a session whose command is empty', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const subject = new TmuxResumeLauncher(tmux, async () => ({ ...SPEC, command: [] }), new FakePaneDelivery(tmux));

    // Act / Assert
    await should(subject.relaunch(ID)).be.rejectedWith(/empty command/u);
    should(tmux.launches).be.empty();
  });

  it('should hand the turn to the session’s own pane through the delivery the launch path uses', async () => {
    // Arrange
    const { tmux, delivery } = panes();

    // Act
    await launcher(tmux, delivery).deliver(ID, 'read your new turn');

    // Assert
    should(delivery.delivered).deepEqual([{ session: PANE, text: 'read your new turn' }]);
  });

  it('should confirm an exit only when the pane itself agrees the harness is gone', async () => {
    // Arrange
    const alive = panes().tmux;
    const gone = new FakeTmux();

    // Act
    const actual = [await launcher(alive).confirmExit(ID), await launcher(gone).confirmExit(ID)];

    // Assert
    should(actual[0]?.confirmed).be.false();
    should(actual[0]?.pane.promptReady).be.true();
    should(actual[1]?.confirmed).be.true();
  });

  it('should assume the harness is gone when even the probe fails', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => {
        throw new Error('config is unreadable');
      },
      new FakePaneDelivery(tmux),
    );

    // Act
    const actual = await subject.confirmExit(ID);

    // Assert
    should(actual).deepEqual({ confirmed: true, pane: { alive: false, dead: true, promptReady: false } });
  });
});

describe('in-memory launch gate', () => {
  it('should report a registered launch as in flight until it is released', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);

    // Act
    const registration = gate.register(ID);
    const during = gate.launching(ID);
    registration.release();

    // Assert
    should(during).be.true();
    should(gate.launching(ID)).be.false();
  });

  it('should answer immediately for a session with no launch in flight', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);

    // Act
    const actual = await gate.awaitSettled(ID, 50);

    // Assert
    should(actual).be.true();
  });

  it('should report that a launch did not settle within the budget', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 5);
    gate.register(ID);

    // Act
    const actual = await gate.awaitSettled(ID, 20);

    // Assert
    should(actual).be.false();
  });

  it('should resolve once the launch settles mid-wait', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);
    const registration = gate.register(ID);

    // Act
    const settled = gate.awaitSettled(ID, 1_000);
    registration.release();

    // Assert
    should(await settled).be.true();
  });

  it('should ignore a late release from a registration that was already superseded', async () => {
    // Arrange
    const gate = new InMemoryLaunchGate(async () => {}, 1);
    const first = gate.register(ID);
    const second = gate.register(ID);

    // Act
    first.release();

    // Assert
    should(gate.launching(ID)).be.true();
    second.release();
    should(gate.launching(ID)).be.false();
  });
});

describe('unmounted monitor supervision', () => {
  it('should be a genuine no-op, since there is no monitor to arm or disarm', async () => {
    // Arrange
    const monitors = new NoMonitorSupervision();

    // Act / Assert
    await should(monitors.stop()).be.fulfilled();
    await should(monitors.start()).be.fulfilled();
  });
});

/**
 * A revive of an account a profile authenticates.
 *
 * The launch path resolves the profile per launch; so must this one. A replacement pane that came
 * back with no credential is a working agent destroyed by its own recovery — the harsher form of the
 * board-capability loss the case above exists for.
 */
describe('the resume launcher and a profile-authenticated account', () => {
  const profile = (env: Readonly<Record<string, string>>): AccountLaunchEnvironment => ({
    forWrapper: async () => env,
  });
  const SPEC: ResumeLaunchSpec = {
    tmuxSession: PANE,
    mode: 'auto',
    cwd: '/workspace/project',
    command: ['/opt/fleet/bin/agent'],
  };

  it('should hand the replacement the credential the account has now', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => ({ ...SPEC, env: { FY_SESSION_BOARD_CAPABILITY: 'stored-secret' }, agent: '/opt/fleet/bin/agent' }),
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      profile({ ANTHROPIC_API_KEY: 'fixture-value' }),
    );

    // Act
    await subject.relaunch(ID);

    // Assert — both halves, and the session's own still there.
    should(tmux.launches[0]?.env).containEql({
      ANTHROPIC_API_KEY: 'fixture-value',
      FY_SESSION_BOARD_CAPABILITY: 'stored-secret',
      FY_SESSION_ID: ID,
    });
  });

  it('should hand the replacement the same media folder and question file', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => SPEC,
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async id => ({
        media: `/state/sessions/${id}/media`,
        questionAsked: `/state/sessions/${id}/question-asked.json`,
      }),
    );

    // Act
    await subject.relaunch(ID);

    // Assert
    should(tmux.launches[0]?.env).containEql({
      FY_MEDIA_DIR: `/state/sessions/${ID}/media`,
      FY_QUESTION_FILE: `/state/sessions/${ID}/question-asked.json`,
    });
  });

  it('should let the session keep its own variable when a profile names the same one', async () => {
    // Arrange — a profile is shared by every account that lists it; a board capability is not.
    const tmux = new FakeTmux();
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => ({
        ...SPEC,
        env: { FY_SESSION_BOARD_CAPABILITY: 'this-session-only' },
        agent: '/opt/fleet/bin/agent',
      }),
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      profile({ FY_SESSION_BOARD_CAPABILITY: 'from-the-profile' }),
    );

    // Act
    await subject.relaunch(ID);

    // Assert
    should(tmux.launches[0]?.env?.FY_SESSION_BOARD_CAPABILITY).equal('this-session-only');
  });

  it('should ask for nothing when the spec cannot name the executable', async () => {
    // Arrange
    const tmux = new FakeTmux();
    let asked = 0;
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => SPEC,
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        forWrapper: async () => {
          asked += 1;
          return {};
        },
      },
    );

    // Act
    await subject.relaunch(ID);

    // Assert
    should(asked).equal(0);
  });

  it('should let a refused profile take the revive down rather than revive without a credential', async () => {
    // Arrange
    const tmux = new FakeTmux();
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => ({ ...SPEC, agent: '/opt/fleet/bin/agent' }),
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        forWrapper: async () => {
          throw new Error('this daemon holds no secret named WORK_KEY');
        },
      },
    );

    // Act & Assert
    await should(subject.relaunch(ID)).be.rejectedWith(/no secret named WORK_KEY/u);
    should(tmux.launches).be.empty();
  });
});

/**
 * A revive and the account's chance to renew before the replacement runs it.
 *
 * A revive IS a launch: something a person set in motion is being kept alive, so the same attended
 * rule applies and the same two obligations do — before the pane, and never instead of it.
 */
describe('the resume launcher and a credential that can renew itself', () => {
  const reviving = (spec: Partial<ResumeLaunchSpec>, accountRenewal: AccountLaunchRenewal) => {
    const tmux = new FakeTmux();
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => ({
        tmuxSession: PANE,
        mode: 'auto',
        cwd: '/workspace/project',
        command: ['/opt/fleet/bin/agent'],
        ...spec,
      }),
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      accountRenewal,
    );
    return { tmux, subject };
  };

  it('should give the account its turn before the replacement pane exists', async () => {
    // Arrange
    const asked: string[] = [];
    const { tmux, subject } = reviving(
      { agent: '/opt/fleet/bin/agent' },
      {
        beforeLaunch: async wrapper => {
          asked.push(`${wrapper} @ ${String(tmux.launches.length)}`);
        },
      },
    );

    // Act
    await subject.relaunch(ID);

    // Assert — asked once, about this account, while no replacement had been started yet.
    should(asked).deepEqual(['/opt/fleet/bin/agent @ 0']);
    should(tmux.launches).have.length(1);
  });

  it('should ask for nothing when the spec cannot name the executable', async () => {
    // Arrange — the same rule the profile lookup follows: a spec with no executable names no account,
    // so there is nothing to renew and no fleet to read looking for one.
    let asked = 0;
    const { tmux, subject } = reviving(
      {},
      {
        beforeLaunch: async () => {
          asked += 1;
        },
      },
    );

    // Act
    await subject.relaunch(ID);

    // Assert
    should(asked).equal(0);
    should(tmux.launches).have.length(1);
  });
});

/**
 * A revive and the session's own credential.
 *
 * A replacement pane is a new launch, so it is handed a credential the replaced pane never held: a
 * copy that leaked from the old pane stops authenticating with it. Only `relaunch` rotates — a read
 * that merely addresses the pane must never change what a live agent authenticates with.
 */
describe('the resume launcher and a credential issued per launch', () => {
  const rotating = (rotate: SessionCredentialRotator['rotate']) => {
    const tmux = new FakeTmux();
    const order: string[] = [];
    let stored: Readonly<Record<string, string>> = { FY_SESSION_BOARD_CAPABILITY: 'replaced-pane-capability' };
    const subject = new TmuxResumeLauncher(
      tmux,
      async () => {
        order.push('spec');
        return {
          tmuxSession: PANE,
          mode: 'auto',
          cwd: '/workspace/project',
          command: ['/opt/fleet/bin/agent'],
          env: stored,
        };
      },
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        rotate: async id => {
          order.push(`rotate:${id}`);
          const hash = await rotate(id);
          stored = { FY_SESSION_BOARD_CAPABILITY: 'replacement-capability' };
          return hash;
        },
      },
    );
    return { tmux, order, subject };
  };

  it('should re-issue the credential before the replacement pane reads its environment', async () => {
    // Arrange
    const { tmux, order, subject } = rotating(async () => 'f'.repeat(64));

    // Act
    await subject.relaunch(ID);

    // Assert
    should(tmux.launches).have.length(1);
    should(tmux.launches[0]?.env?.FY_SESSION_BOARD_CAPABILITY).equal('replacement-capability');
    should(JSON.stringify(tmux.launches[0])).not.containEql('replaced-pane-capability');
    should(order[0]).equal(`rotate:${ID}`);
  });

  it('should never rotate when it only observes, captures or kills the pane', async () => {
    // Arrange — the reads a daemon restart, a monitor and a stop make of a pane that keeps running.
    const { tmux, order, subject } = rotating(async () => 'f'.repeat(64));
    tmux.open(PANE);

    // Act
    await subject.observe(ID);
    await subject.snapshot(ID);
    await subject.kill(ID, 'cleanup before resume');

    // Assert
    should(order.filter(step => step.startsWith('rotate:'))).deepEqual([]);
  });

  it('should launch nothing when the credential cannot be re-issued', async () => {
    // Arrange
    const { tmux, subject } = rotating(async () => {
      throw new Error('the environment could not be made durable');
    });

    // Act + Assert
    await should(subject.relaunch(ID)).be.rejectedWith('the environment could not be made durable');
    should(tmux.launches).have.length(0);
  });
});

describe('tmux resume launcher › recording the replacement pane’s identity', () => {
  function subject(failures: number, unkillable = false) {
    const tmux = new FakeTmux();
    // A stop that fails is a replacement that cannot be named and cannot be removed either.
    if (unkillable) tmux.failures.set('stop', 'no permission');
    const registrations: string[] = [];
    let remaining = failures;
    // The SHIPPED retry policy, deliberately not overridden: the bound this daemon actually applies
    // is part of what these tests are about, and a fake one would prove a policy nothing runs.
    const launcher = new TmuxResumeLauncher(
      tmux,
      async () => ({ tmuxSession: PANE, mode: 'auto', cwd: '/workspace/project', command: ['/opt/agent'] }),
      new FakePaneDelivery(tmux),
      undefined,
      undefined,
      {
        registerSession: async (_id, tmuxSession) => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Error('tmux has not proved the pane');
          }
          registrations.push(tmuxSession);
        },
      },
    );
    return { tmux, launcher, registrations };
  }

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  it('should retry a registration that lost the race with the pane it is about', async () => {
    // Arrange — both ways this write fails are races with the launch that just happened.
    const { tmux, launcher, registrations } = subject(2);

    // Act
    await launcher.relaunch(ID);

    // Assert — the identity names the replacement, and no pane was thrown away over a race.
    should(registrations).deepEqual([PANE]);
    should(tmux.methods()).not.containEql('stop');
  });

  it('should tear the replacement down and FAIL when its identity cannot be recorded at all', async () => {
    // Arrange — a live pane nothing can name is worse than no pane.
    const { tmux, launcher, registrations } = subject(Number.POSITIVE_INFINITY);

    // Act
    const failure = await launcher.relaunch(ID).then(() => undefined, message);

    // Assert
    should(failure).match(/could not be registered \(tmux has not proved the pane\)/u);
    should(failure).match(/the unregistered replacement pane was killed/u);
    should(registrations).be.empty();
    should(tmux.methods()).containEql('stop');
    should(tmux.panes.has(PANE)).be.false();
  });

  it('should say so when it could not even kill the replacement it cannot name', async () => {
    // Arrange
    const { launcher } = subject(Number.POSITIVE_INFINITY, true);

    // Act
    const failure = await launcher.relaunch(ID).then(() => undefined, message);

    // Assert — the worst state this daemon can be in must not be the quietest one.
    should(failure).match(/could not be killed either \(no permission\)/u);
  });
});
