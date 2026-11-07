/**
 * Finding 7 (ports-pending honesty): Voice's machine clean-up and the setup rail's Voice default read and write
 * `voice.yaml` through `GET/PUT /v1/config/file`, which the KERNEL declares (D2 #3). Until a compiled manifest
 * declares them, `@ferretry/app`'s client refuses those calls before sending, so the two surfaces stay named in
 * `ports-pending.json` with that reason. When the kernel declares the routes this test fails: drop the entries.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import kernel from '@ferretry/kernel/plugin';

const ROOT = join(import.meta.dir, '../../../../../..');
const SURFACES = [
  'packages/plugins/voice/app/features/settings/use-machine-voice-cleanup.ts',
  'packages/plugins/voice/app/features/fleet/setup/voice-default.ts',
];

describe('Voice surfaces that wait on the kernel config routes', () => {
  test('the routes are still undeclared, and each surface is pending with the reason', () => {
    const declared = (kernel.actions?.routes ?? []).map(route => route.key);
    expect(declared).not.toContain('GET /v1/config/file');
    expect(declared).not.toContain('PUT /v1/config/file');
    const pending = JSON.parse(readFileSync(join(ROOT, 'ports-pending.json'), 'utf8')) as {
      pendingAppPorts: { plugin: string; path: string; reason: string }[];
    };
    for (const path of SURFACES) {
      const entry = pending.pendingAppPorts.find(port => port.path === path);
      expect(entry?.plugin).toBe('voice');
      expect(entry?.reason).toContain('D2 #3');
    }
  });
});
