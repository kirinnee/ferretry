import { describe, expect, it } from 'bun:test';
import { HarnessKeySchema, OpenRecordedHarnessSchema } from '../../contract/index.ts';

describe('the harness a session document may name', () => {
  it('should accept exactly the shapes a harness KEY can have, and refuse a malformed key like `a--b`', () => {
    for (const word of ['claude', 'codex', 'claude-code', 'fake-third', 'a1-b2', 'a'.repeat(40)])
      expect(OpenRecordedHarnessSchema.safeParse(word).success).toBe(HarnessKeySchema.safeParse(word).success);
    for (const word of ['a--b', '-a', 'a-', '1a', 'A', 'a_b', '', 'a'.repeat(41)]) {
      expect(HarnessKeySchema.safeParse(word).success).toBe(false);
      expect(OpenRecordedHarnessSchema.safeParse(word).success).toBe(false);
    }
  });
});
