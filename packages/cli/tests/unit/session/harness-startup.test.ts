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
  'Codex waits on an account check with chatgpt.com before it starts, so a slow start is usually the network (the first start on a new Codex home also indexes its history once) (docs/message-delivery.md).';

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

  it('should say a start that gave up waiting was not ready, never that it was ready in the bound', () => {
    const words = harnessReadyWords(sessionView({}, { harnessNotReadyAfterMs: 31_400 }));
    should(words).equal('harness not ready after 31.4 s');
    should(words).not.containEql('ready in');
  });
});

describe('slowCodexStartNote', () => {
  it('should explain a Codex start of three seconds or more', () => {
    should(slowCodexStartNote(sessionView({ harness: 'codex' }, { harnessStartupMs: SLOW_CODEX_START_MS }))).equal(
      NOTE,
    );
    should(slowCodexStartNote(sessionView({ harness: 'codex' }, { harnessStartupMs: 30_000 }))).equal(NOTE);
  });

  it('should explain a Codex start that gave up waiting too, without claiming the cause as fact', () => {
    should(slowCodexStartNote(sessionView({ harness: 'codex' }, { harnessNotReadyAfterMs: 30_000 }))).equal(NOTE);
    should(NOTE).containEql('usually the network');
    should(NOTE).not.containEql('not this machine');
  });

  it('should stay quiet for a fast Codex start, an unmeasured one, and any other harness', () => {
    should(
      slowCodexStartNote(sessionView({ harness: 'codex' }, { harnessStartupMs: SLOW_CODEX_START_MS - 1 })),
    ).be.undefined();
    should(slowCodexStartNote(sessionView({ harness: 'codex' }))).be.undefined();
    should(slowCodexStartNote(sessionView({ harness: 'claude' }, { harnessStartupMs: 20_000 }))).be.undefined();
  });
});
