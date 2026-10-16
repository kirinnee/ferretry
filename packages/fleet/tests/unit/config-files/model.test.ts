import { describe, it } from 'bun:test';
import { CONFIG_COMPONENT_KINDS, type ConfigFileAddress, configFilePath } from '@ferretry/protocol';
import should from 'should';
import { ZodError } from 'zod';
import { type AccountModel, parseAccountModel } from '../../../src/lib/account/schema.ts';
import { checkConfigFile } from '../../../src/lib/config-files/check.ts';
import {
  accountModelFiles,
  assembleAccountDocument,
  assembleAccountModel,
  type FleetFileValue,
  isFleetFile,
  modelIssueSite,
} from '../../../src/lib/config-files/model.ts';

/** A model with a login of each store, a component of every kind, a base profile, a runtime and a command. */
const FULL_MODEL: AccountModel = parseAccountModel({
  version: 2,
  machine: {
    agentPermissions: 'skip',
    defaultRuntime: 'main',
    agentControl: { terminals: false, ferretrySettings: true },
  },
  credentials: {
    me: { harness: 'claude', store: 'host', label: 'mine' },
    api: { harness: 'claude', store: 'environment', env: { ANTHROPIC_AUTH_TOKEN: '${secret:API_KEY}' } },
    codex: { harness: 'codex', store: 'ferretry' },
  },
  components: {
    instructions: { main: { file: 'instructions/main.md' } },
    mcp: { github: { command: 'npx', args: ['-y', 'server'] }, remote: { url: 'https://mcp.example.com/sse' } },
    skills: { mine: { items: ['one', 'two'] } },
    settings: { claude: { harness: 'claude', flags: ['--verbose'], env: { A: 'b' } } },
    hooks: { guard: { harness: 'claude', file: 'hooks/guard.json' } },
    modelSets: { heavy: { models: ['m1', 'm2'], default: 'm2' } },
  },
  profiles: {
    base: { layers: ['instructions/main'] },
    default: {
      layers: ['profile/base', 'mcp/github', 'skills/mine', 'settings/claude', 'hooks/guard', 'modelSets/heavy'],
    },
  },
  runtimes: {
    main: { credential: 'me', profile: 'default', agent: true },
    side: { credential: 'api', profile: 'base' },
  },
  advanced: { commands: [{ wrapper: 'cc', runtime: 'main', flags: ['--x'] }], aliases: {} },
});

const fleetValue = (path: string, text: string): FleetFileValue => {
  const checked = checkConfigFile(path, text);
  if (!checked.ok) throw new Error(`fixture ${path} does not check: ${JSON.stringify(checked.issues)}`);
  return { address: checked.address, value: checked.value };
};

describe('isFleetFile', () => {
  it.each([
    [{ kind: 'machine' }, true],
    [{ kind: 'login', name: 'a' }, true],
    [{ kind: 'component', componentKind: 'mcp', name: 'a' }, true],
    [{ kind: 'profile', name: 'a' }, true],
    [{ kind: 'runtime', name: 'a' }, true],
    [{ kind: 'warden' }, false],
    [{ kind: 'learning' }, false],
    [{ kind: 'voice' }, false],
  ] as const)('should say %j is a fleet file: %s', (input, expected) => {
    // Act
    const actual = isFleetFile(input as ConfigFileAddress);

    // Assert
    should(actual).equal(expected);
  });
});

describe('assembleAccountDocument', () => {
  it('should be a version-2 document with every section empty when there are no files', () => {
    // Act
    const actual = assembleAccountDocument([]);

    // Assert
    should(actual).deepEqual({
      version: 2,
      credentials: {},
      components: { instructions: {}, mcp: {}, skills: {}, settings: {}, hooks: {}, modelSets: {} },
      profiles: {},
      runtimes: {},
    });
  });

  it('should place each file by what it is: machine split, a profile’s contents as layers', () => {
    // Arrange
    const input = [
      fleetValue('machine.yaml', 'agentPermissions: skip\n'),
      fleetValue('logins/me.yaml', 'harness: claude\nstore: host\n'),
      fleetValue('components/mcp/gh.yaml', 'command: npx\n'),
      fleetValue('profiles/default.yaml', 'contents:\n  - mcp/gh\n'),
      fleetValue('runtimes/main.yaml', 'credential: me\nprofile: default\n'),
    ];

    // Act
    const actual = assembleAccountDocument(input) as Record<string, Record<string, unknown>>;

    // Assert
    should(Object.keys(actual).toSorted()).deepEqual([
      'advanced',
      'components',
      'credentials',
      'machine',
      'profiles',
      'runtimes',
      'version',
    ]);
    should(actual.credentials).deepEqual({ me: { harness: 'claude', store: 'host' } });
    should(
      ((actual.components as Record<string, Record<string, unknown>>).mcp as Record<string, unknown>).gh,
    ).deepEqual({ command: 'npx' });
    should(actual.profiles).deepEqual({ default: { layers: ['mcp/gh'] } });
    should(actual.runtimes).deepEqual({ main: { credential: 'me', profile: 'default', agent: false } });
    should((actual.machine as { agentPermissions: string }).agentPermissions).equal('skip');
  });

  it('should leave machine and advanced out when there is no machine.yaml', () => {
    // Act
    const actual = assembleAccountDocument([fleetValue('logins/me.yaml', 'harness: claude\nstore: host\n')]);

    // Assert
    should(actual).not.have.property('machine');
    should(actual).not.have.property('advanced');
  });

  it('should ignore a Warden, Learning or Voice file: they are not the account model', () => {
    // Arrange
    const input = [
      fleetValue('warden.yaml', 'enabled: true\n'),
      fleetValue('voice.yaml', ''),
      fleetValue('learning.yaml', ''),
    ];

    // Act
    const actual = assembleAccountDocument(input);

    // Assert
    should(actual).deepEqual(assembleAccountDocument([]));
  });
});

describe('assembleAccountModel', () => {
  it('should fill every default when there are no files at all: a machine nobody has set up', () => {
    // Act
    const actual = assembleAccountModel([]);

    // Assert
    should(actual.version).equal(2);
    should(actual.machine.agentControl.ferretrySettings).be.false();
    should(actual.credentials).deepEqual({});
    should(actual.runtimes).deepEqual({});
  });

  it('should hold a component of every kind under its kind', () => {
    // Arrange
    const files = [...accountModelFiles(FULL_MODEL).values()];

    // Act
    const actual = assembleAccountModel(files);

    // Assert
    for (const kind of CONFIG_COMPONENT_KINDS) {
      should(Object.keys(actual.components[kind]).length).be.above(0);
    }
  });

  it('should throw the account model’s own error when a profile names a component that is not there', () => {
    // Arrange
    const input = [fleetValue('profiles/default.yaml', 'contents:\n  - mcp/missing\n')];

    // Act
    let actual: unknown;
    try {
      assembleAccountModel(input);
    } catch (error) {
      actual = error;
    }

    // Assert
    should(actual).be.instanceof(ZodError);
    should((actual as ZodError).issues[0]?.path).deepEqual(['profiles', 'default', 'layers', 0]);
  });
});

describe('accountModelFiles', () => {
  it('should hold one file per building block, by its path, and the machine file always', () => {
    // Act
    const actual = accountModelFiles(FULL_MODEL);

    // Assert
    should([...actual.keys()].toSorted()).deepEqual(
      [
        'machine.yaml',
        'logins/me.yaml',
        'logins/api.yaml',
        'logins/codex.yaml',
        'components/instructions/main.yaml',
        'components/mcp/github.yaml',
        'components/mcp/remote.yaml',
        'components/skills/mine.yaml',
        'components/settings/claude.yaml',
        'components/hooks/guard.yaml',
        'components/modelSets/heavy.yaml',
        'profiles/base.yaml',
        'profiles/default.yaml',
        'runtimes/main.yaml',
        'runtimes/side.yaml',
      ].toSorted(),
    );
  });

  it('should key every entry by the path its address means', () => {
    // Act
    const actual = accountModelFiles(FULL_MODEL);

    // Assert
    for (const [path, { address }] of actual) should(configFilePath(address)).equal(path);
  });

  it('should hold the machine and advanced together in machine.yaml', () => {
    // Act
    const actual = accountModelFiles(FULL_MODEL).get('machine.yaml');

    // Assert
    should(actual?.value).deepEqual({ machine: FULL_MODEL.machine, advanced: FULL_MODEL.advanced });
  });

  it('should round-trip: the files a model is held in assemble back into that model', () => {
    // Arrange
    const files = [...accountModelFiles(FULL_MODEL).values()];

    // Act
    const actual = assembleAccountModel(files);

    // Assert
    should(actual).deepEqual(FULL_MODEL);
  });

  it('should round-trip the empty model as just machine.yaml', () => {
    // Arrange
    const empty = assembleAccountModel([]);

    // Act
    const files = accountModelFiles(empty);

    // Assert
    should([...files.keys()]).deepEqual(['machine.yaml']);
    should(assembleAccountModel([...files.values()])).deepEqual(empty);
  });
});

describe('modelIssueSite', () => {
  it.each([
    [['credentials', 'api', 'env'], 'logins/api.yaml', ['env']],
    [['credentials', 'api'], 'logins/api.yaml', []],
    [['components', 'mcp', 'github', 'url'], 'components/mcp/github.yaml', ['url']],
    [['components', 'modelSets', 'heavy'], 'components/modelSets/heavy.yaml', []],
    [['profiles', 'default', 'layers', 2], 'profiles/default.yaml', ['contents', 2]],
    [['profiles', 'default', 'layers'], 'profiles/default.yaml', ['contents']],
    [['profiles', 'default', 'other'], 'profiles/default.yaml', ['other']],
    [['runtimes', 'main', 'credential'], 'runtimes/main.yaml', ['credential']],
    [['machine', 'defaultRuntime'], 'machine.yaml', ['defaultRuntime']],
    [['machine'], 'machine.yaml', []],
    [['advanced', 'commands', 0, 'runtime'], 'machine.yaml', ['advanced', 'commands', 0, 'runtime']],
  ] as const)('should place the issue at %j in %s, at %j inside it', (input, file, path) => {
    // Act
    const actual = modelIssueSite(input);

    // Assert
    should(actual).deepEqual({ file, path });
  });

  it.each([
    [[]],
    [['version']],
    [['credentials']],
    [['credentials', 3]],
    [['components']],
    [['components', 'mcp']],
    [['components', 'nonsense', 'x']],
    [['components', 'mcp', 4]],
    [['profiles']],
    [['runtimes']],
    [['somethingNew', 'x']],
  ] as const)('should blame machine.yaml as a whole for %j, which names no file', input => {
    // Act
    const actual = modelIssueSite(input);

    // Assert
    should(actual).deepEqual({ file: 'machine.yaml', path: [] });
  });

  it('should answer a site for every issue a real cross-file failure raises', () => {
    // Arrange
    const input = [
      fleetValue('runtimes/main.yaml', 'credential: gone\nprofile: default\n'),
      fleetValue('profiles/default.yaml', 'contents:\n  - mcp/missing\n'),
    ];
    let error: unknown;
    try {
      assembleAccountModel(input);
    } catch (thrown) {
      error = thrown;
    }

    // Act
    const actual = (error as ZodError).issues.map(issue => modelIssueSite(issue.path));

    // Assert
    should(actual).containDeep([
      { file: 'runtimes/main.yaml', path: ['credential'] },
      { file: 'profiles/default.yaml', path: ['contents', 0] },
    ]);
  });
});
