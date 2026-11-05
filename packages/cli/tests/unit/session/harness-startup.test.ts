import { describe, it } from 'bun:test';
import should from 'should';
import {
  harnessReadySeconds,
  harnessReadyWords,
  SLOW_CODEX_START_MS,
  slowCodexStartNote,
} from '../../../src/lib/session/harness-startup.ts';
import { sessionView } from './session-fixtures.ts';

const NOTE =
  'Codex waited on its account check with chatgpt.com; a slow start is the network, not this machine (docs/message-delivery.md).';

describe('harnessReadySeconds', () => {
  it('should read seconds to one decimal', () => {
    should(harnessReadySeconds(4_200)).equal('4.2 s');
    should(harnessReadySeconds(950)).equal('1.0 s');
    should(harnessReadySeconds(0)).equal('0.0 s');
    should(harnessReadySeconds(12_340)).equal('12.3 s');
  });
});

describe('harnessReadyWords', () => {
  it('should say how long the harness took, and nothing when the start was never measured', () => {
    should(harnessReadyWords(sessionView({}, { harnessStartupMs: 4_200 }))).equal('harness ready in 4.2 s');
    should(harnessReadyWords(sessionView())).be.undefined();
  });
});

describe('slowCodexStartNote', () => {
  it('should explain a Codex start of three seconds or more', () => {
    should(slowCodexStartNote(sessionView({ harness: 'codex' }, { harnessStartupMs: SLOW_CODEX_START_MS }))).equal(
      NOTE,
    );
    should(slowCodexStartNote(sessionView({ harness: 'codex' }, { harnessStartupMs: 30_000 }))).equal(NOTE);
  });

  it('should stay quiet for a fast Codex start, an unmeasured one, and any other harness', () => {
    should(
      slowCodexStartNote(sessionView({ harness: 'codex' }, { harnessStartupMs: SLOW_CODEX_START_MS - 1 })),
    ).be.undefined();
    should(slowCodexStartNote(sessionView({ harness: 'codex' }))).be.undefined();
    should(slowCodexStartNote(sessionView({ harness: 'claude' }, { harnessStartupMs: 20_000 }))).be.undefined();
  });
});
