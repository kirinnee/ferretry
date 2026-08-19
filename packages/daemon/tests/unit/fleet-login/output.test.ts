import { describe, it } from 'bun:test';
import should from 'should';
import { stripTerminalEscapes, verificationUrlIn } from '../../../src/lib/fleet-login/output.ts';

const ESC = '\u001b';
const BEL = '\u0007';

/**
 * The line `claude auth login --claudeai` was OBSERVED to write at claude-code 2.1.220, byte for byte.
 *
 * The URL appears twice because an OSC 8 hyperlink carries its target inside the escape and repeats it
 * as the visible text. A stripper that only removed colour would leave both copies.
 */
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge_method=S256&state=abc';
const CLAUDE_LINE = `If the browser didn't open, visit: ${ESC}]8;;${CLAUDE_URL}${BEL}${CLAUDE_URL}${ESC}]8;;${BEL}`;

/** The two lines `codex login --device-auth` was observed to write at codex-cli 0.145.0. */
const CODEX_URL_LINE = `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`;
const CODEX_CODE_LINE = `   ${ESC}[94m0IER-FFQW6${ESC}[0m`;

describe('stripTerminalEscapes', () => {
  it('should leave exactly one URL from an OSC 8 hyperlink, not two', () => {
    // Act
    const actual = stripTerminalEscapes(CLAUDE_LINE);

    // Assert
    should(actual).equal(`If the browser didn't open, visit: ${CLAUDE_URL}`);
  });

  it('should remove the colour a harness writes even when stdout is a pipe', () => {
    // Act
    const actual = [stripTerminalEscapes(CODEX_URL_LINE), stripTerminalEscapes(CODEX_CODE_LINE)];

    // Assert
    should(actual).deepEqual(['   https://auth.openai.com/codex/device', '   0IER-FFQW6']);
  });

  it('should remove an OSC sequence terminated by a string terminator rather than a bell', () => {
    // Act
    const actual = stripTerminalEscapes(`visit: ${ESC}]8;;https://example.test${ESC}\\here`);

    // Assert
    should(actual).equal('visit: here');
  });

  it('should remove cursor movement and erasure, not only colour', () => {
    // Act
    const actual = stripTerminalEscapes(`${ESC}[2K${ESC}[1Gwaiting${ESC}[?25l`);

    // Assert
    should(actual).equal('waiting');
  });

  it('should remove a two-character character-set escape', () => {
    // Act
    const actual = stripTerminalEscapes(`${ESC}(Bplain${ESC}=text${ESC}#8`);

    // Assert
    should(actual).equal('plaintext');
  });

  it('should remove a stray control character that survives every escape rule', () => {
    // Act
    const actual = stripTerminalEscapes('code\u0000here\u007f\u0008');

    // Assert
    should(actual).equal('codehere');
  });

  it('should leave an ordinary line untouched', () => {
    // Act
    const actual = stripTerminalEscapes('Paste code here if prompted > ');

    // Assert
    should(actual).equal('Paste code here if prompted > ');
  });
});

describe('verificationUrlIn', () => {
  it('should find the URL Claude prints once the hyperlink escape is gone', () => {
    // Act
    const actual = verificationUrlIn(stripTerminalEscapes(CLAUDE_LINE), ['claude.com']);

    // Assert
    should(actual).equal(CLAUDE_URL);
  });

  it('should find the URL Codex prints once its colour is gone', () => {
    // Act
    const actual = verificationUrlIn(stripTerminalEscapes(CODEX_URL_LINE), ['openai.com']);

    // Assert
    should(actual).equal('https://auth.openai.com/codex/device');
  });

  it('should accept a subdomain of a declared host', () => {
    // Act
    const actual = verificationUrlIn('go to https://auth.openai.com/codex/device now', ['openai.com']);

    // Assert
    should(actual).equal('https://auth.openai.com/codex/device');
  });

  it('should refuse a host that merely ends with the declared one', () => {
    // Act
    const actual = verificationUrlIn('go to https://evil-claude.com/sign-in', ['claude.com']);

    // Assert
    should(actual).be.undefined();
  });

  it('should refuse a URL on a host nobody declared, however plausible', () => {
    // Act
    const actual = verificationUrlIn('read https://docs.example.test/logging-in for help', ['claude.com']);

    // Assert
    should(actual).be.undefined();
  });

  it('should ignore plain http, which the wire schema would refuse anyway', () => {
    // Act
    const actual = verificationUrlIn('visit http://claude.com/cai/oauth/authorize', ['claude.com']);

    // Assert
    should(actual).be.undefined();
  });

  it('should drop the punctuation that ends a sentence rather than a URL', () => {
    // Act
    const actual = verificationUrlIn('Open https://claude.com/cai/oauth/authorize.', ['claude.com']);

    // Assert
    should(actual).equal('https://claude.com/cai/oauth/authorize');
  });

  it('should keep a query string, because the PKCE challenge lives there', () => {
    // Act
    const actual = verificationUrlIn(`visit ${CLAUDE_URL}`, ['claude.com']);

    // Assert
    should(actual).match(/code_challenge_method=S256/u);
  });

  it('should skip a candidate that is not parseable and take the one that is', () => {
    // Act
    const actual = verificationUrlIn('https://%%% then https://claude.com/ok', ['claude.com']);

    // Assert
    should(actual).equal('https://claude.com/ok');
  });

  it('should find nothing in a line with no address at all', () => {
    // Act
    const actual = verificationUrlIn('Opening browser to sign in…', ['claude.com']);

    // Assert
    should(actual).be.undefined();
  });
});
