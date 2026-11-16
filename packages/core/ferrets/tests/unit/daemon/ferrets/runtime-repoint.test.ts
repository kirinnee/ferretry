import { describe, expect, test } from 'bun:test';
import { repointedSessionConfig, sessionRuntimeFacts } from '../../../../daemon/lib/ferrets/runtime-repoint.ts';

/**
 * c58-28b: what a runtime rename does to a ferret's session config (v4's `renamedSessionConfig`, now Ferrets' own), and
 * what the config says about the runtime it launched as. Pure: the storage's locked write is `session-files.test.ts`'s.
 */

const WRAPPER = '/fleet/bin/work';
const rename = { from: 'work', to: 'play', fromWrapper: WRAPPER, toWrapper: '/fleet/bin/play' };

describe('repointedSessionConfig', () => {
  test('re-points a name and the head of the argv, keeping the rest of both', () => {
    expect(repointedSessionConfig({ agent: 'work', command: [WRAPPER, '--resume', 'x'], extra: 1 }, rename)).toEqual({
      agent: 'play',
      command: ['/fleet/bin/play', '--resume', 'x'],
      extra: 1,
    });
  });

  test('turns a wrapper path into the new wrapper path, and leaves an absent argv absent', () => {
    expect(repointedSessionConfig({ agent: WRAPPER }, rename)).toEqual({ agent: '/fleet/bin/play' });
  });

  test('moves only the argv when the agent names another runtime but the wrapper is the old one', () => {
    expect(repointedSessionConfig({ agent: 'else', command: [WRAPPER] }, rename)).toEqual({
      agent: 'else',
      command: ['/fleet/bin/play'],
    });
  });

  test('says nothing for a config that names neither the old runtime nor its wrapper', () => {
    expect(repointedSessionConfig({ agent: 'else', command: ['/fleet/bin/else'] }, rename)).toBeUndefined();
    expect(repointedSessionConfig({ agent: 'else', command: 'not-an-argv' }, rename)).toBeUndefined();
  });

  test('says nothing for a document that is not an object', () => {
    for (const odd of [undefined, null, 'work', [{ agent: 'work' }]])
      expect(repointedSessionConfig(odd, rename)).toBeUndefined();
  });
});

describe('sessionRuntimeFacts', () => {
  test('reads the agent and the wrapper at the head of the argv', () => {
    expect(sessionRuntimeFacts({ agent: 'work', command: [WRAPPER, '-x'] })).toEqual({
      agent: 'work',
      executable: WRAPPER,
    });
    expect(sessionRuntimeFacts({ agent: 'work' })).toEqual({ agent: 'work' });
  });

  test('says nothing of a field that is not non-empty text, and nothing at all of a document that is not an object', () => {
    expect(sessionRuntimeFacts({ agent: '', command: [''] })).toEqual({});
    expect(sessionRuntimeFacts({ agent: 4, command: 'not-an-argv' })).toEqual({});
    for (const odd of [undefined, null, 'work', [{ agent: 'work' }]]) expect(sessionRuntimeFacts(odd)).toBeUndefined();
  });
});
