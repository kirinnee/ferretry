/** banned-globals: only the listed folders that run outside the kernel are exempt (lead decision 17). */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { WorkspacePackage } from '../lib/workspace.ts';
import { bannedScope, OUTSIDE_THE_KERNEL } from '../../validate/banned-globals.ts';

const pkg = (id: string): WorkspacePackage =>
  ({
    id,
    kind: 'plugin',
    dir: `/repo/packages/plugins/${id}`,
    name: `@ferretry/plugin-${id}`,
  }) as unknown as WorkspacePackage;
const at = (id: string, rel: string): [WorkspacePackage, string] => [
  pkg(id),
  join(`/repo/packages/plugins/${id}`, rel),
];

describe('banned-globals scope: the explicit outside-the-kernel list', () => {
  test('the relay and catalog Workers and the WebRTC native adapter are exempt, each with a reason', () => {
    expect(bannedScope(...at('connections', 'worker/src/index.ts'))).toBe(false);
    expect(bannedScope(...at('catalogs', 'worker/index.ts'))).toBe(false);
    expect(bannedScope(...at('connections', 'adapters/webrtc/node-datachannel-engine.ts'))).toBe(false);
    expect(OUTSIDE_THE_KERNEL.every(entry => entry.reason.length > 0)).toBe(true);
  });

  test('a daemon half, another plugin’s worker folder, or a look-alike name stays in scope', () => {
    expect(bannedScope(...at('connections', 'daemon/lib/relay/link.ts'))).toBe(true);
    expect(bannedScope(...at('mcp', 'worker/index.ts'))).toBe(true);
    expect(bannedScope(...at('connections', 'workers/index.ts'))).toBe(true);
  });
});
