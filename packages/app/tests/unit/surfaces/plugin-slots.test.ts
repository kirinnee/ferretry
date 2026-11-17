import { describe, expect, test } from 'bun:test';
import { pluginIds, reachFrom } from '../../../src/testing/slot-wiring.ts';

/**
 * The slots a plugin screen offers (§5.2) are an agreement by name, and each plugin proves its own half against the real
 * compiled manifests in its own `tests/unit/app/slots.test.ts` (through `@ferretry/app/testing`), so a new contribution
 * edits one plugin's tests and no shared file. What stays here is about the registry as a whole.
 */

describe('the plugin graph', () => {
  test('no plugin reaches itself (core pieces consume each other through hooks and are ordered by the kernel)', () => {
    for (const id of pluginIds()) expect(reachFrom(id)).not.toContain(id);
  });
});
