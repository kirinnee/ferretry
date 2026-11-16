import { describe, expect, it } from 'bun:test';
import type { RuntimeHome, RuntimeId } from '../../../contract/index.ts';
import { profileSecretNames } from '../../../daemon/lib/service/profile-references.ts';

const home = (runtime: string, secretEnv?: Record<string, string>): RuntimeHome => ({
  id: runtime,
  harness: 'claude-code',
  runtimes: [runtime as RuntimeId],
  home: `/fleet/homes/${runtime}`,
  wrapper: `/fleet/homes/${runtime}/bin/claude`,
  ...(secretEnv === undefined ? {} : { secretEnv }),
});

describe('the secret names a runtime profile binds', () => {
  const homes = [
    home('work', { A: '${secret:WORK_KEY}', B: 'Bearer ${secret:WORK_KEY} ${secret:OTHER_KEY}' }),
    home('plain'),
  ];

  it('names every secret the runtime’s bindings reference, once, and no value', () => {
    expect([...profileSecretNames(homes, 'work')].sort()).toEqual(['OTHER_KEY', 'WORK_KEY']);
  });

  it('names none for a runtime that binds none, or one no home lists', () => {
    expect(profileSecretNames(homes, 'plain')).toEqual([]);
    expect(profileSecretNames(homes, 'nobody')).toEqual([]);
  });
});
