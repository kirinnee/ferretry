import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import { redactedDiffText } from '../../../../../daemon/lib/session/filesystem/index.ts';

/** FAKE fixture values only. Assertions are booleans so a failure never prints them. */
const ONE_LINE = 'fixture-one-line-secret-0002';
const FIRST = 'fixture-first-row-0003';
const SECOND = 'fixture-second-row-0004';
const MULTI = `${FIRST}\n${SECOND}`;

const project = async (diff: string): Promise<string> =>
  await new FakeRedaction(
    new Map([
      ['ONE' as never, ONE_LINE],
      ['MULTI' as never, MULTI],
    ]),
  ).read(scope => redactedDiffText(diff, scope));

describe('the outbound diff projection (R-0150)', () => {
  it('R-0150 masks a value on an added, a removed and a context line, and keeps every marker', async () => {
    const raw = `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n ctx ${ONE_LINE}\n-old ${ONE_LINE}\n+new ${ONE_LINE}\n`;
    const out = await project(raw);
    should(out.includes(ONE_LINE)).be.false();
    should(out).eql(
      'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n ctx [redacted:ONE]\n-old [redacted:ONE]\n+new [redacted:ONE]\n',
    );
  });

  it('R-0150 masks a value that spans lines, which a line-by-line mask would miss', async () => {
    const raw = `@@ -0,0 +1,2 @@\n+${FIRST}\n+${SECOND}\n`;
    const out = await project(raw);
    should(out.includes(FIRST)).be.false();
    should(out.includes(SECOND)).be.false();
    should(out.startsWith('@@ -0,0 +1,2 @@\n+[redacted:MULTI]')).be.true();
  });

  it('R-0150 masks a value carried by a hunk header', async () => {
    const out = await project(`@@ -1 +1 @@ function f(${ONE_LINE}) {\n x\n`);
    should(out.includes(ONE_LINE)).be.false();
  });

  it('R-0150 leaves a diff with nothing secret byte for byte as it was', async () => {
    const raw = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n';
    should((await project(raw)) === raw).be.true();
    should(await project('')).eql('');
  });

  it('R-0150 a body line that looks like a file header is still body, after the first hunk', async () => {
    const raw = `@@ -1 +1 @@\n--- ${ONE_LINE}\n+++ ${ONE_LINE}\n`;
    const out = await project(raw);
    should(out.includes(ONE_LINE)).be.false();
    should(out.startsWith('@@ -1 +1 @@\n--- [redacted:ONE]\n+++ [redacted:ONE]')).be.true();
  });
});
