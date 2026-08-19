import { describe, it } from 'bun:test';
import should from 'should';
import type { ResetTreeMeasure } from '../../../src/lib/daemon/ports';
import {
  assertResettableRoots,
  type ResetPlan,
  ResetRefusedError,
  type ResetRoot,
  type ResetSurvey,
  renderResetOutcome,
  renderResetPlan,
  resetRoots,
  resetSurvivors,
} from '../../../src/lib/daemon/reset';
import { HOME, layout } from './fixtures';

/** A root shaped like the real ones, so a guard test names only the property it is about. */
function root(path: string, label = 'state home'): ResetRoot {
  return { label, holds: 'everything', path };
}

function measured(files: number, bytes: number, escapingLinks: readonly string[] = []): ResetTreeMeasure {
  return { kind: 'measured', files, bytes, escapingLinks };
}

function survey(path: string, measure: ResetTreeMeasure, label = 'state home'): ResetSurvey {
  return { root: root(path, label), measure };
}

function plan(overrides: Partial<ResetPlan> = {}): ResetPlan {
  return {
    daemon: 'fyd',
    surveys: [survey(`${HOME}/.ferretry`, measured(12, 1_400_000))],
    inventory: { secrets: 3, devices: 2, sessions: 7 },
    survivors: ['the installed fyd'],
    ...overrides,
  };
}

describe('the two roots a reset removes', () => {
  it('should derive both from the layout the daemon itself resolves', () => {
    // Act
    const roots = resetRoots(layout());

    // Assert — the state home, and the client-owned artifacts nobody looks in. The second one is the
    // whole reason this is a command: clearing only the first left an owner running a pinned daemon
    // from weeks earlier, because the executable lived here.
    should(roots.map(entry => entry.path)).deepEqual([`${HOME}/.ferretry`, `${HOME}/.local/state/ferretry`]);
    should(roots[0].label).equal('fyd state home');
    should(roots[1].label).equal('ferretry installation artifacts');
  });

  it('should follow a pinned FY_HOME and XDG_STATE_HOME rather than a home-derived literal', () => {
    // Arrange — the case a hardcoded `~/.ferretry` gets wrong: an operator has pinned both, so a reset
    // built from HOME and a literal would destroy an installation this client does not manage.
    const pinned = layout({ stateHome: '/srv/fy/home', stateDirectory: '/srv/fy/state' });

    // Act
    const roots = resetRoots(pinned);

    // Assert
    should(roots.map(entry => entry.path)).deepEqual(['/srv/fy/home', '/srv/fy/state/ferretry']);
  });

  it('should hold the same artifact root every other state-directory path is derived from', () => {
    // Assert — one derivation, so a fourth reader cannot be a fourth spelling. Every path the retiring
    // and pinning verbs address has to sit inside the tree the reset removes, or a reset would leave
    // one of them behind.
    const resolved = layout();
    should(resolved.legacySnapshotRoot.startsWith(`${resolved.stateArtifactRoot}/`)).be.true();
    should(resolved.nixGcRoot.startsWith(`${resolved.stateArtifactRoot}/`)).be.true();
    should(resolved.legacySnapshotGcRootDirectory.startsWith(`${resolved.stateArtifactRoot}/`)).be.true();
  });
});

describe('roots a reset refuses to touch', () => {
  it('should accept the roots a real layout resolves', () => {
    // Assert — the ordinary case has to pass, or every guard below is proving nothing.
    should(() => {
      assertResettableRoots(resetRoots(layout()), HOME);
    }).not.throw();
  });

  it('should refuse a root that is the home directory itself', () => {
    // Arrange — FY_HOME=$HOME is a typo somebody will make, and the cost of not catching it is every
    // file that person owns.
    const roots = [root(HOME), root(`${HOME}/.local/state/ferretry`, 'artifacts')];

    // Act + Assert
    should(() => {
      assertResettableRoots(roots, HOME);
    }).throw(ResetRefusedError, { message: /resolves to the home directory itself/ });
  });

  it('should refuse a root that contains the home directory', () => {
    // Arrange — one level up from home is not a Ferretry directory, and removing it takes home with it.
    const roots = [root('/tmp/outer/inner'), root('/var/lib/ferretry', 'artifacts')];

    // Act + Assert
    should(() => {
      assertResettableRoots(roots, '/tmp/outer/inner/home');
    }).throw(ResetRefusedError, { message: /contains the home directory/ });
  });

  it('should refuse a root too close to the filesystem root to be an installation', () => {
    // Arrange — not the filesystem root, and still nothing this ever creates.
    const roots = [root('/ferretry')];

    // Act + Assert
    should(() => {
      assertResettableRoots(roots, HOME);
    }).throw(ResetRefusedError, { message: /too close to the filesystem root/ });
  });

  it('should refuse a root whose meaning depends on where it is evaluated', () => {
    // Arrange — a path holding `..` is one a working directory can steer.
    const roots = [root(`${HOME}/state/../../elsewhere`)];

    // Act + Assert
    should(() => {
      assertResettableRoots(roots, HOME);
    }).throw(ResetRefusedError, { message: /is not a normalized absolute path/ });
  });

  it('should refuse a relative root', () => {
    // Act + Assert
    should(() => {
      assertResettableRoots([root('.ferretry')], HOME);
    }).throw(ResetRefusedError, { message: /is not a normalized absolute path/ });
  });

  it('should refuse two roots where one contains the other', () => {
    // Arrange — removing the outer removes the inner, so the preflight would have shown one tree twice
    // and destroyed more than either line claimed.
    const roots = [root(`${HOME}/.ferretry`), root(`${HOME}/.ferretry/state`, 'artifacts')];

    // Act + Assert
    should(() => {
      assertResettableRoots(roots, HOME);
    }).throw(ResetRefusedError, { message: /contains the artifacts at/ });
  });

  it('should refuse two roots that are the same path', () => {
    // Act + Assert
    should(() => {
      assertResettableRoots([root(`${HOME}/.ferretry`), root(`${HOME}/.ferretry`, 'artifacts')], HOME);
    }).throw(ResetRefusedError, { message: /are the same path/ });
  });
});

describe('what a reset says survives', () => {
  it('should name the service definition on a systemd host, because supervision stays installed', () => {
    // Assert — a reset that removed the unit would be a reinstall. `uninstall` is the verb for that.
    const survivors = resetSurvivors(layout());
    should(survivors.join('\n')).containEql(`${HOME}/.config/systemd/user/fyd.service`);
    should(survivors.join('\n')).containEql('supervision stays installed');
  });

  it('should name the launch agent on a launchd host', () => {
    should(resetSurvivors(layout({ platform: 'darwin' })).join('\n')).containEql(
      `${HOME}/Library/LaunchAgents/com.ferretry.fyd.plist`,
    );
  });

  it('should promise no definition on a host that has no service manager', () => {
    // Assert — nothing to keep, so nothing is claimed. A survivor list that named a file the platform
    // never creates would be the one part of this output somebody could catch being wrong.
    const survivors = resetSurvivors(layout({ platform: 'freebsd' }));
    should(survivors).have.length(2);
    should(survivors.join('\n')).not.containEql('service definition');
  });

  it('should always keep the installed executables and everything outside the two paths', () => {
    const survivors = resetSurvivors(layout()).join('\n');
    should(survivors).containEql('the installed fyd and client executables');
    should(survivors).containEql('every repository and worktree a session was working in');
  });
});

describe('the preflight a person reads before confirming', () => {
  it('should print every path, what it holds, and its size', () => {
    // Act
    const text = renderResetPlan(plan());

    // Assert
    should(text).containEql('fyd reset will remove 1 path(s):');
    should(text).containEql(`${HOME}/.ferretry`);
    should(text).containEql('12 files, 1.4MB');
  });

  it('should count what cannot be recovered, so somebody can abort on a number they did not know', () => {
    // Assert — "2 paired device(s)" is the fact this whole preflight exists for: it is not available
    // from any other command, and it is what makes a confirmation a decision.
    const text = renderResetPlan(plan());
    should(text).containEql('3 secret(s) — the values, not just the names');
    should(text).containEql('2 paired device(s), each of which has to be paired again');
    should(text).containEql('7 session(s), with their transcripts');
    should(text).containEql('the operator password, so this machine has none afterwards');
  });

  it('should say the counts are unavailable rather than guess when the daemon is down', () => {
    // Arrange — the daemon owns those counts and it is not answering. Counting files behind its back
    // would be the read the package split forbids, and a guess would be worse than a blank.
    const text = renderResetPlan(plan({ inventory: undefined }));

    // Assert
    should(text).containEql('fyd is not running,');
    should(text).containEql('so they cannot be counted; the paths and their sizes above are still exact');
    should(text).not.containEql('secret(s) —');
  });

  it('should report an absent path as absent rather than as an empty one', () => {
    // Arrange — every host that installed after the snapshot store was retired has no artifact tree,
    // and that is normal rather than an error.
    const text = renderResetPlan(plan({ surveys: [survey('/var/lib/ferretry', { kind: 'absent' }, 'artifacts')] }));

    // Assert
    should(text).containEql('absent — nothing to remove');
  });

  it('should name every link that points out of the tree, since nothing follows one', () => {
    // Arrange — FY_HOME allows exactly one link of its own, and a link into somebody's real data must
    // cost them the link and nothing else. Naming them is how that stops being a claim.
    const text = renderResetPlan(
      plan({
        surveys: [survey(`${HOME}/.ferretry`, measured(4, 40, ['fleet/homes/a -> /mnt/data/real', 'x -> /etc']))],
      }),
    );

    // Assert
    should(text).containEql('2 symbolic link(s) inside these paths point outside them');
    should(text).containEql('NOTHING it points at is read, followed or removed');
    should(text).containEql('fleet/homes/a -> /mnt/data/real');
  });

  it('should say nothing about links when there are none', () => {
    should(renderResetPlan(plan())).not.containEql('symbolic link(s)');
  });

  it('should state what survives, so somebody knows what they still have', () => {
    should(renderResetPlan(plan({ survivors: ['the installed fyd', 'your repositories'] }))).containEql(
      'It does NOT touch:\n  the installed fyd\n  your repositories',
    );
  });
});

describe('what a completed reset reports', () => {
  it('should total the removals it actually performed and name the command that comes next', () => {
    // Act
    const text = renderResetOutcome(
      'fyd',
      [survey('/a/state', measured(10, 2_000_000)), survey('/a/artifacts', measured(5, 1_000_000), 'artifacts')],
      'fy',
    );

    // Assert — the removal's own numbers, not the preflight's: the preflight measured a daemon that was
    // still writing, so reporting those as the outcome would report a count nobody took.
    should(text).containEql('fyd reset: removed 2 path(s), 15 files, 3.0MB');
    should(text).containEql('  removed /a/state');
    should(text).containEql('Run `fy daemon start` to bring fyd up on a clean slate');
    should(text).containEql('offer to set this');
  });

  it('should mark an absent path as absent and leave it out of the total', () => {
    // Act
    const text = renderResetOutcome(
      'fyd',
      [survey('/a/state', measured(10, 2_000_000)), survey('/a/gone', { kind: 'absent' }, 'artifacts')],
      'fy',
    );

    // Assert
    should(text).containEql('removed 1 path(s), 10 files, 2.0MB');
    should(text).containEql('  absent  /a/gone');
  });

  it('should say plainly that there was nothing to remove rather than claim a reset', () => {
    // Assert — a second reset, or a host that never started the daemon. Reporting "removed 0 paths,
    // 0 files, 0.0MB" would read as a reset having happened.
    should(renderResetOutcome('fyd', [survey('/a/gone', { kind: 'absent' })], 'fy')).containEql(
      'fyd had no persistent data on this host; nothing was removed',
    );
  });
});
