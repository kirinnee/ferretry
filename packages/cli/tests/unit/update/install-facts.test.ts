import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { type BoundedRunner, HostInstallFacts } from '../../../src/adapters/update/install-facts';
import type { CommandOutcome } from '../../../src/lib/daemon/ports';

const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-1.2.3';
const ok = (stdout = ''): CommandOutcome => ({ code: 0, stdout, stderr: '' });
const no: CommandOutcome = { code: 1, stdout: '', stderr: 'not owned' };

function facts(options: {
  answers?: Readonly<Record<string, CommandOutcome>>;
  commands?: readonly string[];
  realPath?: (path: string) => Promise<string>;
}) {
  const ran: string[] = [];
  const run: BoundedRunner = argv => {
    ran.push(argv.join(' '));
    return Promise.resolve(options.answers?.[argv[0] ?? ''] ?? no);
  };
  const subject = new HostInstallFacts({
    product: 'ferretry',
    homeDirectory: '/home/kirin',
    platform: 'linux',
    run,
    readLink: async () => undefined,
    which: command => ((options.commands ?? []).includes(command) ? `/usr/bin/${command}` : undefined),
    ...(options.realPath === undefined ? {} : { realPath: options.realPath }),
  });
  return { subject, ran };
}

const daemon = (path: string) => ({ path, source: 'PATH' as const, version: '1.2.3' });

let scratch: string | undefined;
afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('HostInstallFacts', () => {
  it('resolves links on the real filesystem and keeps the launched path', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fy-facts-'));
    const real = join(scratch, 'fyd-real');
    await writeFile(real, '');
    await symlink(real, join(scratch, 'fyd'));
    const { subject } = facts({});
    should(await subject.facts(daemon(join(scratch, 'fyd')))).match({
      launchedPath: join(scratch, 'fyd'),
      resolvedPath: real,
      compiled: true,
      systemPackage: undefined,
    });
  });

  it('keeps the path as it is when it cannot be resolved', async () => {
    const { subject } = facts({});
    should((await subject.facts(daemon('/nonexistent/fyd'))).resolvedPath).equal('/nonexistent/fyd');
  });

  it('asks the nix profile which element holds a store path', async () => {
    const list = JSON.stringify({ version: 3, elements: { ferretry: { storePaths: [STORE] } } });
    const { subject, ran } = facts({ answers: { nix: ok(list) }, realPath: () => Promise.resolve(`${STORE}/bin/fyd`) });
    should(await subject.facts(daemon('/home/kirin/.nix-profile/bin/fyd'))).match({
      nixProfileElement: 'ferretry',
      homeManagerProfile: false,
    });
    should(ran).deepEqual(['nix --extra-experimental-features nix-command flakes profile list --json']);
  });

  it('treats a failed or unreadable profile list as no element', async () => {
    const store = () => Promise.resolve(`${STORE}/bin/fyd`);
    should((await facts({ realPath: store }).subject.facts(daemon('/x'))).nixProfileElement).be.undefined();
    const garbled = facts({ answers: { nix: ok('{not json') }, realPath: store });
    should(await garbled.subject.facts(daemon('/x'))).match({
      nixProfileElement: undefined,
      homeManagerProfile: false,
    });
  });

  it('asks dpkg, then rpm, only when they exist', async () => {
    const real = () => Promise.resolve('/usr/bin/fyd');
    should(
      (
        await facts({ commands: ['dpkg'], answers: { dpkg: ok() }, realPath: real }).subject.facts(
          daemon('/usr/bin/fyd'),
        )
      ).systemPackage,
    ).equal('apt');
    should(
      (
        await facts({ commands: ['dpkg', 'rpm', 'dnf'], answers: { rpm: ok() }, realPath: real }).subject.facts(
          daemon('/usr/bin/fyd'),
        )
      ).systemPackage,
    ).equal('dnf');
    should(
      (await facts({ commands: ['rpm'], answers: { rpm: ok() }, realPath: real }).subject.facts(daemon('/usr/bin/fyd')))
        .systemPackage,
    ).equal('yum');
    const none = facts({ answers: { dpkg: ok(), rpm: ok() }, realPath: real });
    should((await none.subject.facts(daemon('/usr/bin/fyd'))).systemPackage).be.undefined();
    should(none.ran).be.empty();
  });
});
