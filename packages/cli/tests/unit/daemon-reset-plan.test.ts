import { describe, it } from 'bun:test';
import should from 'should';
import { resolveDaemonLayout } from '../../src/lib/daemon/layout.ts';
import {
  assertResettableRoots,
  renderResetOutcome,
  renderResetPlan,
  resetRoots,
  resetSurvivors,
  type ResetRoot,
} from '../../src/lib/daemon/reset.ts';

const layout = (platform: string) =>
  resolveDaemonLayout({
    platform,
    homeDirectory: '/home/ada',
    userId: 1000,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/usr/bin',
  });

const root = (path: string, label = 'state home'): ResetRoot => ({ label, holds: 'things', path });

describe('which directories a reset may remove', () => {
  it('names the state home and the installation artifacts of this host', () => {
    const [home, artifacts] = resetRoots(layout('linux'));
    should(home).containEql({ label: 'fyd state home', path: '/home/ada/.ferretry' });
    should(artifacts).containEql({ label: 'ferretry installation artifacts', path: '/home/ada/.local/state/ferretry' });
    assertResettableRoots(resetRoots(layout('linux')), '/home/ada');
  });

  it('refuses a path that is not normalized and absolute', () => {
    should(() => assertResettableRoots([root('relative/dir')], '/home/ada')).throw(
      'refusing to reset: the state home at relative/dir is not a normalized absolute path',
    );
    should(() => assertResettableRoots([root('/home/ada/../ada/x')], '/home/ada')).throw(
      /is not a normalized absolute path/u,
    );
  });

  it('refuses a directory too close to the filesystem root to be a Ferretry directory', () => {
    should(() => assertResettableRoots([root('/')], '/home/ada')).throw(/is too close to the filesystem root/u);
    should(() => assertResettableRoots([root('/ferretry')], '/home/ada')).throw(
      'refusing to reset: the state home at /ferretry is too close to the filesystem root to be a Ferretry directory',
    );
  });

  it('refuses the home directory itself, and any directory that holds it', () => {
    should(() => assertResettableRoots([root('/home/ada')], '/home/ada')).throw(
      'refusing to reset: the state home resolves to the home directory itself (/home/ada)',
    );
    should(() => assertResettableRoots([root('/home/ada/.')], '/home/ada/')).throw(/not a normalized absolute path/u);
    should(() => assertResettableRoots([root('/home/ada', 'x'), root('/srv/data')], '/home/ada/work')).throw(
      'refusing to reset: the x at /home/ada contains the home directory /home/ada/work',
    );
  });

  it('refuses two roots that are the same path, or one inside the other', () => {
    should(() =>
      assertResettableRoots([root('/srv/data/a', 'first'), root('/srv/data/a', 'second')], '/home/ada'),
    ).throw('refusing to reset: the first and the second are the same path (/srv/data/a)');
    should(() =>
      assertResettableRoots([root('/srv/data', 'outer'), root('/srv/data/inner', 'inner')], '/home/ada'),
    ).throw('refusing to reset: the outer at /srv/data contains the inner at /srv/data/inner');
  });
});

describe('what a reset tells the person before and after', () => {
  const measured = (files: number, bytes: number, escapingLinks: string[] = []) =>
    ({ kind: 'measured', files, bytes, escapingLinks }) as never;
  const absent = { kind: 'absent' } as never;

  it('spells out what survives, naming the service definition only on a host that has one', () => {
    should(resetSurvivors(layout('linux'))[1]).containEql('/.config/systemd/user/fyd.service');
    should(resetSurvivors(layout('darwin'))[1]).containEql('/Library/LaunchAgents/com.ferretry.fyd.plist');
    should(resetSurvivors(layout('freebsd'))).have.length(2);
  });

  it('prints every path with its size, the counts that cannot be recovered, and what survives', () => {
    const [home, artifacts] = resetRoots(layout('linux'));
    const text = renderResetPlan({
      daemon: 'fyd',
      surveys: [
        { root: home as ResetRoot, measure: measured(12, 3_400_000) },
        { root: artifacts as ResetRoot, measure: absent },
      ],
      inventory: { secrets: 2, devices: 1, ferrets: 3 },
      survivors: resetSurvivors(layout('linux')),
    });

    should(text).containEql('fyd reset will remove 2 path(s):');
    should(text).containEql('12 files, 3.4MB');
    should(text).containEql('absent — nothing to remove');
    should(text).containEql('2 secret(s) — the values, not just the names');
    should(text).containEql('1 paired device(s), each of which has to be paired again');
    should(text).containEql('3 ferret(s), with their transcripts');
    should(text).not.containEql('symbolic link');
  });

  it('says the counts are unavailable when the daemon is not running, and names every link that points out', () => {
    const [home, artifacts] = resetRoots(layout('linux'));
    const text = renderResetPlan({
      daemon: 'fyd',
      surveys: [
        { root: home as ResetRoot, measure: measured(1, 10, ['/home/ada/.ferretry/link -> /etc']) },
        { root: artifacts as ResetRoot, measure: absent },
      ],
      inventory: undefined,
      survivors: [],
    });

    should(text).containEql('fyd is not running,');
    should(text).containEql('so they cannot be counted; the paths and their sizes above are still exact');
    should(text).containEql('1 symbolic link(s) inside these paths point outside them.');
    should(text).containEql('  /home/ada/.ferretry/link -> /etc');
  });

  it('reports what the removal itself took, and the command that brings the daemon back', () => {
    const [home, artifacts] = resetRoots(layout('linux'));
    const text = renderResetOutcome(
      'fyd',
      [
        { root: home as ResetRoot, measure: measured(5, 2_000_000) },
        { root: artifacts as ResetRoot, measure: absent },
      ],
      'fy',
    );

    should(text.split('\n')).deepEqual([
      'fyd reset: removed 1 path(s), 5 files, 2.0MB',
      '  removed /home/ada/.ferretry',
      '  absent  /home/ada/.local/state/ferretry',
      'Run `fy daemon start` to bring fyd up on a clean slate, exactly as a fresh install does.',
    ]);
  });

  it('says nothing was removed when there was nothing on this host', () => {
    const [home] = resetRoots(layout('linux'));
    should(renderResetOutcome('fyd', [{ root: home as ResetRoot, measure: absent }], 'fy').split('\n')[0]).equal(
      'fyd had no persistent data on this host; nothing was removed',
    );
  });
});
