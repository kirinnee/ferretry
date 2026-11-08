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
    const stars = '*'.repeat(ONE_LINE.length);
    should(out).eql(
      `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n ctx ${stars}\n-old ${stars}\n+new ${stars}\n`,
    );
  });

  it('R-0150 masks a value that spans lines, which a line-by-line mask would miss', async () => {
    const raw = `@@ -0,0 +1,2 @@\n+${FIRST}\n+${SECOND}\n`;
    const out = await project(raw);
    should(out.includes(FIRST)).be.false();
    should(out.includes(SECOND)).be.false();
    should(out.split('\n').length === raw.split('\n').length).be.true();
    should(out.startsWith(`@@ -0,0 +1,2 @@\n+${'*'.repeat(FIRST.length)}\n+${'*'.repeat(SECOND.length)}`)).be.true();
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
    should(
      out.startsWith(`@@ -1 +1 @@\n--- ${'*'.repeat(ONE_LINE.length)}\n+++ ${'*'.repeat(ONE_LINE.length)}`),
    ).be.true();
  });

  const BEGIN = 'fixture-begin-line-0005';
  const END = 'fixture-end-line-0006';
  const BODY = 'fixture-body-line-0007';
  const KEY = `${BEGIN}\n${BODY}\n${END}`;
  const projectKey = async (diff: string): Promise<string> =>
    await new FakeRedaction(new Map([['KEY' as never, KEY]])).read(scope => redactedDiffText(diff, scope));

  it('R-0150 a multi-line value whose first and last lines are unchanged context is masked whole', async () => {
    const raw = `@@ -1,3 +1,3 @@\n ${BEGIN}\n-old-body\n+${BODY}\n ${END}\n`;
    const out = await projectKey(raw);
    should(out.includes(BODY)).be.false();
    should(out.includes(BEGIN)).be.false();
    should(out.includes(END)).be.false();
    should(out.split('\n').length === raw.split('\n').length).be.true();
  });

  it('R-0150 the removed side mirror: context ends around removed body lines are masked whole', async () => {
    const raw = `@@ -1,3 +1,3 @@\n ${BEGIN}\n-${BODY}\n+new-body\n ${END}\n`;
    const out = await projectKey(raw);
    should(out.includes(BODY)).be.false();
    should(out.includes(BEGIN)).be.false();
    should(out.includes(END)).be.false();
  });

  it('R-0150 a blank context line (suppressBlankEmpty) does not break a run', async () => {
    const key = `${BEGIN}\n\n${END}`;
    const raw = `@@ -1,3 +1,3 @@\n ${BEGIN}\n\n ${END}\n`;
    const out = await new FakeRedaction(new Map([['KEY' as never, key]])).read(scope => redactedDiffText(raw, scope));
    should(out.includes(BEGIN)).be.false();
    should(out.includes(END)).be.false();
    should(out.split('\n').length === raw.split('\n').length).be.true();
  });

  it('R-0150 masking never collapses lines: one mask per original line', async () => {
    const raw = `@@ -0,0 +1,3 @@\n+${BEGIN}\n+${BODY}\n+${END}\n`;
    const out = await projectKey(raw);
    should(out.split('\n').length === raw.split('\n').length).be.true();
    should(out.includes('redacted')).be.false();
  });

  it('R-0150 a "\\ No newline at end of file" line does not split a multi-line value (old side lacked the newline)', async () => {
    const raw = `@@ -1,2 +1,3 @@\n ${BEGIN}\n-${BODY}\n\\ No newline at end of file\n+${BODY}\n+${END}\n`;
    const out = await projectKey(raw);
    should(out.includes(BEGIN)).be.false();
    should(out.includes(`+${BODY}`)).be.false(); // the old side alone shows only part of the value
    should(out.includes(END)).be.false();
    should(out.includes('\\ No newline at end of file')).be.true();
    should(out.split('\n').length === raw.split('\n').length).be.true();
  });

  it('R-0150 a "\\ No newline at end of file" line after a value that ends the old file masks the added last line', async () => {
    const raw = `@@ -1,3 +1,4 @@\n-${BEGIN}\n-${BODY}\n-${END}\n\\ No newline at end of file\n+${BEGIN}\n+${BODY}\n+${END}\n+tail\n`;
    const out = await projectKey(raw);
    should(out.includes(BEGIN)).be.false();
    should(out.includes(BODY)).be.false();
    should(out.includes(END)).be.false();
    should(out.includes('+tail')).be.true();
  });

  it('R-0150 header lines are masked with the same stars as the body, never a name', async () => {
    const out = await project(`diff --git a/${ONE_LINE} b/${ONE_LINE}\n--- a/${ONE_LINE}\n+++ b/${ONE_LINE}\n`);
    should(out.includes(ONE_LINE)).be.false();
    should(out.includes('redacted')).be.false();
    should(out.includes('*'.repeat(ONE_LINE.length))).be.true();
  });
});
