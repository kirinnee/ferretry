import { describe, it } from 'bun:test';
import { join } from 'node:path';
import { stateHomeFence } from '@ferretry/fleet';
import should from 'should';
import { componentSourceFence } from '../../../src/adapters/fleet/account-model-files.ts';
import { LOGIN_SECRETS_DOCUMENT } from '../../../src/adapters/secrets/file-login-index-store.ts';
import {
  MCP_OAUTH_SECRETS_DOCUMENT,
  SECRETS_DOCUMENT,
  SECRETS_KEY,
} from '../../../src/adapters/secrets/file-secret-document-store.ts';
import { createFoundationPaths } from '../../../src/lib/paths.ts';
import type { StateHome } from '../../../src/lib/state-home.ts';

/**
 * The fleet package owns the state home's fence (`stateHomeFence`), which `fy history claim` resolves with no daemon
 * to ask. These hold the daemon's own names for the same places to it, so a store that moves its file, or a layout
 * that moves a folder, fails here instead of leaving the fence guarding the old name.
 */
describe('stateHomeFence — the daemon lays the home out where the fence guards it', () => {
  const home = '/srv/fy' as StateHome;
  const paths = createFoundationPaths(home);
  const fence = stateHomeFence(home);

  it('should fence the same homes and open the same asset tree as the component-source fence', () => {
    // Act
    const daemon = componentSourceFence(paths);

    // Assert
    should({ homes: fence.homes, open: fence.open }).eql({ homes: daemon.homes, open: daemon.open });
  });

  it('should pin every secret document, the identity and the folders the daemon writes them in', () => {
    // Arrange
    const written = [
      ...[SECRETS_KEY, SECRETS_DOCUMENT, MCP_OAUTH_SECRETS_DOCUMENT, LOGIN_SECRETS_DOCUMENT].map(name =>
        join(paths.state, name),
      ),
      paths.daemonIdentity,
      paths.fleet,
      join(paths.fleet, 'homes'),
      paths.sessions,
    ];

    // Act
    const unpinned = written.filter(place => !fence.pinned.includes(place));

    // Assert
    should(unpinned).eql([]);
  });
});
