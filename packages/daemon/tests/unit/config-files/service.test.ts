import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { ABSENT_CONFIG_ETAG, type AcceptedConfigFiles, type ConfigFileText } from '@ferretry/fleet';
import type { ConfigIssue, ConfigPending } from '@ferretry/protocol';
import should from 'should';
import {
  ACKNOWLEDGEMENT_TTL_MS,
  type AcceptedConfigStore,
  type ConfigDirectoryPort,
  ConfigFileConflictError,
  ConfigFileInvalidError,
  ConfigFilesService,
} from '../../../src/lib/config-files/index.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

const WARDEN_OFF = '# the Warden, rules only\nlayers:\n  llm: false\n';
const WARDEN_ON = '# the Warden, investigating every flag\nlayers:\n  llm: true\n';
const WARDEN_BROKEN = 'layers: [\n';
const WARDEN_UNKNOWN_KEY = 'enabled: true\nsurprise: 1\n';
const LEARNING_OFF = 'enabled: false\n';
const MACHINE_SKIP = 'agentPermissions: skip\n';

class FakeDirectory implements ConfigDirectoryPort {
  readonly directory = '/home/owner/.fy/config';
  readonly files = new Map<string, string>();
  unreadable: string[] = [];
  readonly schemaWrites: ReadonlyMap<string, string>[] = [];
  writes = 0;
  lists = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(initial)) this.files.set(path, text);
  }

  async list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }> {
    this.lists += 1;
    return {
      files: [...this.files.entries()].map(([path, text]) => ({ path, text })),
      unreadable: [...this.unreadable],
    };
  }

  async fingerprint(): Promise<string> {
    return [...this.files.entries()].map(([path, text]) => `${path}:${digest(text)}`).join('\n');
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    this.writes += 1;
    this.files.set(path, text);
  }

  async remove(path: string): Promise<void> {
    this.writes += 1;
    this.files.delete(path);
  }

  async writeSchemas(schemas: ReadonlyMap<string, string>): Promise<void> {
    this.schemaWrites.push(schemas);
  }
}

class FakeAccepted implements AcceptedConfigStore {
  writes = 0;
  constructor(public value: AcceptedConfigFiles = {}) {}

  async read(): Promise<AcceptedConfigFiles> {
    return this.value;
  }

  async write(accepted: AcceptedConfigFiles): Promise<void> {
    this.writes += 1;
    this.value = accepted;
  }
}

class FakeLog {
  readonly issued: ConfigIssue[] = [];
  readonly held: ConfigPending[] = [];
  issue(issue: ConfigIssue): void {
    this.issued.push(issue);
  }
  pending(pending: ConfigPending): void {
    this.held.push(pending);
  }
}

const setup = (files: Record<string, string> = {}, accepted: AcceptedConfigFiles = {}) => {
  const directory = new FakeDirectory(files);
  const store = new FakeAccepted(accepted);
  const log = new FakeLog();
  const at = new Date('2026-10-16T09:00:00.000Z');
  const clock = { now: at };
  const service = new ConfigFilesService({
    directory,
    accepted: store,
    log: { issue: issue => log.issue(issue), pending: pending => log.pending(pending) },
    digest,
    now: () => clock.now,
  });
  /** Move the service's clock forward. */
  const advance = (ms: number): void => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { directory, store, log, service, at, advance };
};

/** What a promise rejected with; fails when it resolved. */
const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => should.fail('resolved', 'rejected', 'expected a rejection'),
    (error: unknown) => error,
  );

const acceptedAs = (path: string, text: string): AcceptedConfigFiles => ({ [path]: { etag: digest(text), text } });

describe('ConfigFilesService before any load', () => {
  it('should answer the configuration of an empty directory, every setting at its default', () => {
    // Arrange
    const { service, at } = setup({ 'warden.yaml': WARDEN_ON }, acceptedAs('warden.yaml', WARDEN_ON));

    // Act
    const snapshot = service.current();

    // Assert
    should(snapshot.evaluation.effective.warden.layers.llm).be.false();
    should(snapshot.files.size).equal(0);
    should(snapshot.at).equal(at);
    should(service.current()).equal(snapshot);
  });
});

describe('ConfigFilesService.load', () => {
  it('should put a valid file into effect and remember it as accepted', async () => {
    // Arrange
    const { service, store } = setup({ 'learning.yaml': LEARNING_OFF });

    // Act
    const snapshot = await service.load();

    // Assert
    should(snapshot.evaluation.effective.learning.enabled).be.false();
    should(store.value).eql(acceptedAs('learning.yaml', LEARNING_OFF));
    should(snapshot.files.get('learning.yaml')).eql({ text: LEARNING_OFF, etag: digest(LEARNING_OFF) });
    should(service.current()).equal(snapshot);
  });

  it('should keep the last good version in effect when the file breaks, across repeated loads', async () => {
    // Arrange
    const { service, directory, store } = setup({ 'warden.yaml': WARDEN_ON }, acceptedAs('warden.yaml', WARDEN_ON));
    directory.files.set('warden.yaml', WARDEN_BROKEN);

    // Act
    const first = await service.load();
    const second = await service.load();

    // Assert
    for (const snapshot of [first, second]) {
      should(snapshot.evaluation.effective.warden.layers.llm).be.true();
      should(snapshot.evaluation.files).containDeep([{ path: 'warden.yaml', state: 'invalid' }]);
    }
    should(store.value).eql(acceptedAs('warden.yaml', WARDEN_ON));
  });

  it('should not rewrite the accepted record when nothing it holds changed', async () => {
    // Arrange
    const { service, store } = setup({ 'learning.yaml': LEARNING_OFF }, acceptedAs('learning.yaml', LEARNING_OFF));

    // Act
    await service.load();
    await service.load();

    // Assert
    should(store.writes).equal(0);
  });

  it('should hold a loosening edit made on disk, the tighter version staying in effect', async () => {
    // Arrange
    const { service } = setup({ 'warden.yaml': WARDEN_ON }, acceptedAs('warden.yaml', WARDEN_OFF));

    // Act
    const snapshot = await service.load();

    // Assert
    should(snapshot.evaluation.effective.warden.layers.llm).be.false();
    should(snapshot.evaluation.pending).containDeep([{ path: 'warden.yaml', etag: digest(WARDEN_ON) }]);
  });

  it('should tell the log each issue and held edit once, and again after it clears and returns', async () => {
    // Arrange
    const { service, directory, log } = setup({ 'learning.yaml': WARDEN_UNKNOWN_KEY, 'warden.yaml': WARDEN_ON });

    // Act
    await service.load();
    await service.load();
    const afterRepeat = { issues: log.issued.length, pending: log.held.length };
    directory.files.set('learning.yaml', LEARNING_OFF);
    directory.files.delete('warden.yaml');
    await service.load();
    const afterClear = { issues: log.issued.length, pending: log.held.length };
    directory.files.set('learning.yaml', WARDEN_UNKNOWN_KEY);
    directory.files.set('warden.yaml', WARDEN_ON);
    await service.load();

    // Assert
    should(afterRepeat).eql({ issues: 1, pending: 1 });
    should(log.issued[0]).containDeep({ path: 'learning.yaml', severity: 'error' });
    should(log.held[0]).containDeep({ path: 'warden.yaml', etag: digest(WARDEN_ON) });
    should(afterClear).eql({ issues: 1, pending: 1 });
    should({ issues: log.issued.length, pending: log.held.length }).eql({ issues: 2, pending: 2 });
  });

  it('should report an unreadable file and keep its last good version', async () => {
    // Arrange
    const { service, directory } = setup({}, acceptedAs('warden.yaml', WARDEN_ON));
    directory.unreadable = ['warden.yaml'];

    // Act
    const snapshot = await service.load();

    // Assert
    should(snapshot.evaluation.effective.warden.layers.llm).be.true();
    should(snapshot.evaluation.issues).containDeep([{ path: 'warden.yaml', severity: 'error' }]);
    should(snapshot.unreadable).eql(['warden.yaml']);
  });
});

describe('ConfigFilesService.inEffect', () => {
  it('should load on the first read only, with every concurrent first reader sharing that one load', async () => {
    // Arrange
    const { directory, service } = setup({ 'learning.yaml': LEARNING_OFF });

    // Act
    const [first, second] = await Promise.all([service.inEffect(), service.inEffect()]);
    const later = await service.inEffect();

    // Assert
    should(directory.lists).equal(1);
    should(first).equal(second);
    should(later).equal(first);
    should(later.evaluation.effective.learning.enabled).be.false();
  });

  it('should answer the last load without touching the directory, until something loads again', async () => {
    // Arrange — every reader used to list, read and evaluate the whole tree again.
    const { directory, service } = setup();
    await service.load();
    directory.files.set('learning.yaml', LEARNING_OFF);

    // Act
    const cached = await service.inEffect();
    await service.load();
    const reloaded = await service.inEffect();

    // Assert
    should(cached.evaluation.effective.learning.enabled).be.true();
    should(reloaded.evaluation.effective.learning.enabled).be.false();
    should(directory.lists).equal(2);
  });

  it('should load again on the next read once the tree has reported a change, and only once', async () => {
    // Arrange
    const { directory, service } = setup();
    await service.inEffect();
    directory.files.set('learning.yaml', LEARNING_OFF);

    // Act
    service.invalidate();
    const [first, second] = await Promise.all([service.inEffect(), service.inEffect()]);
    const settled = await service.inEffect();

    // Assert
    should(first.evaluation.effective.learning.enabled).be.false();
    should(second).equal(first);
    should(settled).equal(first);
    should(directory.lists).equal(2);
  });

  it('should load again when a change is reported while a load is running', async () => {
    // Arrange — the flag is cleared when a load BEGINS, so a change it may have missed is not lost.
    const { directory, service } = setup();
    const list = directory.list.bind(directory);
    directory.list = async () => {
      if (directory.lists === 0) service.invalidate();
      return await list();
    };
    await service.inEffect();

    // Act
    await service.inEffect();
    await service.inEffect();

    // Assert — the change reported mid-scan costs exactly one more load.
    should(directory.lists).equal(2);
  });

  it("should answer this daemon's own write at once, with no watcher in between", async () => {
    // Arrange
    const { service } = setup();
    await service.inEffect();

    // Act
    await service.writeOwn('learning.yaml', LEARNING_OFF);

    // Assert
    should((await service.inEffect()).evaluation.effective.learning.enabled).be.false();
  });
});

describe('ConfigFilesService.status', () => {
  it('should answer the directory, every file, issue and held edit, and when it checked', async () => {
    // Arrange
    const { service, at } = setup({ 'learning.yaml': WARDEN_UNKNOWN_KEY, 'warden.yaml': WARDEN_ON });

    // Act
    const status = await service.status();

    // Assert
    should(status.directory).equal('/home/owner/.fy/config');
    should(status.files.map(file => file.path)).eql(['learning.yaml', 'warden.yaml']);
    should(status.issues).containDeep([{ path: 'learning.yaml' }]);
    should(status.pending).containDeep([{ path: 'warden.yaml' }]);
    should(status.checkedAt).equal(at.toISOString());
  });
});

describe('ConfigFilesService.file', () => {
  it('should answer a file on disk with its etag, state and own issues', async () => {
    // Arrange
    const { service } = setup({ 'learning.yaml': WARDEN_UNKNOWN_KEY, 'warden.yaml': WARDEN_OFF });

    // Act
    const view = await service.file('learning.yaml');

    // Assert
    should(view).containDeep({
      path: 'learning.yaml',
      absolutePath: '/home/owner/.fy/config/learning.yaml',
      kind: 'learning',
      schema: 'learning',
      exists: true,
      text: WARDEN_UNKNOWN_KEY,
      etag: digest(WARDEN_UNKNOWN_KEY),
      state: 'invalid',
    });
    should(view.issues.length).be.above(0);
    should(view.issues.every(issue => issue.path === 'learning.yaml')).be.true();
  });

  it('should answer the starter and the absent etag for a file that does not exist', async () => {
    // Arrange
    const { service } = setup();

    // Act
    const view = await service.file('profiles/work.yaml');

    // Assert
    should(view).containDeep({
      path: 'profiles/work.yaml',
      kind: 'profile',
      exists: false,
      etag: ABSENT_CONFIG_ETAG,
      state: 'ok',
      issues: [],
    });
    should(view.text).startWith('# yaml-language-server: $schema=../.schema/profile.json\n');
    should(view.text).containEql('contents: []');
  });

  it('should refuse a path Ferretry does not read', async () => {
    // Arrange
    const { service } = setup();

    // Act
    const outside = await rejection(service.file('notes.txt'));
    const schema = await rejection(service.file('.schema/warden.yaml'));

    // Assert
    should(outside).be.instanceOf(ConfigFileInvalidError);
    should((outside as ConfigFileInvalidError).issues).containDeep([
      { path: 'notes.txt', severity: 'error', message: 'Ferretry does not read this file' },
    ]);
    should(schema).be.instanceOf(ConfigFileInvalidError);
  });
});

describe('ConfigFilesService.validate', () => {
  it('should report only the target file`s issues, never another broken file`s', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_BROKEN });

    // Act
    const good = await service.validate('learning.yaml', LEARNING_OFF);
    const bad = await service.validate('learning.yaml', WARDEN_UNKNOWN_KEY);

    // Assert
    should(good).eql([]);
    should(bad.length).be.above(0);
    should(bad.every(issue => issue.path === 'learning.yaml')).be.true();
    should(directory.writes).equal(0);
  });

  it('should judge the candidate against the rest of the directory', async () => {
    // Arrange
    const { service } = setup();

    // Act
    const issues = await service.validate('profiles/work.yaml', 'contents:\n  - instructions/missing\n');

    // Assert
    should(issues).containDeep([{ path: 'profiles/work.yaml', severity: 'error' }]);
  });

  it('should keep an unreadable component`s last good version in the trial, so a profile naming it checks', async () => {
    // Arrange
    const component = 'command: npx\n';
    const { service, directory } = setup({}, acceptedAs('components/mcp/gh.yaml', component));
    directory.unreadable = ['components/mcp/gh.yaml'];

    // Act
    const issues = await service.validate('profiles/work.yaml', 'contents:\n  - mcp/gh\n');

    // Assert
    should(issues).eql([]);
  });
});

describe('ConfigFilesService.write', () => {
  it('should apply a tightening at once', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_ON }, acceptedAs('warden.yaml', WARDEN_ON));

    // Act
    const outcome = await service.write('warden.yaml', WARDEN_OFF, digest(WARDEN_ON), false);

    // Assert
    should(outcome).eql({ etag: digest(WARDEN_OFF), outcome: 'applied', loosened: false });
    should(directory.files.get('warden.yaml')).equal(WARDEN_OFF);
    should(service.current().evaluation.effective.warden.layers.llm).be.false();
  });

  it('should write a loosening but hold it when the caller may not confirm it', async () => {
    // Arrange
    const { service, directory, store } = setup({ 'warden.yaml': WARDEN_OFF });

    // Act
    const outcome = await service.write('warden.yaml', WARDEN_ON, undefined, false);

    // Assert
    should(outcome).containDeep({ etag: digest(WARDEN_ON), outcome: 'pending', loosened: false });
    should(outcome.pending?.changes).eql(['the Warden may now spend on AI investigations']);
    should(directory.files.get('warden.yaml')).equal(WARDEN_ON);
    should(store.value).eql(acceptedAs('warden.yaml', WARDEN_OFF));
    should(service.current().evaluation.effective.warden.layers.llm).be.false();
  });

  it('should put a loosening into effect and say so when the caller may confirm it', async () => {
    // Arrange
    const { service, store } = setup({ 'warden.yaml': WARDEN_OFF });

    // Act
    const outcome = await service.write('warden.yaml', WARDEN_ON, digest(WARDEN_OFF), true);

    // Assert
    should(outcome).eql({ etag: digest(WARDEN_ON), outcome: 'applied', loosened: true });
    should(store.value).eql(acceptedAs('warden.yaml', WARDEN_ON));
    should(service.current().evaluation.effective.warden.layers.llm).be.true();
  });

  it('should judge a machine loosening against the machine in effect', async () => {
    // Arrange
    const { service } = setup();

    // Act
    const held = await service.write('machine.yaml', MACHINE_SKIP, ABSENT_CONFIG_ETAG, false);

    // Assert
    should(held.outcome).equal('pending');
    should(held.pending?.changes).eql(['agents now skip every permission prompt']);
    should(service.current().evaluation.effective.model.machine.agentPermissions).equal('auto');
  });

  it("should hold a runtime written off a budgeted login, and take the owner's reviewed removal of the login", async () => {
    // Arrange
    const login = 'harness: claude\nstore: ferretry\nbudget:\n  daily:\n    hard: 60\n';
    const home = 'harness: claude\nstore: host\n';
    const runtime = 'credential: liftoff\nprofile: default\nagent: true\n';
    const files = {
      'logins/liftoff.yaml': login,
      'logins/home.yaml': home,
      'profiles/default.yaml': 'contents: []\n',
      'runtimes/claude-liftoff.yaml': runtime,
    };
    const accepted = Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path, { etag: digest(text), text }]),
    );
    const { service, directory } = setup(files, accepted);
    await service.load();

    // Act
    const moved = await service.write(
      'runtimes/claude-liftoff.yaml',
      'credential: home\nprofile: default\nagent: true\n',
      digest(runtime),
      false,
    );

    // Assert: re-pointed by an editor that may not confirm, it waits and the runtime stays on the budget.
    should(moved.outcome).equal('pending');
    should(moved.pending?.changes).eql([
      'runtime "claude-liftoff" moves off login "liftoff", whose budget counts and stops it, to "home"',
    ]);
    should(service.current().evaluation.effective.model.runtimes['claude-liftoff']?.credential).equal('liftoff');

    // A deletion nobody reviewed is held; the owner's reviewed removal of both files goes through.
    await directory.remove('runtimes/claude-liftoff.yaml');
    await directory.remove('logins/liftoff.yaml');
    const held = await service.load();
    should(held.evaluation.pending.map(item => item.path).toSorted()).eql([
      'logins/liftoff.yaml',
      'runtimes/claude-liftoff.yaml',
    ]);
    service.acknowledgeRemoval('runtimes/claude-liftoff.yaml');
    service.acknowledgeRemoval('logins/liftoff.yaml');
    const removed = await service.load();
    should(removed.evaluation.pending).eql([]);
    should(removed.evaluation.effective.model.credentials.liftoff).be.undefined();
  });

  it('should hold a raised login budget and apply a lowered one, judged against the login in effect', async () => {
    // Arrange
    const tight = 'harness: claude\nstore: ferretry\nbudget:\n  daily:\n    trigger: 40\n';
    const raised = 'harness: claude\nstore: ferretry\nbudget:\n  daily:\n    trigger: 400\n';
    const lowered = 'harness: claude\nstore: ferretry\nbudget:\n  daily:\n    trigger: 20\n';
    const { service } = setup({ 'logins/liftoff.yaml': tight }, acceptedAs('logins/liftoff.yaml', tight));

    // Act
    const held = await service.write('logins/liftoff.yaml', raised, digest(tight), false);
    const applied = await service.write('logins/liftoff.yaml', lowered, digest(raised), false);

    // Assert
    should(held.outcome).equal('pending');
    should(held.pending?.changes).eql(['login "liftoff"\'s daily trigger in dollars goes up from 40 to 400']);
    should(applied).eql({ etag: digest(lowered), outcome: 'applied', loosened: false });
    should(service.current().evaluation.effective.model.credentials.liftoff?.budget).eql({ daily: { trigger: 20 } });
  });

  it('should never treat a non-singleton file as a loosening', async () => {
    // Arrange
    const { service } = setup();

    // Act
    const outcome = await service.write('profiles/work.yaml', 'contents: []\n', undefined, false);

    // Assert
    should(outcome).eql({ etag: digest('contents: []\n'), outcome: 'applied', loosened: false });
  });

  it('should refuse a write against a version that is no longer there, writing nothing', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_OFF });

    // Act
    const moved = await rejection(service.write('warden.yaml', WARDEN_ON, digest('something older'), true));
    const absent = await rejection(service.write('learning.yaml', LEARNING_OFF, digest(LEARNING_OFF), true));

    // Assert
    should(moved).be.instanceOf(ConfigFileConflictError);
    should(moved).containDeep({
      path: 'warden.yaml',
      message: 'warden.yaml changed since it was read; read it again and redo the edit',
    });
    should(absent).be.instanceOf(ConfigFileConflictError);
    should(directory.writes).equal(0);
  });

  it('should refuse an invalid write whole with every located issue, writing nothing', async () => {
    // Arrange
    const { service, directory, store } = setup({ 'learning.yaml': LEARNING_OFF });

    // Act
    const refusal = await rejection(service.write('learning.yaml', WARDEN_UNKNOWN_KEY, undefined, true));

    // Assert
    should(refusal).be.instanceOf(ConfigFileInvalidError);
    const error = refusal as ConfigFileInvalidError;
    should(error.issues).containDeep([{ path: 'learning.yaml', severity: 'error', line: 2 }]);
    should(error.message).match(/^the file does not check: learning\.yaml:2 /);
    should(directory.writes).equal(0);
    should(directory.files.get('learning.yaml')).equal(LEARNING_OFF);
    should(store.value).eql(acceptedAs('learning.yaml', LEARNING_OFF));
  });

  it('should refuse a path Ferretry does not read', async () => {
    // Arrange
    const { service } = setup();

    // Act / Assert
    await should(service.write('notes.txt', 'x', undefined, true)).be.rejectedWith(
      'the file does not check: notes.txt Ferretry does not read this file',
    );
  });
});

describe('ConfigFilesService.acknowledge and writeOwn', () => {
  it('should put a written loosening into effect without a hold on the first load that finds its bytes', async () => {
    // Arrange
    const { service, directory, log, store } = setup({ 'warden.yaml': WARDEN_OFF });
    await service.load();

    // Act
    service.acknowledge('warden.yaml', WARDEN_ON);
    directory.files.set('warden.yaml', WARDEN_ON);
    const snapshot = await service.load();

    // Assert
    should(snapshot.evaluation.pending).eql([]);
    should(snapshot.evaluation.effective.warden.layers.llm).be.true();
    should(store.value).eql(acceptedAs('warden.yaml', WARDEN_ON));
    should(log.held).eql([]);
  });

  it('should consume an acknowledgement once, so the same bytes written again later are judged afresh', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_OFF });
    service.acknowledge('warden.yaml', WARDEN_ON);
    directory.files.set('warden.yaml', WARDEN_ON);
    await service.load();

    // Act
    directory.files.set('warden.yaml', WARDEN_OFF);
    await service.load();
    directory.files.set('warden.yaml', WARDEN_ON);
    const snapshot = await service.load();

    // Assert
    should(snapshot.evaluation.pending).containDeep([{ path: 'warden.yaml', etag: digest(WARDEN_ON) }]);
    should(snapshot.evaluation.effective.warden.layers.llm).be.false();
  });

  it('should not consume an acknowledgement when the bytes on disk differ, and honour it once they match', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_OFF });
    const other = 'enabled: true\nmaxAssignedWardens: 2\n';
    service.acknowledge('warden.yaml', WARDEN_ON);

    // Act
    directory.files.set('warden.yaml', other);
    const differing = await service.load();
    directory.files.set('warden.yaml', WARDEN_ON);
    const matching = await service.load();

    // Assert
    should(differing.evaluation.pending).containDeep([{ path: 'warden.yaml', etag: digest(other) }]);
    should(differing.evaluation.effective.warden.layers.llm).be.false();
    should(matching.evaluation.pending).eql([]);
    should(matching.evaluation.effective.warden.layers.llm).be.true();
  });

  it('should let an acknowledged removal that never landed lapse, a later deletion then held', async () => {
    // Arrange: a budgeted login, in effect; its removal acknowledged by an apply that was then refused.
    const login = 'harness: claude\nstore: ferretry\nbudget:\n  daily:\n    hard: 60\n';
    const { service, directory, advance } = setup(
      { 'logins/liftoff.yaml': login },
      { 'logins/liftoff.yaml': { etag: digest(login), text: login } },
    );
    service.acknowledgeRemoval('logins/liftoff.yaml');

    // Act
    advance(ACKNOWLEDGEMENT_TTL_MS + 1);
    await service.load();
    await directory.remove('logins/liftoff.yaml');
    const snapshot = await service.load();

    // Assert
    should(snapshot.evaluation.pending.map(item => item.path)).eql(['logins/liftoff.yaml']);
    should(snapshot.evaluation.effective.model.credentials.liftoff?.budget).eql({ daily: { hard: 60 } });
  });

  it('should let an acknowledgement lapse after its time to live, the loosening then held', async () => {
    // Arrange
    const { service, directory, advance } = setup({ 'warden.yaml': WARDEN_OFF });
    service.acknowledge('warden.yaml', WARDEN_ON);

    // Act
    advance(ACKNOWLEDGEMENT_TTL_MS);
    const stillLive = await service.load();
    advance(1);
    await service.load();
    directory.files.set('warden.yaml', WARDEN_ON);
    const snapshot = await service.load();

    // Assert
    should(ACKNOWLEDGEMENT_TTL_MS).equal(10 * 60_000);
    should(stillLive.evaluation.effective.warden.layers.llm).be.false();
    should(snapshot.evaluation.pending).containDeep([{ path: 'warden.yaml', etag: digest(WARDEN_ON) }]);
    should(snapshot.evaluation.effective.warden.layers.llm).be.false();
  });

  it('should not touch the accepted record until a load finds the acknowledged bytes', async () => {
    // Arrange
    const { service, store } = setup({}, acceptedAs('learning.yaml', LEARNING_OFF));

    // Act
    service.acknowledge('warden.yaml', WARDEN_ON);

    // Assert
    should(store.writes).equal(0);
    should(store.value).eql(acceptedAs('learning.yaml', LEARNING_OFF));
  });

  it('should write a file the daemon owns and have it in effect at once', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_OFF });

    // Act
    await service.writeOwn('warden.yaml', WARDEN_ON);

    // Assert
    should(directory.files.get('warden.yaml')).equal(WARDEN_ON);
    should(service.current().evaluation.effective.warden.layers.llm).be.true();
    should(service.current().evaluation.pending).eql([]);
  });

  it('should record the version in effect apart from the file, so a held edit stays held', async () => {
    // Arrange: the corrected price waits for the owner while $2 is in effect.
    const priced = (usd: number, cap: number): string =>
      `guard:\n  usdPerMillionInputTokens: ${usd}\ncaps:\n  jevUsdPerDay: ${cap}\n`;
    const { service, directory, store } = setup(
      { 'warden.yaml': priced(0.042, 0.5) },
      acceptedAs('warden.yaml', priced(2, 0.5)),
    );
    await service.load();

    // Act: the owner raises the daily cap; the held price travels in the file, not in the record.
    await service.writeOwn('warden.yaml', priced(0.042, 1), priced(2, 1));

    // Assert
    should(directory.files.get('warden.yaml')).equal(priced(0.042, 1));
    should(store.value).eql(acceptedAs('warden.yaml', priced(2, 1)));
    const { effective, pending } = service.current().evaluation;
    should(effective.warden.caps.jevUsdPerDay).equal(1);
    should(effective.warden.guard.usdPerMillionInputTokens).equal(2);
    should(pending).containDeep([{ path: 'warden.yaml', etag: digest(priced(0.042, 1)) }]);
  });

  it('should put the file into effect when the version in effect it is written beside no longer holds it', async () => {
    // Arrange: a held edit the owner's own change has caught up with.
    const { service, store } = setup({ 'warden.yaml': WARDEN_ON }, acceptedAs('warden.yaml', WARDEN_OFF));
    await service.load();

    // Act
    await service.writeOwn('warden.yaml', WARDEN_ON, `${WARDEN_ON}# the owner's own copy\n`);

    // Assert
    should(service.current().evaluation.pending).eql([]);
    should(service.current().evaluation.effective.warden.layers.llm).be.true();
    should(store.value).eql(acceptedAs('warden.yaml', WARDEN_ON));
  });
});

describe('ConfigFilesService.confirm', () => {
  it('should put a held edit into effect only for the exact etag that was reviewed', async () => {
    // Arrange
    const { service, store } = setup({ 'warden.yaml': WARDEN_ON }, acceptedAs('warden.yaml', WARDEN_OFF));

    // Act
    const stale = await service.confirm('warden.yaml', digest(WARDEN_OFF));
    const afterStale = service.current().evaluation.effective.warden.layers.llm;
    const confirmed = await service.confirm('warden.yaml', digest(WARDEN_ON));
    const again = await service.confirm('warden.yaml', digest(WARDEN_ON));

    // Assert
    should(stale).be.false();
    should(afterStale).be.false();
    should(confirmed).be.true();
    should(again).be.false();
    should(service.current().evaluation.effective.warden.layers.llm).be.true();
    should(store.value).eql(acceptedAs('warden.yaml', WARDEN_ON));
  });

  it('should confirm the deletion of a singleton that loosened by going back to its defaults', async () => {
    // Arrange
    const { service, store } = setup({}, acceptedAs('learning.yaml', LEARNING_OFF));
    const before = await service.load();

    // Act
    const confirmed = await service.confirm('learning.yaml', ABSENT_CONFIG_ETAG);

    // Assert
    should(before.evaluation.pending).containDeep([{ path: 'learning.yaml', etag: ABSENT_CONFIG_ETAG }]);
    should(before.evaluation.effective.learning.enabled).be.false();
    should(confirmed).be.true();
    should(store.value).eql({});
    should(service.current().evaluation.effective.learning.enabled).be.true();
  });
});

describe('ConfigFilesService.discard', () => {
  it('should put the version in effect back over the held edit, only for the reviewed etag', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_ON }, acceptedAs('warden.yaml', WARDEN_OFF));

    // Act
    const stale = await service.discard('warden.yaml', digest(WARDEN_OFF));
    const discarded = await service.discard('warden.yaml', digest(WARDEN_ON));
    const again = await service.discard('warden.yaml', digest(WARDEN_ON));

    // Assert
    should(stale).be.false();
    should(discarded).be.true();
    should(again).be.false();
    should(directory.files.get('warden.yaml')).equal(WARDEN_OFF);
    should((await service.load()).evaluation.pending).be.empty();
    should(service.current().evaluation.effective.warden.layers.llm).be.false();
  });

  it('should remove a new file that loosened and was never in effect', async () => {
    // Arrange
    const { service, directory } = setup({ 'machine.yaml': MACHINE_SKIP });

    // Act
    const discarded = await service.discard('machine.yaml', digest(MACHINE_SKIP));

    // Assert
    should(discarded).be.true();
    should(directory.files.has('machine.yaml')).be.false();
    should((await service.load()).evaluation.pending).be.empty();
  });

  it('should write back a file whose deletion was held', async () => {
    // Arrange
    const { service, directory } = setup({}, acceptedAs('learning.yaml', LEARNING_OFF));

    // Act
    const discarded = await service.discard('learning.yaml', ABSENT_CONFIG_ETAG);

    // Assert
    should(discarded).be.true();
    should(directory.files.get('learning.yaml')).equal(LEARNING_OFF);
    should((await service.load()).evaluation.pending).be.empty();
  });
});

describe('ConfigFilesService fingerprint and schemas', () => {
  it('should answer the directory`s fingerprint and pass the schemas to it', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_OFF });
    const schemas = new Map([['warden', '{}']]);

    // Act
    const fingerprint = await service.fingerprint();
    await service.publishSchemas(schemas);

    // Assert
    should(fingerprint).equal(await directory.fingerprint());
    should(directory.schemaWrites).eql([schemas]);
  });
});

describe('ConfigFilesService serialisation', () => {
  it('should keep running queued work after one of it fails', async () => {
    // Arrange
    const { service, directory } = setup({ 'warden.yaml': WARDEN_OFF });
    const list = directory.list.bind(directory);
    let fail = true;
    directory.list = async () => {
      if (fail) {
        fail = false;
        throw new Error('disk gone');
      }
      return await list();
    };

    // Act
    const failed = service.load();
    const next = service.load();

    // Assert
    await should(failed).be.rejectedWith('disk gone');
    should((await next).evaluation.effective.warden.layers.llm).be.false();
  });
});
