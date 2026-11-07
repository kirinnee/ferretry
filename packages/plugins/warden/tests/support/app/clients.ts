/** A Warden client that answers every route with a quiet default, so a test overrides only the routes it is about. */

import type { WardenClient } from '../../../app/lib/warden-client.ts';
import { wardenAgenda, wardenConfig, wardenStatus } from './warden.ts';

export const fakeWardenClient = (overrides: Partial<WardenClient> = {}): WardenClient => ({
  status: async () => wardenStatus(),
  verdicts: async () => [],
  report: async path => `# Evidence from ${path}`,
  agenda: async () => wardenAgenda(),
  run: async () => ({ sweptAt: '2026-07-31T12:00:00.000Z', flags: [] }),
  investigate: async request => ({ ferret: request.ferret, state: 'queued', message: 'queued' }),
  leave: async request => ({
    blessing: { ferret: request.ferret, kinds: [], expiresAt: '2026-07-31T13:00:00.000Z', by: 'owner' },
    message: 'Left alone.',
  }),
  config: async () => ({ config: wardenConfig(), accounts: [], warnings: [] }),
  updateConfig: async () => ({ config: wardenConfig(), accounts: [], warnings: [] }),
  ...overrides,
});
