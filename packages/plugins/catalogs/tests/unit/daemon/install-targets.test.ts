/**
 * THE INSTALL TARGETS A MACHINE OFFERS (B16): `GET /v1/catalog-installs/targets` answers the runtimes an item can be
 * installed into on THIS machine, read from the item provider's runtime installer (the one Runtimes answers through
 * Skills/MCP). It is a read, so it is a `fleet.use` act any caller may make; it carries ids, names, profiles and
 * harnesses and nothing a runtime holds (no login, no path, no secret).
 */
import { describe, expect, it } from 'bun:test';
import { catalogsFixture, mcpServer } from '../../support/daemon-host.ts';

const RUNTIME = { id: 'work', name: 'work', profile: 'default', harness: 'claude' } as const;

describe('the install targets read', () => {
  it('should answer the runtimes the item provider names, with the profile each one launches with', async () => {
    // Arrange
    const fx = await catalogsFixture({
      mcp: [mcpServer('docs')],
      runtimes: [RUNTIME, { id: 'night', name: 'night', profile: 'lean', harness: 'codex' }],
    });

    // Act
    const answered = await fx.host.request('GET', '/v1/catalog-installs/targets');

    // Assert
    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({
      runtimes: [RUNTIME, { id: 'night', name: 'night', profile: 'lean', harness: 'codex' }],
    });
  });

  it('should answer no runtimes, not an error, when the machine has none', async () => {
    // Arrange
    const fx = await catalogsFixture({ mcp: [mcpServer('docs')] });

    // Act
    const answered = await fx.host.request('GET', '/v1/catalog-installs/targets');

    // Assert
    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ runtimes: [] });
  });
});
