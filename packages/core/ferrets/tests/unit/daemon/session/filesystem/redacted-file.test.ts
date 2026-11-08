import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import { redactedFileBase64 } from '../../../../../daemon/lib/session/filesystem/redacted-file.ts';

/** FAKE fixture values only. Assertions are booleans so a failure never prints them. */
const ONE_LINE = 'fixture-one-line-secret-0002';
const FIRST = 'fixture-first-row-0003';
const SECOND = 'fixture-second-row-0004';

const mask = async (bytes: Buffer, value: string): Promise<Buffer> =>
  Buffer.from(
    await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
      redactedFileBase64(bytes.toString('base64'), scope),
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
});
