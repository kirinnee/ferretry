import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { checkConfigFile, describePath, schemaIssues } from '../../../src/lib/config-files/check.ts';
import { RAW_SECRET_FIX } from '../../../src/lib/config-files/secrets.ts';

/** A key shaped like a provider's, assembled at run time so no scanner-looking literal sits in the repo. */
const RAW_KEY = ['sk', 'ant', 'api03'].join('-') + '-' + 'Z'.repeat(24);

describe('describePath', () => {
  it.each([
    [[], ''],
    [['env'], 'env'],
    [['env', 'ANTHROPIC_AUTH_TOKEN'], 'env.ANTHROPIC_AUTH_TOKEN'],
    [['contents', 2], 'contents[2]'],
    [['accounts', 0, 'agent'], 'accounts[0].agent'],
    [[0, 'agent'], '[0].agent'],
  ] as const)('should write %j as %j', (input, expected) => {
    // Act
    const actual = describePath(input);

    // Assert
    should(actual).equal(expected);
  });

  it('should write a symbol key by its description', () => {
    // Act + Assert
    should(describePath(['a', Symbol('b')])).equal('a.Symbol(b)');
  });
});

describe('checkConfigFile: a file Ferretry does not read', () => {
  it.each([
    ['notes.yaml'],
    ['machine.yml'],
    ['profiles/.hidden.yaml'],
    ['profiles/a/b.yaml'],
    ['components/other/x.yaml'],
    ['../machine.yaml'],
  ])('should warn, not fail, for %s', path => {
    // Act
    const actual = checkConfigFile(path, 'a: 1\n');

    // Assert
    should(actual.ok).be.false();
    should(actual.address).be.undefined();
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.severity).equal('warning');
    should(actual.issues[0]?.path).equal(path);
    should(actual.issues[0]?.message).equal('Ferretry does not read this file');
    should(actual.issues[0]?.fix).containEql('machine.yaml, warden.yaml');
    should(actual.issues[0]).not.have.property('line');
  });
});

describe('checkConfigFile: a file that does not parse', () => {
  it('should answer a located error naming the YAML problem', () => {
    // Arrange
    const input = 'agentPermissions: auto\nagentControl: [unclosed\n';

    // Act
    const actual = checkConfigFile('machine.yaml', input);

    // Assert
    should(actual.ok).be.false();
    should(actual.address).deepEqual({ kind: 'machine' });
    should(actual.issues.length).be.above(0);
    for (const issue of actual.issues) {
      should(issue.severity).equal('error');
      should(issue.path).equal('machine.yaml');
      should(issue.message.startsWith('this is not valid YAML: ')).be.true();
      should(issue.line).be.a.Number();
      should(issue.column).be.a.Number();
      should(issue.fix).containEql('indentation');
    }
  });

  it('should place the error at the line the problem is on', () => {
    // Arrange
    const input = 'enabled: true\nintervalMinutes: 5\nintervalMinutes: 6\n';

    // Act
    const actual = checkConfigFile('warden.yaml', input);

    // Assert
    should(actual.ok).be.false();
    should(actual.issues[0]?.line).equal(3);
    should(actual.issues[0]?.message).containEql('unique');
  });
});

describe('checkConfigFile: a file that holds a raw secret', () => {
  const input = `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_AUTH_TOKEN: ${RAW_KEY}\n`;

  it('should refuse it with an error located at the value’s key', () => {
    // Act
    const actual = checkConfigFile('logins/work.yaml', input);

    // Assert
    should(actual.ok).be.false();
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.severity).equal('error');
    should(actual.issues[0]?.line).equal(4);
    should(actual.issues[0]?.column).equal(3);
    should(actual.issues[0]?.message).equal(
      'env.ANTHROPIC_AUTH_TOKEN: this looks like a raw secret (an API key or token)',
    );
    should(actual.issues[0]?.fix).equal(RAW_SECRET_FIX);
  });

  it('should never repeat the secret in any issue', () => {
    // Act
    const actual = checkConfigFile('logins/work.yaml', input);

    // Assert
    should(JSON.stringify(actual)).not.containEql(RAW_KEY);
    should(JSON.stringify(actual)).not.containEql('Z'.repeat(8));
  });

  it('should report every secret in the file, each at its own place', () => {
    // Arrange
    const two = `${input}  OTHER_SECRET: ${RAW_KEY}\n`;

    // Act
    const actual = checkConfigFile('logins/work.yaml', two);

    // Assert
    should(actual.issues.map(issue => issue.line)).deepEqual([4, 5]);
  });

  it('should accept the same file written with a ${secret:NAME} reference', () => {
    // Arrange
    const reference = 'harness: claude\nstore: environment\nenv:\n  ANTHROPIC_AUTH_TOKEN: ${secret:WORK_KEY}\n';

    // Act
    const actual = checkConfigFile('logins/work.yaml', reference);

    // Assert
    should(actual.ok).be.true();
  });

  it('should find a secret before it judges the schema, so a wrong-shaped file does not hide it', () => {
    // Arrange
    const wrong = `bogus: ${RAW_KEY}\n`;

    // Act
    const actual = checkConfigFile('machine.yaml', wrong);

    // Assert
    should(actual.issues[0]?.message).containEql('raw secret');
    should(actual.issues).have.length(1);
  });
});

describe('checkConfigFile: a file that breaks its schema', () => {
  it('should name an unrecognised key at the key, with the fix to remove it', () => {
    // Arrange
    const input = 'agentPermissions: auto\nbogus: 1\n';

    // Act
    const actual = checkConfigFile('machine.yaml', input);

    // Assert
    should(actual.ok).be.false();
    should(actual.issues).have.length(1);
    const issue = actual.issues[0];
    should(issue?.severity).equal('error');
    should(issue?.line).equal(2);
    should(issue?.column).equal(1);
    should(issue?.fix).equal('remove "bogus" — this file has no such setting; `fy config schema` lists what it takes');
  });

  it('should say which object an unrecognised key is in, when it is not the top level', () => {
    // Arrange
    const input = 'agentControl:\n  terminals: true\n  nope: 1\n';

    // Act
    const actual = checkConfigFile('machine.yaml', input);

    // Assert
    should(actual.issues[0]?.line).equal(3);
    should(actual.issues[0]?.message).startWith('agentControl: ');
    should(actual.issues[0]?.fix).equal(
      'remove "nope" from agentControl — this file has no such setting; `fy config schema` lists what it takes',
    );
  });

  it('should name every unrecognised key of one object in one fix', () => {
    // Act
    const actual = checkConfigFile('machine.yaml', 'one: 1\ntwo: 2\n');

    // Assert
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.fix).startWith('remove "one", "two" — ');
    should(actual.issues[0]?.line).equal(1);
  });

  it('should say a missing required key is required, located at the file', () => {
    // Act
    const actual = checkConfigFile('components/instructions/main.yaml', 'harness: claude\n');

    // Assert
    should(actual.ok).be.false();
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.fix).equal('add "file" — it is required');
    should(actual.issues[0]?.message).startWith('file: ');
    should(actual.issues[0]?.line).equal(1);
  });

  it('should tell a missing enum key to change it, since the schema reports the value as invalid', () => {
    // Act
    const actual = checkConfigFile('logins/work.yaml', 'store: host\n');

    // Assert
    should(actual.ok).be.false();
    should(actual.issues[0]?.fix).startWith('change harness: ');
  });

  it('should tell a value of the wrong type to change it, not to add a key that is already there', () => {
    // Act
    const actual = checkConfigFile('warden.yaml', 'intervalMinutes: soon\n');

    // Assert
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.fix).startWith('change intervalMinutes: ');
    should(actual.issues[0]?.fix).not.containEql('it is required');
  });

  it('should tell a nested value of the wrong type to change it, at its line', () => {
    // Act
    const actual = checkConfigFile('machine.yaml', 'agentControl:\n  terminals: 5\n');

    // Assert
    should(actual.issues[0]?.line).equal(2);
    should(actual.issues[0]?.fix).startWith('change agentControl.terminals: ');
  });

  it('should say a custom rule’s own sentence, and tell the owner to correct the file and recheck', () => {
    // Arrange — store: environment with no env is a rule no single key can express
    const input = 'harness: claude\nstore: environment\n';

    // Act
    const actual = checkConfigFile('logins/work.yaml', input);

    // Assert
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.message).equal(
      'a credential kept in the environment must say which variables authenticate it, in "env"',
    );
    should(actual.issues[0]?.fix).equal('correct env, then run `fy config check`');
  });

  it('should say a custom rule on the whole file as correcting the file', () => {
    // Act
    const actual = checkConfigFile('components/mcp/both.yaml', 'command: npx\nurl: https://example.com\n');

    // Assert
    should(actual.issues[0]?.message).containEql('exactly one of');
    should(actual.issues[0]?.fix).equal('correct the file, then run `fy config check`');
    should(actual.issues[0]?.line).equal(1);
  });

  it('should say a wrong value’s path and the schema’s message', () => {
    // Act
    const actual = checkConfigFile('machine.yaml', 'agentPermissions: sometimes\n');

    // Assert
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.message).startWith('agentPermissions: ');
    should(actual.issues[0]?.fix).startWith('change agentPermissions: ');
    should(actual.issues[0]?.line).equal(1);
  });

  it('should accept a browser proxy with secret references and refuse one with a credential in it', () => {
    // Act
    const good = checkConfigFile(
      'machine.yaml',
      'browserProxy:\n  url: socks5://proxy.example:1080\n  bypass: ["*.internal.example"]\n  username: ${secret:PROXY_USER}\n  password: ${secret:PROXY_PASSWORD}\n',
    );
    const inline = checkConfigFile('machine.yaml', 'browserProxy:\n  url: http://alice:s3cret@proxy.example:8080\n');
    const plain = checkConfigFile(
      'machine.yaml',
      'browserProxy:\n  url: http://proxy.example:8080\n  username: alice\n  password: hunter2\n',
    );

    // Assert
    should(good.issues).deepEqual([]);
    should(inline.issues).not.deepEqual([]);
    should(inline.issues[0]?.message).containEql('never carries a user name or password');
    should(inline.issues[0]?.fix).containEql('browserProxy.url');
    should(JSON.stringify(inline.issues)).not.containEql('s3cret');
    should(plain.issues[0]?.fix).containEql('browserProxy.username');
    should(JSON.stringify(plain.issues)).not.containEql('hunter2');
  });

  it('should locate a bad item in a list at the item', () => {
    // Act
    const actual = checkConfigFile('profiles/p.yaml', 'contents:\n  - instructions/main\n  - not a layer\n');

    // Assert
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.line).equal(3);
    should(actual.issues[0]?.message).equal(
      '"not a layer" is not a layer — write <kind>/<name> with kind one of instructions, mcp, skills, settings, hooks, modelSets, or profile/<name>',
    );
  });

  it('should report a whole-file type error with no path in the sentence', () => {
    // Act
    const actual = checkConfigFile('learning.yaml', '- a\n- b\n');

    // Assert
    should(actual.ok).be.false();
    should(actual.issues[0]?.line).equal(1);
  });

  it('should tell a file of the wrong shape to change the file, not to add an empty key', () => {
    // Act
    const actual = checkConfigFile('learning.yaml', '- a\n- b\n');

    // Assert
    should(actual.issues[0]?.fix).startWith('change the file: ');
    should(actual.issues[0]?.fix).not.containEql('it is required');
  });

  it('should refuse a voice file that asks for a login without naming one', () => {
    // Act
    const actual = checkConfigFile('voice.yaml', 'postProcessing:\n  provider: login\n');

    // Assert
    should(actual.ok).be.false();
    should(actual.issues[0]?.message).containEql('needs "login"');
    should(actual.issues[0]?.line).be.a.Number();
  });
});

describe('checkConfigFile: a file that checks', () => {
  it('should answer what it is, what it means and where its keys are', () => {
    // Arrange
    const input = '# my machine\nagentPermissions: skip\nagentControl:\n  ferretrySettings: true\n';

    // Act
    const actual = checkConfigFile('machine.yaml', input);

    // Assert
    should(actual.ok).be.true();
    if (!actual.ok) return;
    should(actual.address).deepEqual({ kind: 'machine' });
    should(actual.schema).equal('machine');
    should(actual.issues).deepEqual([]);
    const value = actual.value as {
      machine: { agentPermissions: string; agentControl: { ferretrySettings: boolean } };
    };
    should(value.machine.agentPermissions).equal('skip');
    should(value.machine.agentControl.ferretrySettings).be.true();
    should(actual.locate(['agentControl', 'ferretrySettings'])).deepEqual({ line: 4, column: 3 });
  });

  it.each([
    ['', 'warden.yaml', 'warden'],
    ['{}\n', 'learning.yaml', 'learning'],
    ['', 'voice.yaml', 'voice'],
    ['', 'machine.yaml', 'machine'],
    ['contents: []\n', 'profiles/p.yaml', 'profile'],
    ['file: instructions/main.md\n', 'components/instructions/main.yaml', 'component-instructions'],
  ])('should check %j as %s (%s), an empty file meaning its defaults', (input, path, schema) => {
    // Act
    const actual = checkConfigFile(path, input);

    // Assert
    should(actual.ok).be.true();
    should(actual.ok && actual.schema).equal(schema);
  });

  it('should read YAML 1.2: off is a string, so a voice provider off is not a boolean', () => {
    // Act
    const actual = checkConfigFile('voice.yaml', 'postProcessing:\n  provider: off\n');

    // Assert
    should(actual.ok).be.true();
  });
});

describe('schemaIssues', () => {
  const locate = (path: readonly PropertyKey[]) => ({ line: path.length + 1, column: 1 });

  it('should omit the position when the file has none for the issue', () => {
    // Arrange
    const error = new z.ZodError([{ code: 'custom', message: 'broken', path: ['a'], input: 1 }]);

    // Act
    const actual = schemaIssues('machine.yaml', error, () => undefined);

    // Assert
    should(actual).deepEqual([
      {
        path: 'machine.yaml',
        severity: 'error',
        message: 'broken',
        fix: 'correct a, then run `fy config check`',
      },
    ]);
  });

  it('should say a custom rule at the top as its own message, without a path', () => {
    // Arrange
    const error = new z.ZodError([{ code: 'custom', message: 'whole-file rule', path: [], input: 1 }]);

    // Act
    const actual = schemaIssues('voice.yaml', error, locate);

    // Assert
    should(actual[0]?.message).equal('whole-file rule');
    should(actual[0]?.fix).equal('correct the file, then run `fy config check`');
    should(actual[0]?.line).equal(1);
  });

  it('should answer one issue per schema issue, in order', () => {
    // Arrange
    const result = z.strictObject({ a: z.string(), b: z.number() }).safeParse({ a: 1, b: 'x', c: 3 });

    // Act
    const actual = schemaIssues('x.yaml', result.error as z.ZodError, locate);

    // Assert
    should(actual.length).equal((result.error as z.ZodError).issues.length);
    should(actual.every(issue => issue.severity === 'error')).be.true();
  });
});

describe('checkConfigFile: the agenda check switch renamed for the agenda wire', () => {
  it('should load the older attentionNudge key alone, with a warning naming where it went', () => {
    // Act
    const actual = checkConfigFile('machine.yaml', 'agentPermissions: auto\nattentionNudge: false\n');

    // Assert
    should(actual.ok).be.true();
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.severity).equal('warning');
    should(actual.issues[0]?.message).equal(
      'attentionNudge is renamed to agendaNudge; still read until the agenda removal release',
    );
    should(actual.issues[0]?.fix).equal('rename attentionNudge to agendaNudge');
    should(actual.issues[0]?.line).equal(2);
  });

  it('should warn that the new key wins when both are written', () => {
    // Act
    const actual = checkConfigFile('machine.yaml', 'attentionNudge: true\nagendaNudge: false\n');

    // Assert
    should(actual.ok).be.true();
    should(actual.issues).have.length(1);
    should(actual.issues[0]?.message).equal(
      'attentionNudge is renamed to agendaNudge, and both are written: agendaNudge wins and attentionNudge is ignored',
    );
    should(actual.issues[0]?.fix).equal('delete attentionNudge');
  });

  it('should say nothing about the new key alone, or about a file that sets neither', () => {
    should(checkConfigFile('machine.yaml', 'agendaNudge: false\n').issues).deepEqual([]);
    should(checkConfigFile('machine.yaml', 'agentPermissions: auto\n').issues).deepEqual([]);
  });

  it('should not warn on a file kind that has no renamed key', () => {
    should(checkConfigFile('profiles/base.yaml', 'contents: []\n').issues).deepEqual([]);
  });
});

describe('checkConfigFile: account-defaults.yaml', () => {
  it('should accept the three maps', () => {
    // Act
    const actual = checkConfigFile(
      'account-defaults.yaml',
      'sites:\n  app.clickup.com: CLICKUP_A\nprojects:\n  ferretry:\n    github.com: GITHUB\nfolders:\n  /srv/app:\n    github.com: GITHUB\n',
    );

    // Assert
    should(actual.ok).be.true();
    should(actual.issues).deepEqual([]);
  });

  it.each([
    ['an unknown map', 'site:\n  github.com: GITHUB\n'],
    ['a host in capitals', 'sites:\n  GitHub.com: GITHUB\n'],
    ['a lower-case handle', 'sites:\n  github.com: github\n'],
    ['a relative folder', 'folders:\n  work/app:\n    github.com: GITHUB\n'],
    ['an account list where one handle belongs', 'sites:\n  github.com: [GITHUB, GITHUB_B]\n'],
  ])('should fail %s, with the line it is on', (_name, text) => {
    // Act
    const actual = checkConfigFile('account-defaults.yaml', text);

    // Assert
    should(actual.ok).be.false();
    should(actual.issues.some(issue => issue.severity === 'error' && issue.line !== undefined)).be.true();
  });
});
