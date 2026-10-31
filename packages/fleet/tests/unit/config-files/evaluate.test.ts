import { describe, it } from 'bun:test';
import { DEFAULT_LEARNING_CONFIG, DEFAULT_VOICE_CONFIG, DEFAULT_WARDEN_CONFIG } from '@ferretry/protocol';
import should from 'should';
import {
  ABSENT_CONFIG_ETAG,
  type AcceptedConfigFiles,
  AcceptedConfigFilesSchema,
  type ConfigEvaluation,
  type ConfigFileText,
  evaluateConfigFiles,
} from '../../../src/lib/config-files/evaluate.ts';
import { assembleAccountModel } from '../../../src/lib/config-files/model.ts';
import { acceptedOf, digest, FLEET_FILES, file, LOGIN_TEXT, SECOND_LOGIN_TEXT } from './support.ts';

const evaluate = (
  files: readonly ConfigFileText[],
  accepted: AcceptedConfigFiles = {},
  unreadable?: readonly string[],
): ConfigEvaluation =>
  evaluateConfigFiles({ files, accepted, digest, ...(unreadable === undefined ? {} : { unreadable }) });

/** `files` with the file at `path` given other text. */
const withText = (files: readonly ConfigFileText[], path: string, text: string): ConfigFileText[] =>
  files.map(entry => (entry.path === path ? file(path, text) : entry));

const WARDEN_ON = 'layers:\n  llm: true\n';
const MACHINE_FERRETRY = 'agentControl:\n  ferretrySettings: true\n';
const LEARNING_OFF = 'enabled: false\n';

describe('AcceptedConfigFilesSchema', () => {
  it('should read a record of etag and text by path', () => {
    // Act
    const actual = AcceptedConfigFilesSchema.parse({ 'warden.yaml': { etag: 'abc', text: '' } });

    // Assert
    should(actual).deepEqual({ 'warden.yaml': { etag: 'abc', text: '' } });
  });

  it.each([
    ['an empty etag', { 'warden.yaml': { etag: '', text: 'x' } }],
    ['a missing text', { 'warden.yaml': { etag: 'a' } }],
    ['an extra key', { 'warden.yaml': { etag: 'a', text: 'x', more: 1 } }],
  ])('should refuse %s', (_label, input) => {
    // Act + Assert
    should(AcceptedConfigFilesSchema.safeParse(input).success).be.false();
  });
});

describe('ABSENT_CONFIG_ETAG', () => {
  it('should be the provisioner’s absent revision', () => {
    should(ABSENT_CONFIG_ETAG).equal('absent');
  });
});

describe('evaluateConfigFiles: an empty directory', () => {
  it('should put every default in effect, and say the machine has no fleet', () => {
    // Act
    const actual = evaluate([]);

    // Assert
    should(actual.effective.warden).equal(DEFAULT_WARDEN_CONFIG);
    should(actual.effective.learning).equal(DEFAULT_LEARNING_CONFIG);
    should(actual.effective.voice).equal(DEFAULT_VOICE_CONFIG);
    should(actual.effective.model).deepEqual(assembleAccountModel([]));
    should(actual.fleetFiles).equal(0);
    should(actual.fleetRevision).equal(ABSENT_CONFIG_ETAG);
    should(actual.accepted).deepEqual({});
    should(actual.files).deepEqual([]);
    should(actual.issues).deepEqual([]);
    should(actual.pending).deepEqual([]);
  });
});

describe('evaluateConfigFiles: files that check', () => {
  it('should put a whole fleet in effect and record each file under its digest', () => {
    // Act
    const actual = evaluate(FLEET_FILES);

    // Assert
    should(Object.keys(actual.effective.model.credentials)).deepEqual(['you']);
    should(Object.keys(actual.effective.model.runtimes)).deepEqual(['claude']);
    should(actual.fleetFiles).equal(4);
    should(actual.accepted).deepEqual(acceptedOf(FLEET_FILES));
    should(actual.issues).deepEqual([]);
    should(actual.pending).deepEqual([]);
  });

  it('should list every file by path with its kind, schema and state', () => {
    // Act
    const actual = evaluate([...FLEET_FILES, file('warden.yaml', WARDEN_ON)]);

    // Assert
    should(actual.files).deepEqual([
      { path: 'components/instructions/main.yaml', kind: 'component', schema: 'component-instructions', state: 'ok' },
      { path: 'logins/you.yaml', kind: 'login', schema: 'login', state: 'ok' },
      { path: 'profiles/default.yaml', kind: 'profile', schema: 'profile', state: 'ok' },
      { path: 'runtimes/claude.yaml', kind: 'runtime', schema: 'runtime', state: 'ok' },
      { path: 'warden.yaml', kind: 'warden', schema: 'warden', state: 'pending' },
    ]);
  });

  it('should put the Warden, Learning and Voice files in effect without counting them as the fleet', () => {
    // Arrange
    const input = [
      file('warden.yaml', 'intervalMinutes: 10\n'),
      file('learning.yaml', 'batchSize: 5\n'),
      file('voice.yaml', 'postProcessing:\n  provider: off\n'),
    ];

    // Act
    const actual = evaluate(input);

    // Assert
    should(actual.effective.warden.intervalMinutes).equal(10);
    should(actual.effective.learning.batchSize).equal(5);
    should(actual.effective.voice).deepEqual(DEFAULT_VOICE_CONFIG);
    should(actual.fleetFiles).equal(0);
    should(actual.fleetRevision).equal(ABSENT_CONFIG_ETAG);
    should(actual.files.map(entry => entry.state)).deepEqual(['ok', 'ok', 'ok']);
  });

  it('should put machine.yaml in effect as the fleet’s machine settings', () => {
    // Act
    const actual = evaluate([file('machine.yaml', 'agentPermissions: auto\nagentControl:\n  terminals: false\n')]);

    // Assert
    should(actual.effective.model.machine.agentControl.terminals).be.false();
    should(actual.fleetFiles).equal(1);
  });

  it('should not depend on the order the files were read in', () => {
    // Act
    const forward = evaluate(FLEET_FILES);
    const backward = evaluate([...FLEET_FILES].toReversed());

    // Assert
    should(backward).deepEqual(forward);
  });
});

describe('evaluateConfigFiles: a file Ferretry does not read', () => {
  it('should warn about it and give it no state, no effect and no accepted entry', () => {
    // Act
    const actual = evaluate([...FLEET_FILES, file('notes.yaml', 'a: 1\n')]);

    // Assert
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.severity).equal('warning');
    should(actual.issues[0]?.path).equal('notes.yaml');
    should(actual.files.map(entry => entry.path)).not.containEql('notes.yaml');
    should(Object.keys(actual.accepted)).not.containEql('notes.yaml');
    should(actual.fleetFiles).equal(4);
  });
});

describe('evaluateConfigFiles: last good wins', () => {
  const BROKEN = 'enabled: [unclosed\n';

  it('should keep the previously accepted text in effect while the file does not parse', () => {
    // Arrange
    const accepted = acceptedOf([file('warden.yaml', 'intervalMinutes: 10\n')]);

    // Act
    const actual = evaluate([file('warden.yaml', BROKEN)], accepted);

    // Assert
    should(actual.effective.warden.intervalMinutes).equal(10);
    should(actual.accepted).deepEqual(accepted);
    should(actual.files).deepEqual([{ path: 'warden.yaml', kind: 'warden', schema: 'warden', state: 'invalid' }]);
    should(actual.issues.some(issue => issue.severity === 'error' && issue.path === 'warden.yaml')).be.true();
    should(actual.pending).deepEqual([]);
  });

  it('should keep the previous version for a file that parses but breaks its schema', () => {
    // Arrange
    const accepted = acceptedOf([file('warden.yaml', 'intervalMinutes: 10\n')]);

    // Act
    const actual = evaluate([file('warden.yaml', 'bogus: 1\n')], accepted);

    // Assert
    should(actual.effective.warden.intervalMinutes).equal(10);
    should(actual.files[0]?.state).equal('invalid');
    should(actual.issues[0]?.line).equal(1);
  });

  it('should keep the previous version for a file that holds a raw secret', () => {
    // Arrange
    const key = ['sk', 'ant', 'api03'].join('-') + '-' + 'Q'.repeat(24);
    const good = 'harness: claude\nstore: environment\nenv:\n  A: b\n';
    const accepted = acceptedOf([file('logins/work.yaml', good)]);

    // Act
    const actual = evaluate([file('logins/work.yaml', `${good}  TOKEN: ${key}\n`)], accepted);

    // Assert
    should(actual.effective.model.credentials.work?.env).deepEqual({ A: 'b' });
    should(actual.files[0]?.state).equal('invalid');
    should(JSON.stringify(actual)).not.containEql(key);
  });

  it('should give a file that was never accepted and does not check no effect at all', () => {
    // Act
    const actual = evaluate([file('warden.yaml', BROKEN), ...FLEET_FILES]);

    // Assert
    should(actual.effective.warden).equal(DEFAULT_WARDEN_CONFIG);
    should(Object.keys(actual.accepted)).not.containEql('warden.yaml');
    should(actual.files.find(entry => entry.path === 'warden.yaml')?.state).equal('invalid');
    should(actual.fleetFiles).equal(4);
  });

  it('should give a never-accepted invalid fleet file no place in the model', () => {
    // Act
    const actual = evaluate([...FLEET_FILES, file('logins/bad.yaml', 'harness: nope\n')]);

    // Assert
    should(Object.keys(actual.effective.model.credentials)).deepEqual(['you']);
    should(actual.fleetFiles).equal(4);
  });

  it('should drop an accepted entry that no longer checks, as a release that changed a schema would', () => {
    // Arrange
    const accepted = { 'warden.yaml': { etag: 'old', text: 'retiredKey: 1\n' } };

    // Act
    const actual = evaluate([file('warden.yaml', BROKEN)], accepted);

    // Assert
    should(actual.effective.warden).equal(DEFAULT_WARDEN_CONFIG);
    should(actual.accepted).deepEqual({});
  });

  it('should drop an accepted entry that no longer checks when its file is also gone', () => {
    // Arrange
    const accepted = { 'warden.yaml': { etag: 'old', text: 'retiredKey: 1\n' } };

    // Act
    const actual = evaluate([], accepted);

    // Assert
    should(actual.accepted).deepEqual({});
    should(actual.pending).deepEqual([]);
    should(actual.effective.warden).equal(DEFAULT_WARDEN_CONFIG);
  });

  it('should put the file in effect again as soon as it is fixed', () => {
    // Arrange
    const accepted = acceptedOf([file('warden.yaml', 'intervalMinutes: 10\n')]);

    // Act
    const actual = evaluate([file('warden.yaml', 'intervalMinutes: 15\n')], accepted);

    // Assert
    should(actual.effective.warden.intervalMinutes).equal(15);
    should(actual.accepted['warden.yaml']?.etag).equal(digest('intervalMinutes: 15\n'));
    should(actual.files[0]?.state).equal('ok');
  });
});

describe('evaluateConfigFiles: loosening waits', () => {
  it.each([
    ['warden.yaml', WARDEN_ON, 'the Warden may now spend on AI investigations'],
    ['machine.yaml', MACHINE_FERRETRY, 'agents may now control Ferretry settings'],
    ['machine.yaml', 'agentPermissions: skip\n', 'agents now skip every permission prompt'],
    [
      'machine.yaml',
      'publicUsageFeed: true\n',
      'any process on this host can now read quota percentages and account labels without a credential',
    ],
    ['learning.yaml', 'maxMinersPerRun: 9\n', 'the lesson miners one run may start goes up from 2 to 9'],
    ['learning.yaml', 'intervalMinutes: 5\n', 'the minutes between lesson runs goes down from 60 to 5'],
    ['voice.yaml', 'postProcessing:\n  provider: groq\n', 'dictated text now goes to groq to be cleaned up'],
  ])('should hold %s with %j, naming %j', (path, text, change) => {
    // Act
    const actual = evaluate([file(path, text)]);

    // Assert
    should(actual.pending).deepEqual([{ path, etag: digest(text), changes: [change] }]);
    should(actual.files[0]?.state).equal('pending');
    should(actual.accepted).deepEqual({});
    should(actual.issues).deepEqual([]);
  });

  it('should keep the tighter version in effect while the edit is held', () => {
    // Arrange
    const accepted = acceptedOf([file('warden.yaml', 'intervalMinutes: 10\n')]);

    // Act
    const actual = evaluate([file('warden.yaml', 'triage: llm\nintervalMinutes: 10\n')], accepted);

    // Assert
    should(actual.effective.warden.layers.llm).be.false();
    should(actual.effective.warden.intervalMinutes).equal(10);
    should(actual.accepted).deepEqual(accepted);
  });

  it('should hold the machine’s loosening but still apply the rest of the fleet', () => {
    // Act
    const actual = evaluate([...FLEET_FILES, file('machine.yaml', MACHINE_FERRETRY)]);

    // Assert
    should(actual.effective.model.machine.agentControl.ferretrySettings).be.false();
    should(Object.keys(actual.effective.model.runtimes)).deepEqual(['claude']);
    should(actual.pending.map(entry => entry.path)).deepEqual(['machine.yaml']);
    should(actual.fleetFiles).equal(4);
  });

  it('should hold an edit that raises one cap while lowering another', () => {
    // Arrange
    const accepted = acceptedOf([file('learning.yaml', 'batchSize: 20\n')]);

    // Act
    const actual = evaluate([file('learning.yaml', 'batchSize: 10\nmaxSessionsPerRun: 90\n')], accepted);

    // Assert
    should(actual.pending[0]?.changes).deepEqual(['the sessions one lesson run may read goes up from 40 to 90']);
    should(actual.effective.learning.batchSize).equal(20);
    should(actual.effective.learning.maxSessionsPerRun).equal(40);
  });

  it('should apply tightening at once', () => {
    // Arrange
    const accepted = acceptedOf([file('warden.yaml', WARDEN_ON), file('machine.yaml', 'agentPermissions: skip\n')]);

    // Act
    const actual = evaluate(
      [file('warden.yaml', 'triage: rules\n'), file('machine.yaml', 'agentPermissions: auto\n')],
      accepted,
    );

    // Assert
    should(actual.effective.warden.layers.llm).be.false();
    should(actual.effective.model.machine.agentPermissions).equal('auto');
    should(actual.pending).deepEqual([]);
    should(actual.files.map(entry => entry.state)).deepEqual(['ok', 'ok']);
    should(actual.accepted['warden.yaml']?.etag).equal(digest('triage: rules\n'));
  });

  it('should put a confirmed loosening in effect: its text is already the accepted one', () => {
    // Arrange
    const held = evaluate([file('warden.yaml', WARDEN_ON)]);
    const confirmed = { 'warden.yaml': { etag: held.pending[0]?.etag as string, text: WARDEN_ON } };

    // Act
    const actual = evaluate([file('warden.yaml', WARDEN_ON)], confirmed);

    // Assert
    should(actual.effective.warden.layers.llm).be.true();
    should(actual.pending).deepEqual([]);
    should(actual.files[0]?.state).equal('ok');
    should(actual.accepted).deepEqual(confirmed);
  });

  it('should put a confirmed machine loosening, Ferretry settings included, in effect', () => {
    // Arrange
    const confirmed = acceptedOf([file('machine.yaml', MACHINE_FERRETRY)]);

    // Act
    const actual = evaluate([file('machine.yaml', MACHINE_FERRETRY)], confirmed);

    // Assert
    should(actual.effective.model.machine.agentControl.ferretrySettings).be.true();
    should(actual.pending).deepEqual([]);
  });

  it('should keep holding the same edit on every evaluation until it is confirmed', () => {
    // Arrange
    const first = evaluate([file('warden.yaml', WARDEN_ON)]);

    // Act
    const second = evaluate([file('warden.yaml', WARDEN_ON)], first.accepted);

    // Assert
    should(second.pending).deepEqual(first.pending);
    should(second.effective.warden.layers.llm).be.false();
  });

  it('should hold a NEW edit over a confirmed one: confirming names one etag only', () => {
    // Arrange
    const confirmed = acceptedOf([file('warden.yaml', WARDEN_ON)]);
    const edited = 'enabled: true\nmaxAssignedWardens: 4\n';

    // Act
    const actual = evaluate([file('warden.yaml', edited)], confirmed);

    // Assert
    should(actual.pending[0]?.etag).equal(digest(edited));
    should(actual.pending[0]?.changes).deepEqual(['the number of wardens that may run at once goes up from 1 to 4']);
    should(actual.effective.warden.layers.llm).be.true();
    should(actual.effective.warden.maxAssignedWardens).equal(1);
  });
});

describe('evaluateConfigFiles: a file that is gone', () => {
  it('should hold a deletion that loosens back to the defaults, with the absent etag', () => {
    // Arrange
    const accepted = acceptedOf([file('learning.yaml', LEARNING_OFF)]);

    // Act
    const actual = evaluate([], accepted);

    // Assert
    should(actual.pending).deepEqual([
      { path: 'learning.yaml', etag: ABSENT_CONFIG_ETAG, changes: ['lesson mining may now spend on agent sessions'] },
    ]);
    should(actual.effective.learning.enabled).be.false();
    should(actual.accepted).deepEqual(accepted);
    should(actual.files).deepEqual([{ path: 'learning.yaml', kind: 'learning', schema: 'learning', state: 'pending' }]);
  });

  it('should hold the deletion of a machine.yaml that kept a switch off', () => {
    // Arrange
    const accepted = acceptedOf([file('machine.yaml', 'agentControl:\n  files: false\n')]);

    // Act
    const actual = evaluate([], accepted);

    // Assert
    should(actual.pending[0]?.changes).deepEqual(['agents may now control project files']);
    should(actual.effective.model.machine.agentControl.files).be.false();
  });

  it('should apply a deletion that tightens, and forget the file', () => {
    // Arrange
    const accepted = acceptedOf([file('warden.yaml', WARDEN_ON), file('machine.yaml', MACHINE_FERRETRY)]);

    // Act
    const actual = evaluate([], accepted);

    // Assert
    should(actual.effective.warden).equal(DEFAULT_WARDEN_CONFIG);
    should(actual.effective.model.machine.agentControl.ferretrySettings).be.false();
    should(actual.accepted).deepEqual({});
    should(actual.pending).deepEqual([]);
    should(actual.files).deepEqual([]);
  });

  it('should apply the deletion of a fleet file that nothing else uses', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);

    // Act
    const actual = evaluate(
      FLEET_FILES.filter(entry => entry.path !== 'runtimes/claude.yaml'),
      accepted,
    );

    // Assert
    should(actual.effective.model.runtimes).deepEqual({});
    should(Object.keys(actual.accepted)).not.containEql('runtimes/claude.yaml');
    should(actual.fleetFiles).equal(3);
    should(actual.issues).deepEqual([]);
  });

  it('should not read a file that is unreadable as a deletion', () => {
    // Arrange
    const accepted = acceptedOf([file('warden.yaml', 'intervalMinutes: 10\n')]);

    // Act
    const actual = evaluate([], accepted, ['warden.yaml']);

    // Assert
    should(actual.pending).deepEqual([]);
    should(actual.effective.warden.intervalMinutes).equal(10);
  });
});

describe('evaluateConfigFiles: the fleet is all or nothing', () => {
  const MISSING_COMPONENT = 'contents:\n  - instructions/main\n  - mcp/missing\n';

  it('should refuse a profile that names a missing component, blaming its file and line, and keep the last fleet', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);
    const base = evaluate(FLEET_FILES, accepted);

    // Act
    const actual = evaluate(withText(FLEET_FILES, 'profiles/default.yaml', MISSING_COMPONENT), accepted);

    // Assert
    should(actual.effective.model).deepEqual(base.effective.model);
    should(actual.fleetRevision).equal(base.fleetRevision);
    should(actual.accepted).deepEqual(accepted);
    should(actual.issues).have.length(1);
    const issue = actual.issues[0];
    should(issue?.path).equal('profiles/default.yaml');
    should(issue?.severity).equal('error');
    should(issue?.line).equal(3);
    should(issue?.message).containEql('unknown mcp component "missing"');
    should(actual.files.find(entry => entry.path === 'profiles/default.yaml')?.state).equal('invalid');
  });

  it('should revert every fleet change of the round and warn the other changed files', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);
    const base = evaluate(FLEET_FILES, accepted);
    const changed = [
      ...withText(
        withText(FLEET_FILES, 'profiles/default.yaml', MISSING_COMPONENT),
        'components/instructions/main.yaml',
        'file: instructions/other.md\n',
      ),
      file('logins/extra.yaml', SECOND_LOGIN_TEXT),
    ];

    // Act
    const actual = evaluate(changed, accepted);

    // Assert
    should(actual.effective.model).deepEqual(base.effective.model);
    should(actual.accepted).deepEqual(accepted);
    should(actual.fleetRevision).equal(base.fleetRevision);
    should(actual.fleetFiles).equal(4);
    const byPath = new Map(actual.issues.map(issue => [issue.path, issue]));
    should(byPath.get('profiles/default.yaml')?.severity).equal('error');
    for (const path of ['components/instructions/main.yaml', 'logins/extra.yaml']) {
      should(byPath.get(path)?.severity).equal('warning');
      should(byPath.get(path)?.message).equal(
        'not in effect yet: this machine keeps its last good fleet until profiles/default.yaml is fixed',
      );
      should(byPath.get(path)?.fix).equal('fix profiles/default.yaml first');
    }
    should(actual.issues).have.length(3);
    const states = Object.fromEntries(actual.files.map(entry => [entry.path, entry.state]));
    should(states).deepEqual({
      'components/instructions/main.yaml': 'invalid',
      'logins/extra.yaml': 'invalid',
      'profiles/default.yaml': 'invalid',
      'runtimes/claude.yaml': 'ok',
      'logins/you.yaml': 'ok',
    });
  });

  it('should give a changed file that was never accepted no effect when the fleet reverts', () => {
    // Arrange — nothing was accepted yet, so the revert target is the empty fleet
    const files = withText(FLEET_FILES, 'profiles/default.yaml', MISSING_COMPONENT);

    // Act
    const actual = evaluate(files);

    // Assert
    should(actual.effective.model).deepEqual(assembleAccountModel([]));
    should(actual.accepted).deepEqual({});
    should(actual.fleetFiles).equal(0);
    should(actual.fleetRevision).equal(ABSENT_CONFIG_ETAG);
    should(actual.files.every(entry => entry.state === 'invalid' || entry.state === 'ok')).be.true();
    should(actual.files.find(entry => entry.path === 'profiles/default.yaml')?.state).equal('invalid');
  });

  it('should name every blamed file, sorted, in the warning for a file that is not at fault', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);
    const changed = [
      ...withText(
        withText(FLEET_FILES, 'profiles/default.yaml', MISSING_COMPONENT),
        'runtimes/claude.yaml',
        'credential: nobody\nprofile: default\n',
      ),
      file('logins/extra.yaml', SECOND_LOGIN_TEXT),
    ];

    // Act
    const actual = evaluate(changed, accepted);

    // Assert
    const warning = actual.issues.find(issue => issue.path === 'logins/extra.yaml');
    should(warning?.message).equal(
      'not in effect yet: this machine keeps its last good fleet until profiles/default.yaml, runtimes/claude.yaml is fixed',
    );
    should(
      actual.issues
        .filter(issue => issue.severity === 'error')
        .map(issue => issue.path)
        .toSorted(),
    ).deepEqual(['profiles/default.yaml', 'runtimes/claude.yaml']);
  });

  it('should refuse the deletion of a login a runtime still uses, and put the login back', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);
    const base = evaluate(FLEET_FILES, accepted);

    // Act
    const actual = evaluate(
      FLEET_FILES.filter(entry => entry.path !== 'logins/you.yaml'),
      accepted,
    );

    // Assert
    should(actual.effective.model).deepEqual(base.effective.model);
    should(actual.accepted).deepEqual(accepted);
    const error = actual.issues.find(issue => issue.severity === 'error');
    should(error?.path).equal('runtimes/claude.yaml');
    should(error?.message).containEql('unknown credential "you"');
    should(error?.line).equal(1);
    const warning = actual.issues.find(issue => issue.severity === 'warning');
    should(warning?.path).equal('logins/you.yaml');
    should(actual.files.map(entry => entry.path)).not.containEql('logins/you.yaml');
  });

  it('should run on nothing when the accepted record itself no longer assembles', () => {
    // Arrange — a runtime accepted without the login it names, as a release that added a rule could leave
    const runtimeOnly = [file('runtimes/claude.yaml', 'credential: you\nprofile: default\n')];
    const accepted = acceptedOf(runtimeOnly);

    // Act
    const actual = evaluate(runtimeOnly, accepted);

    // Assert
    should(actual.effective.model).deepEqual(assembleAccountModel([]));
    should(actual.issues.some(issue => issue.severity === 'error' && issue.path === 'runtimes/claude.yaml')).be.true();
    should(actual.files[0]?.state).equal('invalid');
  });

  it('should blame the file a default-runtime rule is about, with the line of the key', () => {
    // Arrange
    const files = [...FLEET_FILES, file('machine.yaml', 'defaultRuntime: nowhere\n')];

    // Act
    const actual = evaluate(files);

    // Assert
    const error = actual.issues.find(issue => issue.severity === 'error');
    should(error?.path).equal('machine.yaml');
    should(error?.line).equal(1);
    should(error?.message).containEql('"nowhere"');
  });

  it('should not blame the fleet for a Warden or Learning file that changed in the same round', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);

    // Act
    const actual = evaluate(
      [...withText(FLEET_FILES, 'profiles/default.yaml', MISSING_COMPONENT), file('learning.yaml', 'batchSize: 3\n')],
      accepted,
    );

    // Assert
    should(actual.effective.learning.batchSize).equal(3);
    should(actual.issues.map(issue => issue.path)).not.containEql('learning.yaml');
    should(actual.files.find(entry => entry.path === 'learning.yaml')?.state).equal('ok');
  });
});

describe('evaluateConfigFiles: fleetRevision', () => {
  it('should be a digest that does not move while the fleet in effect does not', () => {
    // Act
    const first = evaluate(FLEET_FILES);
    const second = evaluate(FLEET_FILES, first.accepted);

    // Assert
    should(first.fleetRevision).match(/^[0-9a-f]{64}$/u);
    should(second.fleetRevision).equal(first.fleetRevision);
  });

  it('should move when a fleet file in effect changes', () => {
    // Arrange
    const first = evaluate(FLEET_FILES);

    // Act
    const actual = evaluate(
      withText(FLEET_FILES, 'logins/you.yaml', 'harness: claude\nstore: host\nlabel: mine\n'),
      first.accepted,
    );

    // Assert
    should(actual.fleetRevision).not.equal(first.fleetRevision);
  });

  it('should move when a fleet file is added or removed', () => {
    // Arrange
    const first = evaluate(FLEET_FILES);

    // Act
    const added = evaluate([...FLEET_FILES, file('logins/other.yaml', SECOND_LOGIN_TEXT)], first.accepted);
    const removed = evaluate(
      FLEET_FILES.filter(entry => entry.path !== 'runtimes/claude.yaml'),
      first.accepted,
    );

    // Assert
    should(added.fleetRevision).not.equal(first.fleetRevision);
    should(removed.fleetRevision).not.equal(first.fleetRevision);
  });

  it('should NOT move when only a Warden, Learning or Voice file changes', () => {
    // Arrange
    const first = evaluate(FLEET_FILES);

    // Act
    const actual = evaluate([...FLEET_FILES, file('learning.yaml', 'batchSize: 3\n')], first.accepted);

    // Assert
    should(actual.fleetRevision).equal(first.fleetRevision);
  });

  it('should NOT move when a held loosening leaves the fleet in effect as it was', () => {
    // Arrange
    const first = evaluate(FLEET_FILES);

    // Act
    const actual = evaluate([...FLEET_FILES, file('machine.yaml', MACHINE_FERRETRY)], first.accepted);

    // Assert
    should(actual.pending).have.length(1);
    should(actual.effective.model.machine.agentControl.ferretrySettings).be.false();
    should(actual.fleetRevision).not.equal(ABSENT_CONFIG_ETAG);
  });

  it('should NOT move when a refused change leaves the fleet in effect as it was', () => {
    // Arrange
    const first = evaluate(FLEET_FILES);

    // Act
    const actual = evaluate(
      withText(FLEET_FILES, 'profiles/default.yaml', 'contents:\n  - mcp/missing\n'),
      first.accepted,
    );

    // Assert
    should(actual.fleetRevision).equal(first.fleetRevision);
  });

  it('should depend on the text of each file, not only its path', () => {
    // Act
    const one = evaluate([file('logins/you.yaml', LOGIN_TEXT)]);
    const other = evaluate([file('logins/you.yaml', `${LOGIN_TEXT}label: x\n`)]);

    // Assert
    should(one.fleetRevision).not.equal(other.fleetRevision);
  });
});

describe('evaluateConfigFiles: unreadable paths', () => {
  it('should report each, mark it invalid and keep its last good version in effect', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);
    const present = FLEET_FILES.filter(entry => entry.path !== 'runtimes/claude.yaml');

    // Act
    const actual = evaluate(present, accepted, ['runtimes/claude.yaml']);

    // Assert
    should(Object.keys(actual.effective.model.runtimes)).deepEqual(['claude']);
    should(actual.accepted).deepEqual(accepted);
    should(actual.issues).deepEqual([
      {
        path: 'runtimes/claude.yaml',
        severity: 'error',
        message: 'this file is not read: it is a link, or larger than the 256 KiB a configuration file may be',
        fix: 'make it an ordinary file (a copy, not a link) of a sensible size',
      },
    ]);
    should(actual.files.find(entry => entry.path === 'runtimes/claude.yaml')?.state).equal('invalid');
    should(actual.fleetFiles).equal(4);
  });

  it('should give an unreadable file that was never accepted no effect', () => {
    // Act
    const actual = evaluate([], {}, ['warden.yaml']);

    // Assert
    should(actual.effective.warden).equal(DEFAULT_WARDEN_CONFIG);
    should(actual.accepted).deepEqual({});
    should(actual.files).deepEqual([{ path: 'warden.yaml', kind: 'warden', schema: 'warden', state: 'invalid' }]);
    should(actual.issues).have.length(1);
  });

  it('should not keep an accepted version that no longer checks', () => {
    // Arrange
    const accepted = { 'warden.yaml': { etag: 'old', text: 'retiredKey: 1\n' } };

    // Act
    const actual = evaluate([], accepted, ['warden.yaml']);

    // Assert
    should(actual.accepted).deepEqual({});
    should(actual.effective.warden).equal(DEFAULT_WARDEN_CONFIG);
  });

  it('should say a path Ferretry does not classify is not read, as a warning, with no state and no effect', () => {
    // Arrange — a linked `logins` directory lists as paths no file name classifies
    // Act
    const actual = evaluate([], {}, ['notes.yaml', 'sub/dir/other.yaml']);

    // Assert
    should(actual.issues).deepEqual(
      ['notes.yaml', 'sub/dir/other.yaml'].map(path => ({
        path,
        severity: 'warning',
        message: 'this file is not read: it is a link, or larger than the 256 KiB a configuration file may be',
        fix: 'make it an ordinary file (a copy, not a link) of a sensible size',
      })),
    );
    should(actual.files).deepEqual([]);
    should(actual.accepted).deepEqual({});
  });

  it('should keep the error severity for an unreadable path it does classify', () => {
    // Act
    const actual = evaluate([], {}, ['logins/linked.yaml']);

    // Assert
    should(actual.issues.map(issue => issue.severity)).deepEqual(['error']);
    should(actual.files.map(entry => entry.state)).deepEqual(['invalid']);
  });
});

describe('evaluateConfigFiles: provider presets (docs/provider-presets.md)', () => {
  const PRESET = [
    'label: My gateway',
    'harness: claude',
    'summary: Claude Code through my gateway.',
    'docs: https://gateway.example.com/docs',
    'verified: "2026-10-16"',
    'env:',
    '  ANTHROPIC_BASE_URL:',
    '    value: https://gateway.example.com',
    '  ANTHROPIC_AUTH_TOKEN:',
    '    secretName: GATEWAY_API_KEY',
    'test:',
    '  kind: none',
    '  reason: no test yet',
    'quota:',
    '  source: transcript-pricing',
    '  note: counted from the transcript',
    '',
  ].join('\n');

  it("should put a machine's own preset in effect by its file name, apart from the fleet", () => {
    // Act
    const actual = evaluate([file('presets/my-gateway.yaml', PRESET)]);

    // Assert
    should(actual.effective.presets['my-gateway']).containDeep({
      id: 'my-gateway',
      origin: 'file',
      label: 'My gateway',
    });
    should(actual.fleetFiles).equal(0);
    should(actual.files).deepEqual([
      { path: 'presets/my-gateway.yaml', kind: 'preset', schema: 'preset', state: 'ok' },
    ]);
  });

  it('should report a broken preset where it is, and offer nothing from it', () => {
    // Act
    const actual = evaluate([file('presets/broken.yaml', 'label: Broken\n')]);

    // Assert
    should(actual.effective.presets).deepEqual({});
    should(actual.issues.map(issue => issue.path)).containEql('presets/broken.yaml');
  });

  it("should put a machine's own model catalog in effect by its file name (docs/model-catalog.md)", () => {
    // Arrange
    const CATALOG = [
      'label: Pinned GLM',
      'docs: https://docs.z.ai/devpack/tool/claude',
      "verified: '2026-10-18'",
      'claude:',
      '  models:',
      '    - id: glm-5.3',
      '      label: GLM-5.3',
      '      tier: best',
      '      default: true',
      '',
    ].join('\n');

    // Act
    const actual = evaluate([file('models/zai.yaml', CATALOG), file('models/broken.yaml', 'label: Broken\n')]);

    // Assert
    should(actual.effective.modelCatalogs.zai).containDeep({ id: 'zai', origin: 'file', label: 'Pinned GLM' });
    should(actual.effective.modelCatalogs).not.have.property('broken');
    should(actual.files.find(entry => entry.path === 'models/zai.yaml')).containDeep({ kind: 'models', state: 'ok' });
  });
});
