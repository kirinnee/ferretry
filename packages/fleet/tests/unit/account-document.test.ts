import { describe, it } from 'bun:test';
import should from 'should';
import { ZodError } from 'zod';
import {
  parseAccountConfigText,
  RETIRED_FLEET_CONFIG_SENTENCE,
  RetiredFleetConfigError,
  renderConfig,
  slugName,
} from '../../src/lib/account/document.ts';

const PATH = '/state/fleet/config.yaml';

const V2 = `version: 2
machine: {}
credentials:
  claude-you:
    harness: claude
    store: host
`;

/** What a parse threw, or a failure naming that nothing was. */
const thrown = (text: string): unknown => {
  try {
    parseAccountConfigText(text, PATH);
  } catch (error) {
    return error;
  }
  throw new Error('expected the parse to throw');
};

describe('parseAccountConfigText', () => {
  it('should read a version-2 document', () => {
    // Act
    const actual = parseAccountConfigText(V2, PATH);

    // Assert
    should(actual.version).equal(2);
    should(actual.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'host' });
  });

  it.each([
    ['no version key', 'agents: []\n'],
    ['version 1', 'version: 1\nagents: []\n'],
    ['an empty document', ''],
    ['an empty mapping', '{}\n'],
    ['a document that is not a mapping', '- one\n- two\n'],
  ])('should refuse %s as the retired format, naming the path', (_label, text) => {
    // Act
    const actual = thrown(text);

    // Assert
    should(actual).be.instanceof(RetiredFleetConfigError);
    should((actual as RetiredFleetConfigError).path).equal(PATH);
    should((actual as RetiredFleetConfigError).message).equal(RETIRED_FLEET_CONFIG_SENTENCE(PATH));
  });

  it('should report what is wrong with a broken version-2 document, not call it retired', () => {
    // Act
    const actual = thrown('version: 2\nmachine: {}\nrunaways: {}\n');

    // Assert
    should(actual).be.instanceof(ZodError);
    should(actual).not.be.instanceof(RetiredFleetConfigError);
  });
});

describe('RETIRED_FLEET_CONFIG_SENTENCE', () => {
  it('should say where the file is, that it is not read, and how to set the machine up again', () => {
    should(RETIRED_FLEET_CONFIG_SENTENCE(PATH)).equal(
      `${PATH} uses the old account format, which this Ferretry no longer reads. Move it aside (for example rename it to config.yaml.old) and restart the daemon; the first run then sets this machine up again from its own Claude Code and Codex.`,
    );
  });
});

describe('RetiredFleetConfigError', () => {
  it('should carry its own name and the path it was raised for', () => {
    // Act
    const actual = new RetiredFleetConfigError(PATH);

    // Assert
    should(actual.name).equal('RetiredFleetConfigError');
    should(actual.path).equal(PATH);
  });
});

describe('renderConfig', () => {
  it('should write a document that reads back as the same model, ending in one newline', () => {
    // Arrange
    const model = parseAccountConfigText(V2, PATH);

    // Act
    const actual = renderConfig(model);

    // Assert
    should(actual.endsWith('\n')).be.true();
    should(actual.endsWith('\n\n')).be.false();
    should(parseAccountConfigText(actual, PATH)).deepEqual(model);
  });
});

describe('slugName', () => {
  it.each([
    ['Work Laptop', 'Work-Laptop'],
    ['--a__b--', 'a-b'],
    ['x'.repeat(70), 'x'.repeat(64)],
  ])('should turn %j into %j', (value, expected) => {
    should(slugName(value, 'fallback')).equal(expected);
  });

  it('should answer the fallback when nothing of the value survives', () => {
    should(slugName('!!!', 'fallback')).equal('fallback');
  });
});
