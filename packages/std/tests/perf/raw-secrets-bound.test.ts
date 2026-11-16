/**
 * `rawTextSecretLine` is linear: each hostile line of 256 KiB is scanned in under a hard bound per call, far above one
 * linear pass (R6 critical: the line pattern it replaced backtracked cubically on blanks). The answers are the unit
 * tier's (`tests/unit/raw-secrets.test.ts`), at a small size.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { rawTextSecretLine } from '../../src/credential-words/index.ts';
import { FULL_KIB, hostileLines } from '../unit/raw-secrets-hostile.ts';

const BOUND_MS = 1500;

describe('rawTextSecretLine — a hostile line is scanned within a bound', () => {
  it.each(hostileLines(FULL_KIB))('should scan %s in under 1500 ms (R6 critical)', (_label, text) => {
    // Act
    const started = performance.now();
    rawTextSecretLine(text);

    // Assert
    should(performance.now() - started).be.below(BOUND_MS);
  });
});
