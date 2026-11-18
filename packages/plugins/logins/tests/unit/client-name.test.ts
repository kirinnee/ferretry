import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * The command a sign-in refusal tells a person to type is the binary they run (`fy`, or the name the operator gave it:
 * `fy5`), which the kernel's identity carries. A literal product name there once said `ferretry login signin …`, a
 * command that does not exist. The refusal's wording itself is covered by the harness-login service tests; this holds the
 * composition to the one source.
 */
test('the sign-in remedy names the binary from the kernel identity, never a literal', () => {
  const source = readFileSync(new URL('../../daemon/index.ts', import.meta.url), 'utf8');
  expect(source).toContain('clientName: kernel.identity.binaries.client');
  expect(source).not.toMatch(/clientName:\s*['"]/u);
});
