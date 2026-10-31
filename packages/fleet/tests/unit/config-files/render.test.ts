import { describe, it } from 'bun:test';
import {
  type ConfigFileAddress,
  configFilePath,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_WARDEN_CONFIG,
} from '@ferretry/protocol';
import should from 'should';
import { type AccountModel, parseAccountModel } from '../../../src/lib/account/schema.ts';
import { checkConfigFile } from '../../../src/lib/config-files/check.ts';
import { ABSENT_CONFIG_ETAG } from '../../../src/lib/config-files/evaluate.ts';
import { SINGLETON_DEFAULTS } from '../../../src/lib/config-files/kinds.ts';
import {
  type ConfigFileOnDisk,
  fleetFileEdits,
  renamedRuntimeMentions,
  renderConfigFile,
} from '../../../src/lib/config-files/render.ts';
import { digest } from './support.ts';

const MACHINE: ConfigFileAddress = { kind: 'machine' };
const WARDEN: ConfigFileAddress = { kind: 'warden' };
const LOGIN: ConfigFileAddress = { kind: 'login', name: 'me' };

const MACHINE_MODELINE = '# yaml-language-server: $schema=.schema/machine.json';

/** What a checked file means, for rendering back. */
const meaning = (path: string, text: string) => {
  const checked = checkConfigFile(path, text);
  if (!checked.ok) throw new Error(`fixture ${path} does not check`);
  return checked.value;
};

describe('renderConfigFile: nothing to write', () => {
  it('should answer undefined when an existing file already means the value', () => {
    // Arrange
    const existing = '# mine\nagentPermissions: skip\n';

    // Act
    const actual = renderConfigFile('machine.yaml', MACHINE, meaning('machine.yaml', existing), existing);

    // Assert
    should(actual).be.undefined();
  });

  it('should answer undefined when an existing file spells out a default the value also has', () => {
    // Arrange
    const existing = 'agentPermissions: auto\nagentControl:\n  terminals: true\n';

    // Act
    const actual = renderConfigFile('machine.yaml', MACHINE, SINGLETON_DEFAULTS.machine, existing);

    // Assert
    should(actual).be.undefined();
  });

  it('should answer undefined for an absent singleton whose value is its defaults', () => {
    // Act
    const actual = renderConfigFile('machine.yaml', MACHINE, SINGLETON_DEFAULTS.machine, undefined);

    // Assert
    should(actual).be.undefined();
  });

  it.each([
    ['warden.yaml', { kind: 'warden' }, DEFAULT_WARDEN_CONFIG],
    ['learning.yaml', { kind: 'learning' }, SINGLETON_DEFAULTS.learning],
    ['voice.yaml', { kind: 'voice' }, SINGLETON_DEFAULTS.voice],
  ] as const)('should not create %s just to say its defaults', (path, address, value) => {
    // Act
    const actual = renderConfigFile(path, address, value, undefined);

    // Assert
    should(actual).be.undefined();
  });
});

describe('renderConfigFile: a new file', () => {
  it('should write a login that does not exist yet, with its modeline first', () => {
    // Arrange
    const input = { harness: 'claude', store: 'host', label: 'mine' } as const;

    // Act
    const actual = renderConfigFile('logins/me.yaml', LOGIN, input, undefined) as string;

    // Assert
    should(actual.split('\n')[0]).equal('# yaml-language-server: $schema=../.schema/login.json');
    should(meaning('logins/me.yaml', actual)).deepEqual(input);
  });

  it('should write a changed singleton that has no file yet, keeping out the defaults', () => {
    // Arrange
    const input = {
      ...SINGLETON_DEFAULTS.machine,
      machine: { ...SINGLETON_DEFAULTS.machine.machine, agentPermissions: 'skip' },
    } as const;

    // Act
    const actual = renderConfigFile('machine.yaml', MACHINE, input, undefined) as string;

    // Assert
    should(actual.split('\n')[0]).equal(MACHINE_MODELINE);
    should(actual).containEql('agentPermissions: skip');
    should(actual).not.containEql('terminals');
    should(actual).not.containEql('advanced');
    should(meaning('machine.yaml', actual)).deepEqual(input);
  });

  it('should write only the keys that differ from the Warden defaults', () => {
    // Act
    const actual = renderConfigFile(
      'warden.yaml',
      WARDEN,
      { ...DEFAULT_WARDEN_CONFIG, enabled: false },
      undefined,
    ) as string;

    // Assert
    should(actual.split('\n').filter(line => !line.startsWith('#') && line !== '')).deepEqual(['enabled: false']);
  });
});

describe('renderConfigFile: an existing file', () => {
  it('should change the one key and keep the owner’s comments and order', () => {
    // Arrange
    const existing =
      '# my machine\nagentControl:\n  # keep terminals on\n  terminals: true # same line\nagentPermissions: auto # prompts\n';
    const value = {
      ...SINGLETON_DEFAULTS.machine,
      machine: { ...SINGLETON_DEFAULTS.machine.machine, agentPermissions: 'skip' },
    } as const;

    // Act
    const actual = renderConfigFile('machine.yaml', MACHINE, value, existing) as string;

    // Assert
    should(actual).containEql('# my machine');
    should(actual).containEql('# keep terminals on');
    should(actual).containEql('terminals: true # same line');
    should(actual).containEql('agentPermissions: skip # prompts');
    should(actual.indexOf('agentControl')).be.below(actual.indexOf('agentPermissions'));
  });

  it('should remove a key the value no longer has', () => {
    // Arrange
    const existing = 'label: mine\nharness: claude\nstore: host\n';

    // Act
    const actual = renderConfigFile('logins/me.yaml', LOGIN, { harness: 'claude', store: 'host' }, existing) as string;

    // Assert
    should(actual).not.containEql('label');
    should(actual).containEql('harness: claude');
  });

  it('should replace a file that does not parse with the value, rather than refusing to write', () => {
    // Arrange
    const existing = 'harness: [unclosed\n';

    // Act
    const actual = renderConfigFile('logins/me.yaml', LOGIN, { harness: 'claude', store: 'host' }, existing) as string;

    // Assert
    should(meaning('logins/me.yaml', actual)).deepEqual({ harness: 'claude', store: 'host' });
  });

  it('should write a value into a file whose content breaks its schema, even when it is a singleton at defaults', () => {
    // Arrange — the file does not check, so there is no "already means the value" to compare with
    const existing = 'bogus: 1\n';

    // Act
    const actual = renderConfigFile('machine.yaml', MACHINE, SINGLETON_DEFAULTS.machine, existing) as string;

    // Assert
    should(actual).not.containEql('bogus');
    should(checkConfigFile('machine.yaml', actual).ok).be.true();
  });

  it('should treat an empty existing file as its defaults and leave it alone when the value is them', () => {
    // Act
    const actual = renderConfigFile('machine.yaml', MACHINE, SINGLETON_DEFAULTS.machine, '');

    // Assert
    should(actual).be.undefined();
  });

  it('should write a login into an empty existing file', () => {
    // Act
    const actual = renderConfigFile('logins/me.yaml', LOGIN, { harness: 'claude', store: 'host' }, '') as string;

    // Assert
    should(meaning('logins/me.yaml', actual)).deepEqual({ harness: 'claude', store: 'host' });
  });
});

describe('fleetFileEdits', () => {
  const model = (overrides: Record<string, unknown> = {}): AccountModel =>
    parseAccountModel({
      version: 2,
      credentials: { me: { harness: 'claude', store: 'host' } },
      components: { instructions: { main: { file: 'instructions/main.md' } } },
      profiles: { default: { layers: ['instructions/main'] } },
      runtimes: { main: { credential: 'me', profile: 'default', agent: true } },
      ...overrides,
    });

  /** The files a model would be on disk as, each written by the same renderer. */
  const diskOf = (
    of: AccountModel,
    from: AccountModel = parseAccountModel({ version: 2 }),
  ): Map<string, ConfigFileOnDisk> => {
    const edits = fleetFileEdits(from, of, new Map());
    return new Map(
      edits.map(edit => [edit.path, { text: edit.content as string, etag: digest(edit.content as string) }]),
    );
  };

  it('should write every file of a model that has none yet, each expecting the file to be absent', () => {
    // Arrange
    const next = model();

    // Act
    const actual = fleetFileEdits(parseAccountModel({ version: 2 }), next, new Map());

    // Assert
    should(actual.map(edit => edit.path).toSorted()).deepEqual([
      'components/instructions/main.yaml',
      'logins/me.yaml',
      'profiles/default.yaml',
      'runtimes/main.yaml',
    ]);
    for (const edit of actual) {
      should(edit.expect).equal(ABSENT_CONFIG_ETAG);
      should(typeof edit.content).equal('string');
    }
  });

  it('should leave machine.yaml unwritten while the machine is at its defaults', () => {
    // Act
    const actual = fleetFileEdits(parseAccountModel({ version: 2 }), model(), new Map());

    // Assert
    should(actual.map(edit => edit.path)).not.containEql('machine.yaml');
  });

  it('should write nothing when the model did not change', () => {
    // Arrange
    const current = model();

    // Act
    const actual = fleetFileEdits(current, current, diskOf(current));

    // Assert
    should(actual).deepEqual([]);
  });

  it('should move a renamed runtime’s file with its comments, and remove the old one', () => {
    // Arrange
    const before = model();
    const disk = diskOf(before);
    const old = disk.get('runtimes/main.yaml') as ConfigFileOnDisk;
    disk.set('runtimes/main.yaml', { ...old, text: `# the one I launch\n${old.text}` });
    const next = model({ runtimes: { primary: { credential: 'me', profile: 'default', agent: true } } });

    // Act
    const actual = fleetFileEdits(before, next, disk, new Map([['runtimes/primary.yaml', 'runtimes/main.yaml']]));

    // Assert
    const written = actual.find(edit => edit.path === 'runtimes/primary.yaml');
    should(written?.expect).equal(ABSENT_CONFIG_ETAG);
    should(written?.content).startWith('# the one I launch\n');
    should(meaning('runtimes/primary.yaml', written?.content as string)).deepEqual(
      meaning('runtimes/main.yaml', old.text),
    );
    should(actual.find(edit => edit.path === 'runtimes/main.yaml')).eql({
      path: 'runtimes/main.yaml',
      content: undefined,
      expect: old.etag,
    });
  });

  it('should rewrite only the changed file, expecting the etag it has on disk', () => {
    // Arrange
    const before = model();
    const disk = diskOf(before);
    const next = model({ runtimes: { main: { credential: 'me', profile: 'default', agent: false } } });

    // Act
    const actual = fleetFileEdits(before, next, disk);

    // Assert
    should(actual).have.length(1);
    should(actual[0]?.path).equal('runtimes/main.yaml');
    should(actual[0]?.expect).equal(disk.get('runtimes/main.yaml')?.etag);
    should(meaning('runtimes/main.yaml', actual[0]?.content as string)).deepEqual({
      credential: 'me',
      profile: 'default',
      agent: false,
    });
  });

  it('should keep a comment the owner wrote in the file it rewrites', () => {
    // Arrange
    const before = model();
    const disk = new Map(diskOf(before));
    const text = '# my main runtime\ncredential: me\nprofile: default\nagent: true # launches as an agent\n';
    disk.set('runtimes/main.yaml', { text, etag: digest(text) });
    const next = model({
      runtimes: { main: { credential: 'me', profile: 'base2', agent: true } },
      profiles: { default: { layers: [] }, base2: { layers: [] } },
    });

    // Act
    const actual = fleetFileEdits(before, next, disk);

    // Assert
    const written = actual.find(edit => edit.path === 'runtimes/main.yaml')?.content as string;
    should(written).containEql('# my main runtime');
    should(written).containEql('agent: true # launches as an agent');
    should(written).containEql('profile: base2');
  });

  it('should remove a file the next model no longer has, expecting the etag it was read with', () => {
    // Arrange
    const before = model();
    const disk = diskOf(before);
    const next = model({ runtimes: {} });

    // Act
    const actual = fleetFileEdits(before, next, disk);

    // Assert
    should(actual).deepEqual([
      { path: 'runtimes/main.yaml', content: undefined, expect: disk.get('runtimes/main.yaml')?.etag as string },
    ]);
  });

  it('should skip removing a file that is not on disk any more', () => {
    // Arrange
    const before = model();
    const disk = new Map(diskOf(before));
    disk.delete('runtimes/main.yaml');

    // Act
    const actual = fleetFileEdits(before, model({ runtimes: {} }), disk);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should never delete a file that is on disk but is in neither model', () => {
    // Arrange
    const current = model();
    const disk = new Map(diskOf(current));
    disk.set('logins/broken.yaml', { text: 'harness: [unclosed\n', etag: digest('harness: [unclosed\n') });

    // Act
    const actual = fleetFileEdits(current, model({ runtimes: {} }), disk);

    // Assert
    should(actual.map(edit => edit.path)).deepEqual(['runtimes/main.yaml']);
    should(actual.map(edit => edit.path)).not.containEql('logins/broken.yaml');
  });

  it('should write a file the next model has even over a broken one on disk, expecting that file’s etag', () => {
    // Arrange
    const current = model();
    const disk = new Map(diskOf(current));
    const broken = 'harness: [unclosed\n';
    disk.set('logins/me.yaml', { text: broken, etag: digest(broken) });

    // Act
    const actual = fleetFileEdits(
      current,
      model({ credentials: { me: { harness: 'claude', store: 'host', label: 'new' } } }),
      disk,
    );

    // Assert
    const edit = actual.find(candidate => candidate.path === 'logins/me.yaml');
    should(edit?.expect).equal(digest(broken));
    should(meaning('logins/me.yaml', edit?.content as string)).deepEqual({
      harness: 'claude',
      store: 'host',
      label: 'new',
    });
  });

  it('should write machine.yaml when the machine moves off its defaults, and name its path from the layout', () => {
    // Arrange
    const before = model();
    const next = model({ machine: { agentControl: { ferretrySettings: true, pageScripts: false } } });

    // Act
    const actual = fleetFileEdits(before, next, diskOf(before));

    // Assert
    should(actual.map(edit => edit.path)).deepEqual([configFilePath(MACHINE)]);
    should(actual[0]?.content).containEql('ferretrySettings: true');
  });
});

describe('renamedRuntimeMentions', () => {
  const warden = { ...DEFAULT_WARDEN_CONFIG, accounts: [{ agent: 'glm-b', model: 'glm-5' }, { agent: 'other' }] };
  const learning = { ...DEFAULT_LEARNING_CONFIG, agent: 'glm-b' };

  it('should re-point each Warden login and the lesson miner that name the old runtime, keeping comments', () => {
    // Arrange
    const wardenText = '# my order\naccounts:\n  - agent: glm-b\n    model: glm-5\n  - agent: other\n';
    const onDisk = new Map([['warden.yaml', { text: wardenText, etag: digest(wardenText) }]]);

    // Act
    const edits = renamedRuntimeMentions({ warden, learning }, onDisk, { from: 'glm-b', to: 'glm-work' });

    // Assert
    should(edits.map(edit => [edit.path, edit.expect])).deepEqual([
      ['warden.yaml', digest(wardenText)],
      ['learning.yaml', ABSENT_CONFIG_ETAG],
    ]);
    should(edits[0]?.content).containEql('# my order\n');
    should(meaning('warden.yaml', edits[0]?.content as string)).match({
      accounts: [{ agent: 'glm-work', model: 'glm-5' }, { agent: 'other' }],
    });
    should(meaning('learning.yaml', edits[1]?.content as string)).match({ agent: 'glm-work' });
  });

  it('should write nothing when no other file names the runtime', () => {
    // Act / Assert
    should(renamedRuntimeMentions({ warden, learning }, new Map(), { from: 'nobody', to: 'someone' })).deepEqual([]);
  });
});
