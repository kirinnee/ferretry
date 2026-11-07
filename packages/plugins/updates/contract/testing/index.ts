/** `@ferretry/plugin-updates/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import { type UpdateStatus, UpdateStatusSchema, type UpdatesApi } from '../index.ts';

/** An `UpdatesApi` answering a fixed status. */
export function fakeUpdates(status: Partial<UpdateStatus> = {}): UpdatesApi {
  const fixed = UpdateStatusSchema.parse({
    current: '5.0.0',
    available: false,
    autoInstall: false,
    midTurn: 0,
    ...status,
  });
  return { status: async () => fixed };
}

/** What every `UpdatesApi` keeps. */
export function updatesConformance(name: string, make: () => UpdatesApi): void {
  describe(`UpdatesApi conformance: ${name}`, () => {
    test('the status parses, and "available" never claims a release it does not name', async () => {
      const status = await make().status();
      expect(UpdateStatusSchema.safeParse(status).success).toBe(true);
      if (status.available) expect(status.latest).toBeDefined();
    });
  });
}
