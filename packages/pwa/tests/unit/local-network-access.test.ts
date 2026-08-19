import { describe, it } from 'bun:test';
import should from 'should';
import {
  type LocalNetworkAccess,
  localNetworkBlocked,
  type LocalNetworkPermissions,
  readLocalNetworkAccess,
} from '../../src/lib/local-network-access.ts';

/** A browser that answers one scripted state, and records every name it was asked by. */
const answering = (
  state: string,
  asked: string[] = [],
): LocalNetworkPermissions & { readonly asked: readonly string[] } => ({
  asked,
  query(descriptor: { readonly name: string }): Promise<{ readonly state: string }> {
    asked.push(descriptor.name);
    return Promise.resolve({ state });
  },
});

/** A browser that rejects the names it does not know, which is what Chrome does for an unknown one. */
const knowing = (
  known: string,
  state: string,
  asked: string[] = [],
): LocalNetworkPermissions & { readonly asked: readonly string[] } => ({
  asked,
  query(descriptor: { readonly name: string }): Promise<{ readonly state: string }> {
    asked.push(descriptor.name);
    return descriptor.name === known
      ? Promise.resolve({ state })
      : Promise.reject(new TypeError(`Failed to execute 'query': ${descriptor.name} is not a valid permission name`));
  },
});

describe('what the browser says about reaching the local network', () => {
  it('should read the three states the browser spells, keeping prompt distinct from denied', async () => {
    // Arrange / Act
    const actual = await Promise.all(
      (['granted', 'prompt', 'denied'] as const).map(state => readLocalNetworkAccess(answering(state))),
    );

    // Assert
    should(actual).deepEqual(['granted', 'prompt', 'denied']);
  });

  /**
   * THE MEASUREMENT THIS WHOLE FEATURE RESTS ON. On real Chrome 150 the state reads `"prompt"` WHILE the
   * fetch is refused and zero requests reach the server: Chrome does not raise a prompt to make it
   * `"denied"` first. So a caller that treats anything but `"denied"` as fine reports the blocked case as
   * healthy, which is the wrong-cause failure this replaces.
   */
  it('should count prompt as blocked, exactly as denied is', () => {
    // Act / Assert
    should(localNetworkBlocked('prompt')).be.true();
    should(localNetworkBlocked('denied')).be.true();
    should(localNetworkBlocked('granted')).be.false();
    should(localNetworkBlocked('unknown')).be.false();
  });

  it('should ask by the name Chrome answers to, and ask only once when it answers', async () => {
    // Arrange
    const asked: string[] = [];
    const browser = answering('prompt', asked);

    // Act
    const actual = await readLocalNetworkAccess(browser);

    // Assert — one query on a failure path, never a walk through every spelling.
    should(actual).equal('prompt');
    should(asked).deepEqual(['local-network-access']);
  });

  it('should try the other real spellings when a browser rejects the first name', async () => {
    // Arrange
    const asked: string[] = [];
    const browser = knowing('loopback-network', 'denied', asked);

    // Act
    const actual = await readLocalNetworkAccess(browser);

    // Assert
    should(actual).equal('denied');
    should(asked).deepEqual(['local-network-access', 'local-network', 'loopback-network']);
  });

  /**
   * Firefox, Safari, an older Chrome, or a browser refusing the query for a reason of its own. Never a
   * throw and never a guess: `'unknown'` is worded as two possibilities rather than as a diagnosis.
   */
  it('should answer unknown when no name is a name this browser knows', async () => {
    // Arrange
    const asked: string[] = [];
    const browser = knowing('no-such-permission', 'granted', asked);

    // Act
    const actual = await readLocalNetworkAccess(browser);

    // Assert
    should(actual).equal('unknown');
    should(asked).have.length(3);
  });

  it('should answer unknown for a state this app does not know, without asking again', async () => {
    // Arrange
    const asked: string[] = [];
    const browser = answering('not-a-permission-state', asked);

    // Act
    const actual = await readLocalNetworkAccess(browser);

    // Assert — the browser replied; asking the next spelling would be asking the same browser twice.
    should(actual).equal('unknown');
    should(asked).deepEqual(['local-network-access']);
  });

  it('should answer unknown when the browser has no permission interface at all', async () => {
    // Act
    const actual = await readLocalNetworkAccess(undefined);

    // Assert
    should(actual).equal('unknown');
  });

  /**
   * The default argument really is the browser, which is the part that silently stops working: a stored
   * bare `query` would throw `Illegal invocation`, and this proves the owner is carried and called on.
   */
  it('should read this browser when nothing is supplied', async () => {
    // Arrange
    const asked: string[] = [];
    const browser = answering('granted', asked);
    const restore = Object.getOwnPropertyDescriptor(globalThis.navigator, 'permissions');
    Object.defineProperty(globalThis.navigator, 'permissions', { value: browser, configurable: true });

    // Act
    let actual: LocalNetworkAccess;
    try {
      actual = await readLocalNetworkAccess();
    } finally {
      // Restored before any assertion can fail: one Bun invocation runs every file in this tier, so a
      // patched browser global left behind is a failure in some other suite entirely.
      if (restore === undefined) Reflect.deleteProperty(globalThis.navigator, 'permissions');
      else Object.defineProperty(globalThis.navigator, 'permissions', restore);
    }

    // Assert
    should(actual).equal('granted');
    should(asked).deepEqual(['local-network-access']);
    // Whatever was there before is there again — which is NOT always nothing: one Bun invocation runs
    // every file in this tier, so a sibling suite may already have installed a `Permissions` here.
    should(Object.getOwnPropertyDescriptor(globalThis.navigator, 'permissions')?.value).equal(restore?.value);
  });
});
