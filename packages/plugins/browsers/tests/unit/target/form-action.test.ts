import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { boundedAction } from '../../../daemon/target/lib/form-action.ts';

describe('full canonical form destinations with safe display', () => {
  it('hashes query and fragment even on short actions and redacts their raw text', () => {
    const raw = 'https://example.test/send?token=FAKE_QUERY#FAKE_FRAGMENT';
    const action = boundedAction(raw, 256);
    expect(action.display).toBe('https://example.test/send?[redacted]#[redacted]');
    expect(action.digest).toBe(createHash('sha256').update(new URL(raw).href).digest('hex'));
    expect(boundedAction(raw.replace('FAKE_QUERY', 'OTHER'), 256).digest).not.toBe(action.digest);
    expect(boundedAction(raw.replace('FAKE_FRAGMENT', 'OTHER'), 256).digest).not.toBe(action.digest);
  });

  it('compares the full parsed origin even when the entire display prefix is shared', () => {
    const prefix = `https://${(`${'a'.repeat(50)}.`).repeat(5)}`;
    const left = boundedAction(`${prefix}left.test/send`, 256);
    const right = boundedAction(`${prefix}right.test/send`, 256);
    expect(left.display).toBe(right.display);
    expect(left.originDigest).not.toBe(right.originDigest);
  });

  it('bounds the display and keeps the redaction markers on long destinations', () => {
    const action = boundedAction(`https://example.test/${'p'.repeat(300)}?FAKE_QUERY#FAKE_FRAGMENT`, 256);
    expect(action.display.length).toBe(256);
    expect(action.display.endsWith('?[redacted]#[redacted]')).toBe(true);
    expect(action.display).not.toContain('FAKE_');
  });
});
