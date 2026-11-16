import { expect, test } from 'bun:test';
import { DoctorReportSchema } from '../../../contract/doctor.ts';
import { doctorReport } from '../../../host/doctor-report.ts';
import { hostProgramLines } from '../../../host/doctor-programs.ts';

/** A host whose PATH holds exactly the programs named (each at /usr/bin/<name>). */
const hostWith =
  (present: readonly string[]) =>
  async (name: string): Promise<string | undefined> =>
    present.includes(name) ? `/usr/bin/${name}` : undefined;

const EVERYTHING = ['bash', 'git', 'systemctl', 'launchctl', 'cat', 'tail', 'ps', 'nix-store', 'jq', 'gh'];

test('V-0257 the host program rows are v4’s inventory, in v4’s order, each naming the path it found', async () => {
  const lines = await hostProgramLines({ which: hostWith(EVERYTHING), platform: 'linux', binary: 'fy' });
  expect(lines.map(line => line.name)).toEqual([
    'bash',
    'git',
    'launchctl',
    'systemctl',
    'cat',
    'tail',
    'ps',
    'nix-store',
    'jq',
    'gh',
  ]);
  const bash = lines.find(line => line.name === 'bash');
  expect(bash).toMatchObject({
    plugin: 'kernel',
    state: 'ok',
    requirement: 'required',
    detail: 'found on PATH at /usr/bin/bash',
    fix: 'Generated fleet wrappers cannot run.',
  });
});

test('V-0257 a missing required program fails; a missing capability or optional one is a warning that names what it breaks', async () => {
  const lines = await hostProgramLines({ which: hostWith(['systemctl']), platform: 'linux', binary: 'fy' });
  const by = (name: string) => lines.find(line => line.name === name);
  expect(by('bash')).toMatchObject({
    state: 'fail',
    requirement: 'required',
    detail: 'not found on PATH',
    fix: 'Generated fleet wrappers cannot run.',
  });
  expect(by('git')).toMatchObject({
    state: 'warn',
    requirement: 'capability',
    fix: 'Worktrees, project inspection, and repository features are unavailable.',
  });
  expect(by('gh')).toMatchObject({
    state: 'warn',
    requirement: 'optional',
    fix: "The board's GitHub watcher cannot read PR state, link PRs or find releases; cards keep their PR state unknown.",
  });
  expect(by('jq')).toMatchObject({ requirement: 'optional' });
  expect(by('nix-store')).toMatchObject({ requirement: 'optional' });
  expect(by('cat')?.fix).toBe('`fy daemon logs` cannot print the current log without following it.');
  expect(by('tail')?.fix).toBe('`fy daemon logs --follow` cannot stream the daemon log.');
  expect(by('ps')?.fix).toBe(
    'A session move cannot inspect a pane’s process tree, so it cannot tell what is still running there.',
  );
});

test('V-0257 the service manager of the other operating system is n/a, never looked up and never a warning', async () => {
  const linux = await hostProgramLines({ which: hostWith([]), platform: 'linux', binary: 'fy' });
  expect(linux.find(line => line.name === 'launchctl')).toMatchObject({
    state: 'ok',
    notApplicable: true,
    detail: 'not used on this operating system',
  });
  expect(linux.find(line => line.name === 'systemctl')).toMatchObject({
    state: 'warn',
    requirement: 'capability',
    fix: '`fy daemon install` cannot install or manage its systemd user service.',
  });
  const mac = await hostProgramLines({ which: hostWith([]), platform: 'darwin', binary: 'fy' });
  expect(mac.find(line => line.name === 'systemctl')).toMatchObject({ notApplicable: true });
  expect(mac.find(line => line.name === 'launchctl')).toMatchObject({
    state: 'warn',
    fix: '`fy daemon install` cannot install or manage its launchd service.',
  });
});

test('V-0257 the report keeps v4’s row names, requirements and not-applicable status; only a required miss makes it not ready', async () => {
  const lines = await hostProgramLines({ which: hostWith(['bash']), platform: 'linux', binary: 'fy' });
  const report = DoctorReportSchema.parse(doctorReport(lines));
  const row = (name: string) => report.checks.find(check => check.name === name);
  expect(row('bash')).toMatchObject({ requirement: 'required', status: 'present' });
  expect(row('gh')).toMatchObject({ requirement: 'optional', status: 'missing' });
  expect(row('launchctl')).toMatchObject({
    requirement: 'capability',
    status: 'not_applicable',
    impact: 'This service manager is not used on this operating system.',
  });
  expect(report.ready).toBe(true);
  const none = DoctorReportSchema.parse(
    doctorReport(await hostProgramLines({ which: hostWith([]), platform: 'linux', binary: 'fy' })),
  );
  expect(none.ready).toBe(false);
});
