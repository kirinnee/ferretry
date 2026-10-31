import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerCatalogCommands } from '../../../src/lib/catalog/commands';
import { CatalogController } from '../../../src/lib/catalog/controller';
import type { ShareController } from '../../../src/lib/catalog-share/controller';
import { registerShareCommands } from '../../../src/lib/catalog-share/commands';
import { CapturingOutput, CWD, FakeGateway, MemoryFiles, ScriptedPrompt } from '../catalog/fixtures';

interface Recorded {
  readonly method: string;
  readonly args: readonly unknown[];
}

function recorder(): { controller: ShareController; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const methods = ['share', 'shares', 'unshare', 'members', 'rename', 'revoke', 'forgetKey', 'take'];
  const controller = Object.fromEntries(
    methods.map(method => [
      method,
      (...args: unknown[]) => {
        calls.push({ method, args });
        return Promise.resolve();
      },
    ]),
  ) as unknown as ShareController;
  return { controller, calls };
}

function program(): Command {
  const root = new Command().name('fy').exitOverride();
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  return root;
}

async function run(argv: string[]) {
  const { controller, calls } = recorder();
  const root = program();
  registerShareCommands(root, controller);
  await root.parseAsync(['node', 'fy', ...argv]);
  return calls;
}

describe('fy catalog share', () => {
  it('should pass the catalogs and every option to the controller', async () => {
    const calls = await run([
      'catalog',
      'share',
      'Team tools',
      'Side tools',
      '--member',
      'Sam',
      '--expires',
      '1h',
      '--multi',
      '--cap',
      '9',
      '--large',
      '--json',
    ]);
    should(calls).have.length(1);
    should(calls[0]?.method).equal('share');
    should(calls[0]?.args[0]).eql(['Team tools', 'Side tools']);
    should(calls[0]?.args[1]).match({ member: 'Sam', expires: '1h', multi: true, cap: '9', large: true, json: true });
  });

  it('should pass --to for a person who has joined', async () => {
    const calls = await run(['catalog', 'share', 'Team tools', '--to', 'Sam', '--expires', '15m']);
    should(calls[0]?.args[1]).match({ to: 'Sam', expires: '15m' });
    should(calls[0]?.args[1]).not.have.property('member');
  });

  it('should pass --yes to skip the question for a person who has joined', async () => {
    const calls = await run(['catalog', 'share', 'Team tools', '--to', 'Sam', '--expires', '15m', '-y']);
    should(calls[0]?.args[1]).match({ to: 'Sam', yes: true });
  });

  it('should refuse a share with no --expires before it reaches the controller', async () => {
    const { controller, calls } = recorder();
    const root = program();
    registerShareCommands(root, controller);
    await should(root.parseAsync(['node', 'fy', 'catalog', 'share', 'Team tools', '--member', 'Sam'])).rejectedWith(
      /--expires/u,
    );
    should(calls).have.length(0);
  });

  it('should refuse a share with no catalog', async () => {
    const { controller } = recorder();
    const root = program();
    registerShareCommands(root, controller);
    await should(root.parseAsync(['node', 'fy', 'catalog', 'share', '--member', 'Sam', '--expires', '1h'])).rejected();
  });

  it('should describe the link as shown once in its help', () => {
    const { controller } = recorder();
    const root = program();
    registerShareCommands(root, controller);
    const share = root.commands.find(command => command.name() === 'catalog')?.commands.find(c => c.name() === 'share');
    should(share?.helpInformation()).containEql('shown once');
  });
});

describe('fy catalog shares and unshare', () => {
  it('should list shares, with and without --json', async () => {
    const plain = await run(['catalog', 'shares']);
    should(plain[0]).match({ method: 'shares', args: [{}] });
    const json = await run(['catalog', 'shares', '--json']);
    should(json[0]).match({ method: 'shares', args: [{ json: true }] });
  });

  it('should end a share by id', async () => {
    const calls = await run(['catalog', 'unshare', 'shr_abc']);
    should(calls[0]).match({ method: 'unshare', args: ['shr_abc', {}] });
    const json = await run(['catalog', 'unshare', 'shr_abc', '--json']);
    should(json[0]).match({ method: 'unshare', args: ['shr_abc', { json: true }] });
  });
});

describe('fy member', () => {
  it('should list people when no verb is given', async () => {
    const calls = await run(['member']);
    should(calls).have.length(1);
    should(calls[0]).match({ method: 'members', args: [{}] });
  });

  it('should list under ls, list and the plural group name, with --json', async () => {
    for (const argv of [['member', 'ls'], ['member', 'list'], ['members', 'ls'], ['members']]) {
      const calls = await run(argv);
      should(calls[0]).match({ method: 'members', args: [{}] });
    }
    const json = await run(['member', 'ls', '--json']);
    should(json[0]).match({ method: 'members', args: [{ json: true }] });
  });

  it('should rename a person', async () => {
    const calls = await run(['member', 'rename', 'Sam', 'Samuel']);
    should(calls[0]).match({ method: 'rename', args: ['Sam', 'Samuel', {}] });
    const json = await run(['member', 'rename', 'Sam', 'Samuel', '--json']);
    should(json[0]).match({ method: 'rename', args: ['Sam', 'Samuel', { json: true }] });
  });

  it('should revoke a person, with -y or --yes and --json', async () => {
    const plain = await run(['member', 'revoke', 'Sam']);
    should(plain[0]).match({ method: 'revoke', args: ['Sam', {}] });
    const short = await run(['member', 'revoke', 'Sam', '-y']);
    should(short[0]).match({ method: 'revoke', args: ['Sam', { yes: true }] });
    const long = await run(['member', 'revoke', 'Sam', '--yes', '--json']);
    should(long[0]).match({ method: 'revoke', args: ['Sam', { yes: true, json: true }] });
  });

  it('should forget one browser of a person', async () => {
    const calls = await run(['member', 'forget-key', 'Sam', 'Safari', '--yes']);
    should(calls[0]).match({ method: 'forgetKey', args: ['Sam', 'Safari', { yes: true }] });
    const plain = await run(['member', 'forget-key', 'Sam', 'mk_abc', '--json']);
    should(plain[0]).match({ method: 'forgetKey', args: ['Sam', 'mk_abc', { json: true }] });
  });

  it('should take one catalog from a person', async () => {
    const calls = await run(['member', 'take', 'Sam', 'Team tools', '-y']);
    should(calls[0]).match({ method: 'take', args: ['Sam', 'Team tools', { yes: true }] });
    const plain = await run(['member', 'take', 'Sam', 'Team tools', '--json']);
    should(plain[0]).match({ method: 'take', args: ['Sam', 'Team tools', { json: true }] });
  });

  it('should refuse a rename with no new name', async () => {
    const { controller, calls } = recorder();
    const root = program();
    registerShareCommands(root, controller);
    await should(root.parseAsync(['node', 'fy', 'member', 'rename', 'Sam'])).rejected();
    should(calls).have.length(0);
  });
});

describe('mounting beside the publisher commands', () => {
  it('should hang the share verbs on the catalog group that already exists, not make a second one', async () => {
    const { controller, calls } = recorder();
    const root = program();
    registerCatalogCommands(
      root,
      new CatalogController(
        new FakeGateway(),
        new CapturingOutput(),
        new ScriptedPrompt([]),
        new MemoryFiles(),
        false,
        CWD,
      ),
    );
    registerShareCommands(root, controller);
    should(root.commands.filter(command => command.name() === 'catalog')).have.length(1);
    await root.parseAsync(['node', 'fy', 'catalog', 'shares']);
    should(calls[0]?.method).equal('shares');
  });

  it('should make the catalog group when it does not exist yet', () => {
    const { controller } = recorder();
    const root = program();
    registerShareCommands(root, controller);
    should(root.commands.map(command => command.name()).sort()).eql(['catalog', 'member']);
  });
});
