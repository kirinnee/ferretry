import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

/**
 * The composition root builds the lifecycle's pane launcher and its conversation leases in one place, and what it hands
 * them is a SECURITY fact: a lifecycle that already holds a ferret's key on the shared queue must reach the service
 * through the HELD launch and stop (a queued `resume` or `stop` would wait on that same key, and a plain `resume` runs
 * with an owner's authority), and every lifecycle it builds must claim conversations. `daemon/index.ts` is too large to
 * boot here, so the pin reads what it wires.
 */

const ROOT = new URL('../../../../daemon/index.ts', import.meta.url);

/** The text of the `sessionFilesDeps` object literal the root builds the session files from. */
async function sessionFilesDeps(): Promise<string> {
  const source = await readFile(ROOT, 'utf8');
  const start = source.indexOf('const sessionFilesDeps = {');
  const end = source.indexOf('} satisfies SessionFilesDeps', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('the composition root', () => {
  test('should build the lifecycle launcher only through heldLifecycleLauncher over the service, never by hand', async () => {
    // Arrange
    const source = await readFile(ROOT, 'utf8');
    const deps = await sessionFilesDeps();

    // Assert — the one mapping of launch, stop and the check ahead onto the held variants is heldLifecycleLauncher
    expect(deps).toContain('launcher: heldLifecycleLauncher(() => service,');
    expect(source).not.toContain('new FerretSessionLifecycleLauncher(');
    expect(deps).not.toMatch(/service\.(resume|stop|start)\(/u);
  });

  test('should bind the daemon’s conversation leases into the session files, and require them in the type', async () => {
    // Arrange
    const source = await readFile(ROOT, 'utf8');
    const deps = await sessionFilesDeps();

    // Assert
    expect(deps).toContain('leases: conversationLeases,');
    expect(source).toContain('const conversationLeases = new ConversationLeases(');
    expect(source).toContain('new ConversationLeaseStateDisk(');
    expect(source).toContain("Required<Pick<SessionFilesDeps, 'tokenCutOff' | 'launcher' | 'leases'>>");
  });

  test('should hand the SAME leases to Ferrets’ launch, so the one place every pane opens holds its conversation', async () => {
    // Arrange
    const source = await readFile(ROOT, 'utf8');

    // Assert
    expect(source).toMatch(/vault: needs\.vault,\s*asks: needs\.asks,\s*leases: conversationLeases,/u);
  });

  test('should name the holder as this daemon’s pid, so a restarted daemon still reads a pane it launched as writing by its session', async () => {
    // Arrange
    const deps = await readFile(ROOT, 'utf8');

    // Assert
    expect(deps).toMatch(
      /registryLeaseSessions\(\s*registry,\s*async id => await sessionStore\.readState\(id\),\s*key => harnessOf\(key\)\?\.facts,\s*\),\s*process\.pid,/u,
    );
  });
});
