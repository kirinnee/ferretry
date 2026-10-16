import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerConfigCommands } from '../../../src/lib/config/commands';
import { ConfigController } from '../../../src/lib/config/controller';
import {
  DIRECTORY,
  FakeConfigFiles,
  FakeConfigGateway,
  FakeConfigInput,
  FakeConfigOutput,
  issue,
  pending,
  sha256,
  statusView,
} from './fixtures';

function run(argv: string[], view = statusView({ pending: [pending()], issues: [issue()] }), stdin = '') {
  const gateway = new FakeConfigGateway(view);
  const out = new FakeConfigOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerConfigCommands(
    program,
    new ConfigController(
      new FakeConfigFiles([{ path: 'voice.yaml', text: '' }]),
      gateway,
      out,
      'fy',
      sha256,
      new FakeConfigInput(stdin),
    ),
  );
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('config command surface', () => {
  it('should check when no verb is given', async () => {
    const { parsed, out } = run(['config']);
    await parsed;
    should(out.text).equal('1 file checked: 0 errors, 0 warnings, 0 waiting for confirmation.');
  });

  it('should check with --json', async () => {
    const { parsed, out } = run(['config', 'check', '--json']);
    await parsed;
    should(JSON.parse(out.text)).match({ files: 1, issues: [], pending: [] });
  });

  it('should print the directory, or one file in it', async () => {
    const bare = run(['config', 'path']);
    await bare.parsed;
    should(bare.out.text).equal(DIRECTORY);

    const file = run(['config', 'path', 'machine.yaml']);
    await file.parsed;
    should(file.out.text).equal(`${DIRECTORY}/machine.yaml`);
  });

  it('should print one kind’s schema, or the list', async () => {
    const list = run(['config', 'schema']);
    await list.parsed;
    should(list.out.text).startWith('machine\nlogin');

    const one = run(['config', 'schema', 'warden']);
    await one.parsed;
    should(JSON.parse(one.out.text)).be.an.Object();
  });

  it('should ask the daemon for the status, as text or JSON', async () => {
    const text = run(['config', 'status']);
    await text.parsed;
    should(text.out.text).startWith(`${DIRECTORY}\n`);

    const json = run(['config', 'status', '--json']);
    await json.parsed;
    should(JSON.parse(json.out.text)).match({ directory: DIRECTORY });
  });

  it('should list what waits, and confirm a named file', async () => {
    const list = run(['config', 'confirm']);
    await list.parsed;
    should(list.out.text).containEql('confirm: fy config confirm warden.yaml');

    const one = run(['config', 'confirm', 'warden.yaml']);
    await one.parsed;
    should(one.gateway.confirms).deepEqual([{ path: 'warden.yaml', etag: 'etag-1' }]);
  });

  it('should show one file, as text or JSON', async () => {
    const text = run(['config', 'show', 'machine.yaml']);
    await text.parsed;
    should(text.gateway.reads).deepEqual(['machine.yaml']);
    should(text.out.text).startWith(`${DIRECTORY}/machine.yaml (ok)\netag: etag-1`);

    const json = run(['config', 'show', 'machine.yaml', '--json']);
    await json.parsed;
    should(JSON.parse(json.out.text)).match({ path: 'machine.yaml', etag: 'etag-1' });
  });

  it('should require a file to show or write', async () => {
    await should(run(['config', 'show']).parsed).rejected();
    await should(run(['config', 'write']).parsed).rejected();
  });

  it('should write standard input to a file, with --if-match only when given', async () => {
    const bare = run(['config', 'write', 'machine.yaml'], undefined, 'a: 1\n');
    await bare.parsed;
    should(bare.gateway.writes).deepEqual([{ path: 'machine.yaml', text: 'a: 1\n', ifMatch: undefined }]);
    should(bare.out.text).startWith('Wrote machine.yaml; it is in effect');

    const guarded = run(['config', 'write', 'machine.yaml', '--if-match', 'etag-1'], undefined, 'a: 2\n');
    await guarded.parsed;
    should(guarded.gateway.writes).deepEqual([{ path: 'machine.yaml', text: 'a: 2\n', ifMatch: 'etag-1' }]);
  });

  it('should print the guide', async () => {
    const { parsed, out } = run(['config', 'guide']);
    await parsed;
    should(out.text.startsWith('---\nname: set-up-ferretry')).be.true();
  });

  it('should explain the files in its help', () => {
    const program = new Command().name('fy');
    registerConfigCommands(
      program,
      new ConfigController(
        new FakeConfigFiles(),
        new FakeConfigGateway(statusView()),
        new FakeConfigOutput(),
        'fy',
        sha256,
        new FakeConfigInput(),
      ),
    );
    should(program.commands.find(command => command.name() === 'config')?.helpInformation()).containEql(
      'check and find',
    );
  });
});
