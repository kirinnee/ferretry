/**
 * The contract suite reads real TUI screens, so the transcript they are read from must survive a PTY
 * delivering a multi-byte character in two chunks. Pure and offline: it runs in every tier.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { terminalTranscript } from './support/fixtures.ts';

const BAR = '│';

describe('contract support: terminal transcript', () => {
  it('keeps a character that arrives split across chunks, at every split point', () => {
    const bytes = new TextEncoder().encode(`Permissions: Full Access ${BAR} Agents.md:`);
    for (let cut = 1; cut < bytes.length; cut++) {
      const transcript = terminalTranscript();
      transcript.feed(bytes.slice(0, cut));
      transcript.feed(bytes.slice(cut));
      should(transcript.text()).equal(`Permissions: Full Access ${BAR} Agents.md:`);
    }
  });

  it('keeps a character delivered one byte at a time', () => {
    const transcript = terminalTranscript();
    for (const byte of new TextEncoder().encode(`${BAR}${BAR}`)) transcript.feed(Uint8Array.of(byte));
    should(transcript.text()).equal(`${BAR}${BAR}`);
  });
});
