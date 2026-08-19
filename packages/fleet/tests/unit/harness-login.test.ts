import { describe, it } from 'bun:test';
import should from 'should';
import {
  HARNESS_LOGIN_DECLARATIONS,
  type HarnessLoginDeclarations,
  harnessDoesInteractiveLogin,
  harnessNoLoginReason,
} from '../../src/lib/harness-login.ts';

/**
 * A table where one harness declares no interactive login.
 *
 * Both shipped harnesses log in, so this is the only way to prove a consumer honours the declaration
 * rather than assuming every harness does. It is the same table shape production uses; nothing here
 * reaches past the declaration.
 */
const CODEX_HAS_NO_LOGIN: HarnessLoginDeclarations = {
  claude: { login: true },
  codex: { login: false, reason: 'this build of Codex authenticates from a service account' },
};

describe('harness login declarations', () => {
  it('should declare that both shipped harnesses do an interactive login', () => {
    // Act
    const actual = [harnessDoesInteractiveLogin('claude'), harnessDoesInteractiveLogin('codex')];

    // Assert
    should(actual).deepEqual([true, true]);
  });

  it('should declare an answer for every harness kind', () => {
    // Act
    const actual = Object.keys(HARNESS_LOGIN_DECLARATIONS).sort();

    // Assert
    should(actual).deepEqual(['claude', 'codex']);
  });

  it('should report no reason when a harness does log in', () => {
    // Act
    const actual = harnessNoLoginReason('claude');

    // Assert
    should(actual).be.undefined();
  });

  it('should honour a declaration that a harness does not log in', () => {
    // Act
    const actual = harnessDoesInteractiveLogin('codex', CODEX_HAS_NO_LOGIN);

    // Assert
    should(actual).be.false();
  });

  it('should report the declared reason a harness does not log in', () => {
    // Act
    const actual = harnessNoLoginReason('codex', CODEX_HAS_NO_LOGIN);

    // Assert
    should(actual).equal('this build of Codex authenticates from a service account');
  });

  it('should leave the other harness alone when one declares no login', () => {
    // Act
    const actual = harnessDoesInteractiveLogin('claude', CODEX_HAS_NO_LOGIN);

    // Assert
    should(actual).be.true();
  });
});
