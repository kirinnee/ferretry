import { describe, expect, test } from 'bun:test';
import type { ConfigFileStatus } from '@ferretry/kernel/contract';
import { DEFAULT_GATE_CONFIG, type GateConfig } from '../../../../contract/index.ts';
import { type GateConfigSource, policyInEffect } from '../../../../daemon/lib/policy/in-effect.ts';

const status = (fields: Pick<ConfigFileStatus, 'state' | 'inEffect'>): ConfigFileStatus => ({
  ...fields,
  sentences: [],
});
const written: GateConfig = { ...DEFAULT_GATE_CONFIG, warden: { remote: true } };

const source = (state: () => ConfigFileStatus, file: () => GateConfig | undefined): GateConfigSource => ({
  fileState: state,
  file,
});

describe('the policy in effect (G6 G152 G153 G154)', () => {
  test('G6 G152 an absent file is the product default', () => {
    expect(
      policyInEffect(
        source(
          () => status({ state: 'absent', inEffect: false }),
          () => undefined,
        ),
      ),
    ).toBe(DEFAULT_GATE_CONFIG);
  });

  test('a file in effect is the policy', () => {
    expect(
      policyInEffect(
        source(
          () => status({ state: 'valid', inEffect: true }),
          () => written,
        ),
      ),
    ).toBe(written);
  });

  test('G153 G154 a file that is there but not in effect is undetermined, never the default', () => {
    expect(
      policyInEffect(
        source(
          () => status({ state: 'invalid', inEffect: false }),
          () => written,
        ),
      ),
    ).toBeUndefined();
  });

  test('G154 a file whose state cannot be read, and a file that cannot be read, are undetermined', () => {
    expect(
      policyInEffect(
        source(
          () => {
            throw new Error('the state is unreadable');
          },
          () => written,
        ),
      ),
    ).toBeUndefined();
    expect(
      policyInEffect(
        source(
          () => status({ state: 'valid', inEffect: true }),
          () => {
            throw new Error('the file is unreadable');
          },
        ),
      ),
    ).toBeUndefined();
  });

  test('a file reported in effect that reads as nothing is undetermined, not the default', () => {
    expect(
      policyInEffect(
        source(
          () => status({ state: 'valid', inEffect: true }),
          () => undefined,
        ),
      ),
    ).toBeUndefined();
  });
});
