import { describe, it } from 'bun:test';
import { CONFIG_INVALID_CODE, CONFIG_SCHEMA_IDS } from '@ferretry/protocol';
import should from 'should';
import {
  ConfigCommandError,
  ConfigController,
  renderConfigReport,
  renderIssue,
  renderPending,
} from '../../../src/lib/config/controller';
import {
  DIRECTORY,
  FakeConfigFiles,
  FakeConfigGateway,
  FakeConfigInput,
  FakeConfigOutput,
  fileView,
  issue,
  pending,
  sha256,
  statusView,
} from './fixtures';

function subject(files = new FakeConfigFiles(), view = statusView(), confirmed = true, stdin = '') {
  const gateway = new FakeConfigGateway(view, confirmed);
  const out = new FakeConfigOutput();
  const input = new FakeConfigInput(stdin);
  return { controller: new ConfigController(files, gateway, out, 'fy', sha256, input), gateway, out, input };
}

describe('rendering', () => {
  it('should put an issue where an editor can jump to it, with its fix underneath', () => {
    should(renderIssue(issue())).equal('machine.yaml:3:7 error: not a thing\n  fix: make it a thing');
  });

  it('should name only the file for an issue that has no position', () => {
    should(renderIssue(issue({ line: undefined, column: undefined, severity: 'warning' }))).equal(
      'machine.yaml warning: not a thing\n  fix: make it a thing',
    );
  });

  it('should say what a held edit loosens and how to confirm it', () => {
    should(renderPending(pending({ changes: ['a', 'b'] }), 'fy')).equal(
      'warden.yaml waits for your confirmation: a; b\n  confirm: fy config confirm warden.yaml',
    );
  });

  it('should count errors, warnings and waiting edits, singular and plural', () => {
    // Arrange
    const report = {
      files: 1,
      issues: [issue(), issue({ severity: 'warning' })],
      pending: [pending()],
    };

    // Act
    const lines = renderConfigReport(report, 'fy').split('\n');

    // Assert
    should(lines.at(-1)).equal('1 file checked: 1 error, 1 warning, 1 waiting for confirmation.');
    should(renderConfigReport({ files: 3, issues: [], pending: [] }, 'fy')).equal(
      '3 files checked: 0 errors, 0 warnings, 0 waiting for confirmation.',
    );
  });
});

describe('fy config check', () => {
  const broken = [
    { path: 'voice.yaml', text: 'token: sk-ant-abcdefghijklmnopqrstuvwxyz0123456789\n' },
    { path: 'warden.yaml', text: 'enabled: true\n' },
  ];

  it('should print each located issue with its fix, the held edit and the summary, and exit 1 on an error', async () => {
    // Arrange
    const { controller, out } = subject(new FakeConfigFiles(broken));

    // Act
    await controller.check({});

    // Assert
    should(out.text).match(/^voice\.yaml:1:1 error: token: this looks like a raw secret/mu);
    should(out.text).match(/^ {2}fix: store the value with `fy secret set NAME`/mu);
    should(out.text).containEql('warden.yaml waits for your confirmation: the Warden may now spend');
    should(out.text).containEql('confirm: fy config confirm warden.yaml');
    should(out.text).match(/2 files checked: 1 error, 0 warnings, 1 waiting for confirmation\.$/u);
    should(out.exitCode).equal(1);
  });

  it('should leave the exit code alone when nothing is wrong', async () => {
    // Arrange
    const { controller, out } = subject(new FakeConfigFiles([{ path: 'voice.yaml', text: '' }]));

    // Act
    await controller.check({});

    // Assert
    should(out.text).equal('1 file checked: 0 errors, 0 warnings, 0 waiting for confirmation.');
    should(out.exitCode).be.undefined();
  });

  it('should hold a file that was not read to its last good version and report it', async () => {
    // Arrange
    const { controller, out } = subject(new FakeConfigFiles([], ['machine.yaml']));

    // Act
    await controller.check({});

    // Assert
    should(out.text).containEql('machine.yaml');
    should(out.exitCode).equal(1);
  });

  it('should print the report as JSON when asked', async () => {
    // Arrange
    const { controller, out } = subject(new FakeConfigFiles(broken));

    // Act
    await controller.check({ json: true });

    // Assert
    const report = JSON.parse(out.text) as { files: number; issues: { path: string }[]; pending: { path: string }[] };
    should(report.files).equal(2);
    should(report.issues.map(item => item.path)).deepEqual(['voice.yaml']);
    should(report.pending.map(item => item.path)).deepEqual(['warden.yaml']);
    should(out.exitCode).equal(1);
  });

  it('should not hold an edit the daemon has already accepted as written', async () => {
    // Arrange — the accepted record carries the very text, so the etag matches.
    const text = 'enabled: true\n';
    const { controller, out } = subject(
      new FakeConfigFiles([{ path: 'warden.yaml', text }], [], { 'warden.yaml': { etag: sha256(text), text } }),
    );

    // Act
    await controller.check({});

    // Assert
    should(out.text).equal('1 file checked: 0 errors, 0 warnings, 0 waiting for confirmation.');
  });
});

describe('fy config path', () => {
  it('should print the directory with no file', () => {
    const { controller, out } = subject();
    controller.path(undefined);
    should(out.lines).deepEqual([DIRECTORY]);
  });

  it('should print one file inside the directory, whether or not it exists yet', () => {
    const { controller, out } = subject();
    controller.path('logins/claude-you.yaml');
    should(out.lines).deepEqual([`${DIRECTORY}/logins/claude-you.yaml`]);
  });

  it('should refuse a path that is not a configuration file, naming what is', () => {
    const { controller } = subject();
    should(() => controller.path('notes.txt')).throw(
      /notes\.txt is not a Ferretry configuration file — use machine\.yaml/u,
    );
  });
});

describe('fy config schema', () => {
  it('should list every kind with no argument', () => {
    const { controller, out } = subject();
    controller.schema(undefined);
    should(out.lines).deepEqual([CONFIG_SCHEMA_IDS.join('\n')]);
  });

  it('should print one kind’s JSON Schema, which is valid JSON with a title', () => {
    const { controller, out } = subject();
    controller.schema('machine');
    const schema = JSON.parse(out.text) as { title?: unknown };
    should(typeof schema.title).equal('string');
  });

  it('should refuse a kind that does not exist, and list the ones that do', () => {
    const { controller } = subject();
    should(() => controller.schema('nope')).throw(
      new ConfigCommandError(`no kind nope — one of ${CONFIG_SCHEMA_IDS.join(', ')}`),
    );
  });
});

describe('fy config status', () => {
  it('should show the directory then the daemon’s report', async () => {
    // Arrange
    const { controller, out } = subject(undefined, statusView({ issues: [issue()], pending: [pending()] }));

    // Act
    await controller.status({});

    // Assert
    should(out.text.startsWith(`${DIRECTORY}\nmachine.yaml:3:7 error: not a thing`)).be.true();
    should(out.text).containEql('warden.yaml waits for your confirmation');
    should(out.text).match(/1 file checked: 1 error, 0 warnings, 1 waiting for confirmation\.$/u);
  });

  it('should print the payload as JSON when asked', async () => {
    // Arrange
    const view = statusView({ pending: [pending()] });
    const { controller, out } = subject(undefined, view);

    // Act
    await controller.status({ json: true });

    // Assert
    should(JSON.parse(out.text)).deepEqual(view);
  });
});

describe('fy config confirm', () => {
  it('should list what waits when no file is named', async () => {
    const { controller, out } = subject(undefined, statusView({ pending: [pending()] }));
    await controller.confirm(undefined);
    should(out.text).equal(renderPending(pending(), 'fy'));
  });

  it('should say nothing is waiting when nothing is', async () => {
    const { controller, out } = subject();
    await controller.confirm(undefined);
    should(out.lines).deepEqual(['Nothing is waiting for your confirmation.']);
  });

  it('should refuse a file with no change waiting', async () => {
    const { controller, gateway } = subject(undefined, statusView({ pending: [pending()] }));
    await should(controller.confirm('machine.yaml')).rejectedWith(
      'machine.yaml has no change waiting for your confirmation',
    );
    should(gateway.confirms).be.empty();
  });

  it('should confirm the very etag it showed, and say what is now in effect', async () => {
    // Arrange
    const { controller, gateway, out } = subject(
      undefined,
      statusView({ pending: [pending({ changes: ['a', 'b'] })] }),
    );

    // Act
    await controller.confirm('warden.yaml');

    // Assert
    should(gateway.confirms).deepEqual([{ path: 'warden.yaml', etag: 'etag-1' }]);
    should(out.lines).deepEqual(['Confirmed warden.yaml: a; b. It is in effect now.']);
  });

  it('should refuse when the file changed again before the daemon could confirm it', async () => {
    const { controller, out } = subject(undefined, statusView({ pending: [pending()] }), false);
    await should(controller.confirm('warden.yaml')).rejectedWith(
      'warden.yaml changed again before it could be confirmed; run fy config confirm again',
    );
    should(out.lines).be.empty();
  });
});

describe('fy config show', () => {
  it('should show where the file is, its etag, each located issue and then its text', async () => {
    // Arrange
    const { controller, gateway, out } = subject();
    gateway.fileView = fileView({ state: 'invalid', issues: [issue()], text: 'a: 1\n' });

    // Act
    await controller.show('machine.yaml', {});

    // Assert
    should(gateway.reads).deepEqual(['machine.yaml']);
    should(out.lines).deepEqual([
      [
        `${DIRECTORY}/machine.yaml (invalid)`,
        'etag: etag-1',
        'machine.yaml:3:7 error: not a thing\n  fix: make it a thing',
        '',
        'a: 1\n',
      ].join('\n'),
    ]);
  });

  it('should say a file that does not exist yet is the starter a new one begins with', async () => {
    const { controller, gateway, out } = subject();
    gateway.fileView = fileView({ exists: false, etag: 'absent', text: '# starter\n' });
    await controller.show('machine.yaml', {});
    should(out.text).startWith(
      `${DIRECTORY}/machine.yaml (does not exist yet — this is the starter a new one begins with)\netag: absent\n\n# starter`,
    );
  });

  it('should print the view as JSON when asked', async () => {
    const { controller, gateway, out } = subject();
    gateway.fileView = fileView({ issues: [issue()] });
    await controller.show('machine.yaml', { json: true });
    should(JSON.parse(out.text)).deepEqual(gateway.fileView);
  });
});

describe('fy config write', () => {
  const invalidBody = (message: string) => ({
    error: message,
    code: CONFIG_INVALID_CODE,
    issues: [issue(), issue({ path: 'machine.yaml', line: undefined, column: undefined, severity: 'warning' })],
  });
  const failure = (body: unknown) => Object.assign(new Error('refused'), { body });

  it('should send standard input whole, with no etag unless one was given, and say it is in effect', async () => {
    // Arrange
    const { controller, gateway, out } = subject(undefined, undefined, undefined, 'a: 1\n\n');

    // Act
    await controller.write('machine.yaml', {});

    // Assert
    should(gateway.writes).deepEqual([{ path: 'machine.yaml', text: 'a: 1\n\n', ifMatch: undefined }]);
    should(out.lines).deepEqual(['Wrote machine.yaml; it is in effect (etag etag-new).']);
  });

  it('should pass --if-match through as the etag the edit was made against', async () => {
    const { controller, gateway } = subject();
    await controller.write('machine.yaml', { ifMatch: 'etag-1' });
    should(gateway.writes[0]?.ifMatch).equal('etag-1');
  });

  it('should say a loosening waits for confirmation, and how to confirm it', async () => {
    const { controller, gateway, out } = subject();
    gateway.putResult = {
      path: 'warden.yaml',
      etag: 'etag-2',
      outcome: 'pending',
      pending: pending({ changes: ['a', 'b'] }),
    };
    await controller.write('warden.yaml', {});
    should(out.lines).deepEqual([
      'Wrote warden.yaml; it waits for your confirmation: a; b.\n  confirm: fy config confirm warden.yaml',
    ]);
  });

  it('should still name a held write that came back without its changes', async () => {
    const { controller, gateway, out } = subject();
    gateway.putResult = { path: 'warden.yaml', etag: 'etag-2', outcome: 'pending' };
    await controller.write('warden.yaml', {});
    should(out.text).startWith('Wrote warden.yaml; it waits for your confirmation: .');
  });

  it('should print every located issue of a refused file, then fail with the daemon’s sentence', async () => {
    // Arrange
    const { controller, gateway, out } = subject();
    gateway.writeFailure = failure(invalidBody('machine.yaml does not check'));

    // Act + Assert
    await should(controller.write('machine.yaml', {})).rejectedWith(
      new ConfigCommandError('machine.yaml does not check'),
    );
    should(out.lines).deepEqual([
      'machine.yaml:3:7 error: not a thing\n  fix: make it a thing\nmachine.yaml warning: not a thing\n  fix: make it a thing',
    ]);
  });

  it('should rethrow any other failure untouched, whatever its body', async () => {
    const plain = new Error('connection refused');
    const odd = failure({ nothing: 'useful' });
    for (const thrown of [plain, odd]) {
      const { controller, gateway, out } = subject();
      gateway.writeFailure = thrown;
      const caught = await controller.write('machine.yaml', {}).catch((error: unknown) => error);
      should(caught).equal(thrown);
      should(out.lines).be.empty();
    }
  });
});

describe('fy config guide', () => {
  it('should print the Set up Ferretry skill as a SKILL.md for this binary', () => {
    const { controller, out } = subject();
    controller.guide();
    should(out.text.startsWith('---\nname: set-up-ferretry\n')).be.true();
    should(out.text).containEql('`fy`');
  });
});

describe('ConfigCommandError', () => {
  it('should carry its name so the entry point can say it as a sentence', () => {
    should(new ConfigCommandError('x').name).equal('ConfigCommandError');
  });
});
