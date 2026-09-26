import { describe, it } from 'bun:test';
import { homedir } from 'node:os';
import should from 'should';
import { resolveUserHome } from '../../src/adapters/user-home.ts';

describe('resolveUserHome', () => {
  it('should honour an absolute HOME over the account home', () => {
    // Act
    const actual = resolveUserHome({ HOME: '/tmp/isolated-home' }, () => '/home/owner');

    // Assert
    should(actual).equal('/tmp/isolated-home');
  });

  it('should fall back to the account home when HOME is unset', () => {
    // Act
    const actual = resolveUserHome({}, () => '/home/owner');

    // Assert
    should(actual).equal('/home/owner');
  });

  it('should fall back to the account home when HOME is empty or relative', () => {
    // Act
    const empty = resolveUserHome({ HOME: '' }, () => '/home/owner');
    const relative = resolveUserHome({ HOME: 'somewhere' }, () => '/home/owner');

    // Assert
    should(empty).equal('/home/owner');
    should(relative).equal('/home/owner');
  });

  it('should read the process environment and the user database by default', () => {
    // Act
    const actual = resolveUserHome();

    // Assert — whichever rule applies, the answer is one of the two sources and never invented.
    should([process.env.HOME, homedir()]).containEql(actual);
  });
});
