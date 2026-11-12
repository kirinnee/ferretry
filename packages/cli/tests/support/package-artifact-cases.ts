import { describe, it } from 'bun:test';
import should from 'should';
import { CommandPackageManagers } from '../../src/adapters/update/package-managers';
import type { CommandOutcome } from '../../src/lib/daemon/ports';

const SOURCE = 'github:kirinnee/ferretry';
const REV = 'a'.repeat(40);
const REFERENCE = `${SOURCE}/${REV}`;
const CASK = 'kirinnee/ferretry/ferretry@4';
const NIX = ['nix', '--extra-experimental-features', 'nix-command flakes'];
const ok = (value: unknown): CommandOutcome => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const failed: CommandOutcome = { code: 1, stdout: '', stderr: 'offline' };
const metadata = () => ok({ locked: { type: 'github', owner: 'kirinnee', repo: 'ferretry', rev: REV } });
const version = (value = '4.291.10'): CommandOutcome => ({ code: 0, stdout: `${value}\n`, stderr: '' });
const profile = () =>
  ok({
    elements: {
      ferretry: { originalUrl: SOURCE, attrPath: 'packages.x86_64-linux.default', priority: 5 },
      other: { storePaths: ['/nix/store/other'] },
    },
  });

function fake(answers: CommandOutcome[]) {
  const ran: string[][] = [];
  const manager = new CommandPackageManagers(async argv => {
    ran.push([...argv]);
    const answer = answers.shift();
    if (answer === undefined) throw new Error('unexpected command');
    return answer;
  });
  return { manager, ran };
}

export function packageArtifactCases(): void {
  describe('package artifact binding', () => {
    it('refuses a profile upgrade without the judged attribute and priority', async () => {
      const { manager, ran } = fake([]);
      should((await manager.nixProfileUpgrade('ferretry', undefined)).code).equal(1);
      should(ran).deepEqual([]);
    });
    it('reads the full cask name and disables any auto-update in both info and upgrade', async () => {
      const { manager, ran } = fake([ok({ casks: [{ full_token: CASK, version: '4.291.10' }] }), ok(null)]);
      should(await manager.brewCaskVersion(CASK)).deepEqual({ version: '4.291.10' });
      await manager.brewUpgrade(CASK);
      should(ran).deepEqual([
        ['env', 'HOMEBREW_NO_AUTO_UPDATE=1', 'brew', 'info', '--cask', '--json=v2', CASK],
        ['env', 'HOMEBREW_NO_AUTO_UPDATE=1', 'brew', 'upgrade', '--cask', CASK],
      ]);
    });

    for (const answer of [
      failed,
      ok({ casks: [] }),
      ok({ casks: [{ full_token: CASK, version: 'latest' }] }),
      ok({ casks: [{ full_token: 'other', version: '4.291.10' }] }),
      { code: 0, stdout: 'bad JSON', stderr: '' },
    ]) {
      it(`refuses unreadable or ambiguous brew metadata: ${answer.stdout}`, async () => {
        const { manager } = fake([answer]);
        should(await manager.brewCaskVersion(CASK)).have.property('failure');
      });
    }

    for (const element of [undefined, 'ferretry']) {
      it(`locks the refreshed revision, reads VERSION there and installs only that revision (${element ?? 'shell'})`, async () => {
        const { manager, ran } = fake([
          ...(element === undefined ? [] : [profile()]),
          metadata(),
          version(),
          ok(null),
          ...(element === undefined ? [] : [ok(null)]),
        ]);
        const target = await manager.nixResolve(SOURCE, element);
        if ('failure' in target) throw new Error(target.failure);
        should(target).deepEqual({
          source: SOURCE,
          reference: REFERENCE,
          version: '4.291.10',
          ...(element === undefined ? {} : { profile: { attribute: 'packages.x86_64-linux.default', priority: 5 } }),
        });
        if (element === undefined) await manager.nixProfileInstall(SOURCE, () => undefined, target);
        else await manager.nixProfileUpgrade(element, target, () => undefined);
        should(ran).deepEqual([
          ...(element === undefined ? [] : [[...NIX, 'profile', 'list', '--json']]),
          [...NIX, 'flake', 'metadata', '--refresh', '--json', SOURCE],
          [
            ...NIX,
            'eval',
            '--raw',
            '--no-registries',
            '--expr',
            `builtins.readFile ((builtins.getFlake "${REFERENCE}").outPath + "/VERSION")`,
          ],
          [
            ...NIX,
            'profile',
            'install',
            '--no-update-lock-file',
            ...(element === undefined ? [] : ['--priority', '6']),
            '--log-format',
            'internal-json',
            '-v',
            element === undefined ? REFERENCE : `${REFERENCE}#packages.x86_64-linux.default`,
          ],
          ...(element === undefined ? [] : [[...NIX, 'profile', 'remove', element]]),
        ]);
        should(ran.slice(-2).flat().includes('--refresh')).be.false();
      });
    }

    it('rolls back staging if removing the previous element fails', async () => {
      const { manager, ran } = fake([ok(null), failed, ok(null)]);
      const target = {
        source: SOURCE,
        reference: REFERENCE,
        version: '4.291.10',
        profile: { attribute: 'packages.x86_64-linux.default', priority: 5 },
      };
      should((await manager.nixProfileUpgrade('ferretry', target)).code).equal(1);
      should(ran.map(argv => argv.slice(3, 5).join(' '))).deepEqual([
        'profile install',
        'profile remove',
        'profile rollback',
      ]);
    });

    it('leaves the previous profile untouched if the exact locked build fails', async () => {
      const { manager, ran } = fake([failed]);
      const target = {
        source: SOURCE,
        reference: REFERENCE,
        version: '4.291.10',
        profile: { attribute: 'packages.x86_64-linux.default', priority: 5 },
      };
      should((await manager.nixProfileUpgrade('ferretry', target)).code).equal(1);
      should(ran.length).equal(1);
    });

    for (const [name, answers] of [
      ['failed profile', [failed]],
      ['missing element', [ok({ elements: {} })]],
      [
        'unknown source',
        [
          ok({
            elements: { ferretry: { originalUrl: 'github:other/product', attrPath: 'packages.x86_64-linux.default' } },
          }),
        ],
      ],
      [
        'tag pin',
        [
          ok({
            elements: { ferretry: { originalUrl: `${SOURCE}/v4.291.10`, attrPath: 'packages.x86_64-linux.default' } },
          }),
        ],
      ],
      ['failed revision', [profile(), failed]],
      ['missing revision', [profile(), ok({ locked: {} })]],
      ['wrong repo', [profile(), ok({ locked: { type: 'github', owner: 'other', repo: 'ferretry', rev: REV } })]],
      ['failed VERSION', [profile(), metadata(), failed]],
      ['invalid VERSION', [profile(), metadata(), version('dev')]],
      ['thrown command', []],
    ] as const) {
      it(`fails closed on ${name}`, async () => {
        const { manager, ran } = fake([...answers]);
        should(await manager.nixResolve(SOURCE, 'ferretry')).have.property('failure');
        should(ran.some(argv => argv.includes('upgrade') || argv.includes('install'))).be.false();
        if (name === 'tag pin' || name === 'unknown source') should(ran.length).equal(1);
      });
    }
  });
}
