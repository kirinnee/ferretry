import { describe, it } from 'bun:test';
import should from 'should';
import {
  RETIRED_FLEET_CONFIG_FILE,
  RETIRED_FLEET_CONFIG_SENTENCE,
  RetiredFleetConfigError,
  slugName,
} from '../../src/lib/account/document.ts';

const PATH = '/state/fleet/config.yaml';

describe('RETIRED_FLEET_CONFIG_SENTENCE', () => {
  it('should say where the file is, that it is not read, and how to set the machine up again', () => {
    // Act
    const actual = RETIRED_FLEET_CONFIG_SENTENCE(PATH);

    // Assert
    should(actual).equal(
      `${PATH} is the old single-file configuration, which this Ferretry no longer reads: each login, component, profile and runtime is now its own file under config/ in the state home. Move it aside (for example rename it to config.yaml.old), then set this machine up again from the app or with \`fy daemon setup\`.`,
    );
  });

  it('should name the path it is given, whichever it is', () => {
    // Arrange
    const input = '/elsewhere/fleet/config.yaml';

    // Act
    const actual = RETIRED_FLEET_CONFIG_SENTENCE(input);

    // Assert
    should(actual.startsWith(`${input} is the old`)).be.true();
  });
});

describe('RETIRED_FLEET_CONFIG_FILE', () => {
  it('should be the file name the old single-file configuration had', () => {
    should(RETIRED_FLEET_CONFIG_FILE).equal('config.yaml');
  });
});

describe('RetiredFleetConfigError', () => {
  it('should carry its own name, the path it was raised for, and the sentence as its message', () => {
    // Act
    const actual = new RetiredFleetConfigError(PATH);

    // Assert
    should(actual).be.instanceof(Error);
    should(actual.name).equal('RetiredFleetConfigError');
    should(actual.path).equal(PATH);
    should(actual.message).equal(RETIRED_FLEET_CONFIG_SENTENCE(PATH));
  });
});

describe('slugName', () => {
  it.each([
    ['Work Laptop', 'Work-Laptop'],
    ['--a__b--', 'a-b'],
    ['x'.repeat(70), 'x'.repeat(64)],
    [`${'x'.repeat(63)} y`, 'x'.repeat(63)],
  ])('should turn %j into %j', (value, expected) => {
    // Act
    const actual = slugName(value, 'fallback');

    // Assert
    should(actual).equal(expected);
  });

  it('should answer the fallback when nothing of the value survives', () => {
    // Act + Assert
    should(slugName('!!!', 'fallback')).equal('fallback');
    should(slugName('', 'fallback')).equal('fallback');
  });
});
