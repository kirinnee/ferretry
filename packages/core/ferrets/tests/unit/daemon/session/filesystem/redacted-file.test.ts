import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import {
  fileHoldsValue,
  redactedFile,
  redactedFileBase64,
  redactedFileText,
} from '../../../../../daemon/lib/session/filesystem/redacted-file.ts';

/** FAKE fixture values only. Assertions are booleans so a failure never prints them. */
const ONE_LINE = 'fixture-one-line-secret-0002';
const FIRST = 'fixture-first-row-0003';
const SECOND = 'fixture-second-row-0004';

const mask = async (bytes: Buffer, value: string): Promise<Buffer> =>
  Buffer.from(
    await new FakeRedaction(new Map([['V' as never, value]])).read(
      scope => redactedFileBase64(bytes.toString('base64'), scope).base64,
    ),
    'base64',
  );

describe('the outbound file projection, base64 (R-0151)', () => {
  it('R-0151 a value inside a file with a NUL byte is masked in the base64 read', async () => {
    const bytes = Buffer.concat([Buffer.from(`${FIRST}\n${SECOND}\n`), Buffer.from([0])]);
    const out = await mask(bytes, `${FIRST}\n${SECOND}`);
    should(out.includes(FIRST)).be.false();
    should(out.includes(SECOND)).be.false();
    should(out.length === bytes.length).be.true();
    should(out[out.length - 1] === 0).be.true();
  });

  it('R-0151 a one-line value in a file that is not valid UTF-8 is masked in the base64 read', async () => {
    const bytes = Buffer.concat([Buffer.from(`token: ${ONE_LINE}\n`), Buffer.from([0xff, 0xfe])]);
    const out = await mask(bytes, ONE_LINE);
    should(out.includes(ONE_LINE)).be.false();
    should(out.length === bytes.length).be.true();
    should(out.subarray(out.length - 2).equals(Buffer.from([0xff, 0xfe]))).be.true();
  });

  it('R-0151 a binary file with no vault value is served byte for byte', async () => {
    const bytes = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80]);
    should((await mask(bytes, ONE_LINE)).equals(bytes)).be.true();
  });

  it('R-0151 a multi-line value in a CRLF file is masked, and the CRs and the length are kept', async () => {
    const text = `head\r\n${FIRST}\r\n${SECOND}\r\ntail\r\n`;
    const out = await new FakeRedaction(new Map([['V' as never, `${FIRST}\n${SECOND}`]])).read(scope =>
      redactedFileText(text, scope),
    );
    should(out.includes(FIRST)).be.false();
    should(out.includes(SECOND)).be.false();
    should(out.length === text.length).be.true();
    // one mask per original line: the line break inside the value is never starred, so no lines merge
    should(out === `head\r\n${'*'.repeat(FIRST.length)}\r\n${'*'.repeat(SECOND.length)}\r\ntail\r\n`).be.true();
  });

  const LINES = ['fixture-file-first-0009', 'fixture-file-second-0010', 'fixture-file-third-0011'];
  const SINGLE = 'fixture-file-token-0012';
  const cases: [string, string, string][] = [];
  for (const stored of ['\n', '\r\n']) {
    for (const served of ['\n', '\r\n']) {
      const value = LINES.join(stored);
      cases.push([
        `a 3-line value stored with ${JSON.stringify(stored)}`,
        value,
        `head${served}${LINES.join(served)}${served}tail${served}`,
      ]);
    }
  }
  cases.push(['a one-line value stored with a trailing CR', `${SINGLE}\r`, `KEY=${SINGLE}\r\nnext\r\n`]);
  cases.push(['a one-line value stored without a CR', SINGLE, `KEY=${SINGLE}\r\nnext\r\n`]);

  for (const [name, value, text] of cases) {
    it(`R-0151 ${name} is masked, kept at its length and line count, and reported, as text and as base64`, async () => {
      const redaction = new FakeRedaction(new Map([['V' as never, value]]));
      const viaText = await redaction.read(scope => redactedFile(text, scope));
      const viaBase64 = await redaction.read(scope => redactedFileBase64(Buffer.from(text).toString('base64'), scope));
      const decoded = Buffer.from(viaBase64.base64, 'base64').toString('utf8');
      const leaks = (out: string): boolean => [...LINES, SINGLE].some(part => out.includes(part));
      should(leaks(viaText.text)).be.false();
      should(leaks(decoded)).be.false();
      should(viaText.covered && viaBase64.covered).be.true();
      should(
        viaText.text.length === text.length && viaText.text.split('\n').length === text.split('\n').length,
      ).be.true();
      should(decoded === viaText.text).be.true();
    });
  }

  it('R-0151 a prefix of a value is not matched', async () => {
    const out = await new FakeRedaction(new Map([['V' as never, SINGLE]])).read(scope =>
      redactedFile(`KEY=${SINGLE.slice(0, -2)}\r\n`, scope),
    );
    should(out.covered).be.false();
  });

  const EOF_LINES = ['fixture-eof-first-0021', 'fixture-eof-second-0022', 'fixture-eof-third-0023'];
  const EOF_ONE = 'fixture-eof-token-0024';
  const eofCases: [string, string, string][] = [];
  for (const served of ['\n', '\r\n']) {
    eofCases.push([
      `tok\\r on a last line with no final newline, ${JSON.stringify(served)} file`,
      `${EOF_ONE}\r`,
      `head${served}KEY=${EOF_ONE}`,
    ]);
    eofCases.push([
      `a CRLF-stored 3-line value with a trailing CR as the last lines, ${JSON.stringify(served)} file`,
      `${EOF_LINES.join('\r\n')}\r`,
      `head${served}${EOF_LINES.join(served)}`,
    ]);
  }
  for (const [name, value, text] of eofCases) {
    it(`R-0151 ${name} is masked as text, base64 and with a NUL byte, and reported`, async () => {
      const redaction = new FakeRedaction(new Map([['V' as never, value]]));
      const leaks = (out: string): boolean => [...EOF_LINES, EOF_ONE].some(part => out.includes(part));
      const viaText = await redaction.read(scope => redactedFile(text, scope));
      const viaB64 = await redaction.read(scope => redactedFileBase64(Buffer.from(text).toString('base64'), scope));
      const withNul = Buffer.concat([Buffer.from([0, 10]), Buffer.from(text)]);
      const viaNul = await redaction.read(scope => redactedFileBase64(withNul.toString('base64'), scope));
      should(leaks(viaText.text)).be.false();
      should(leaks(Buffer.from(viaB64.base64, 'base64').toString('latin1'))).be.false();
      should(leaks(Buffer.from(viaNul.base64, 'base64').toString('latin1'))).be.false();
      should(viaText.covered && viaB64.covered && viaNul.covered).be.true();
      should(viaText.text.length === text.length).be.true();
    });
  }

  it('R-0151 a value that is only a line break masks nothing and reports nothing', async () => {
    const out = await new FakeRedaction(new Map([['V' as never, '\r']])).read(scope =>
      redactedFile('KEY=abc\r\nnext\r\n', scope),
    );
    should(out.covered).be.false();
    should(out.text === 'KEY=abc\r\nnext\r\n').be.true();
  });

  it('R-0151 valid UTF-8 that holds a NUL is masked as text, so a non-ASCII value in it is found', async () => {
    const value = 'fixture-é-💥-value-0014';
    const bytes = Buffer.from(`\0KEY=${value}\n`, 'utf8');
    const out = await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
      redactedFileBase64(bytes.toString('base64'), scope),
    );
    should(out.covered).be.true();
    should(Buffer.from(out.base64, 'base64').toString('utf8').includes(value)).be.false();
    should(Buffer.from(out.base64, 'base64')[0] === 0).be.true();
  });

  it('R-0151 bytes that are not UTF-8 keep the latin1 pass: an ASCII value is masked, a non-ASCII one is the declared gap', async () => {
    const ascii = Buffer.concat([Buffer.from([0xff, 0]), Buffer.from(`KEY=${ONE_LINE}\n`)]);
    const out = await new FakeRedaction(new Map([['V' as never, ONE_LINE]])).read(scope =>
      redactedFileBase64(ascii.toString('base64'), scope),
    );
    should(out.covered).be.true();
    should(Buffer.from(out.base64, 'base64').toString('latin1').includes(ONE_LINE)).be.false();
    const value = 'fixture-é-value-0015';
    const wide = Buffer.concat([Buffer.from([0xff, 0]), Buffer.from(`KEY=${value}\n`, 'utf8')]);
    const gap = await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
      redactedFileBase64(wide.toString('base64'), scope),
    );
    should(gap.covered).be.false();
  });

  it('R-0151 fileHoldsValue answers for UTF-8 text, text with a NUL, and bytes that are not UTF-8', async () => {
    const holds = async (bytes: Buffer, value: string): Promise<boolean> =>
      await new FakeRedaction(new Map([['V' as never, value]])).read(scope => fileHoldsValue(bytes, scope));
    should(await holds(Buffer.from(`x ${ONE_LINE}\n`), ONE_LINE)).be.true();
    should(await holds(Buffer.from(`\0x ${ONE_LINE}\n`), ONE_LINE)).be.true();
    should(await holds(Buffer.concat([Buffer.from([0xff]), Buffer.from(ONE_LINE)]), ONE_LINE)).be.true();
    should(await holds(Buffer.from('nothing here\n'), ONE_LINE)).be.false();
  });
});
