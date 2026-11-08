import { describe, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import { redactedDiff, redactedDiffText } from '../../../../../daemon/lib/session/filesystem/index.ts';

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
    should(
      out === `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n ctx ${stars}\n-old ${stars}\n+new ${stars}\n`,
    ).be.true();
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

  it('R-0150 astral characters before a value do not shift the diff mask (+ line and context line)', async () => {
    for (const count of [1, 5, 30]) {
      const lead = '😀'.repeat(count);
      for (const marker of ['+', ' ']) {
        const raw = `@@ -1 +1 @@\n${marker}${lead}${ONE_LINE}\n`;
        const out = await project(raw);
        should(out.includes(ONE_LINE)).be.false();
        should(out.includes(ONE_LINE.slice(0, 4))).be.false();
        should(out === `@@ -1 +1 @@\n${marker}${lead}${'*'.repeat(ONE_LINE.length)}\n`).be.true();
      }
    }
  });

  it('R-0150 coverage is reported by the scope, even when 30 astral characters precede the value', async () => {
    const raw = `@@ -1 +1 @@\n+${'😀'.repeat(30)}${ONE_LINE}\n`;
    const covered = await new FakeRedaction(new Map([['ONE' as never, ONE_LINE]])).read(
      scope => redactedDiff(raw, scope).covered,
    );
    const clean = await new FakeRedaction(new Map([['ONE' as never, ONE_LINE]])).read(
      scope => redactedDiff('@@ -1 +1 @@\n+nothing here\n', scope).covered,
    );
    should(covered).be.true();
    should(clean).be.false();
  });

  it('R-0150 the old side partial copy of a value takes the mask of the same line on the new side', async () => {
    const THIRD = 'fixture-third-row-0005';
    // old file: FIRST, SECOND (no EOL); new file: FIRST, SECOND, THIRD. The value is all three lines.
    const raw = `@@ -1,2 +1,3 @@\n ${FIRST}\n-${SECOND}\n\\ No newline at end of file\n+${SECOND}\n+${THIRD}\n`;
    const out = await new FakeRedaction(new Map([['V' as never, `${FIRST}\n${SECOND}\n${THIRD}`]])).read(scope =>
      redactedDiffText(raw, scope),
    );
    should(out.includes(FIRST)).be.false();
    should(out.includes(SECOND)).be.false();
    should(out.includes(THIRD)).be.false();
  });

  it('R-0150 a multi-line value in a CRLF diff is masked and the CR is kept', async () => {
    const raw = `@@ -0,0 +1,2 @@\n+${FIRST}\r\n+${SECOND}\r\n`;
    const out = await project(raw);
    should(out.includes(FIRST)).be.false();
    should(out.includes(SECOND)).be.false();
    should(out === `@@ -0,0 +1,2 @@\n+${'*'.repeat(FIRST.length)}\r\n+${'*'.repeat(SECOND.length)}\r\n`).be.true();
  });

  // The four stored/served combinations of a multi-line value and a CRLF or LF diff: all masked, all reported covered.
  const LINES = ['fixture-crlf-first-0006', 'fixture-crlf-second-0007', 'fixture-crlf-third-0008'];
  for (const stored of ['\n', '\r\n']) {
    for (const served of ['\n', '\r\n']) {
      it(`R-0150 a value stored with ${JSON.stringify(stored)} is masked and reported in a diff with ${JSON.stringify(served)} line ends`, async () => {
        const value = LINES.join(stored);
        const raw = `@@ -0,0 +1,3 @@\n${LINES.map(line => `+${line}${served}`).join('')}`;
        const { text, covered } = await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
          redactedDiff(raw, scope),
        );
        should(LINES.some(line => text.includes(line))).be.false();
        should(covered).be.true();
        should(text.split('\n').length === raw.split('\n').length).be.true();
      });
    }
  }

  it('R-0150 a one-line value stored with a trailing CR is masked in a CRLF diff and reported', async () => {
    const raw = `@@ -0,0 +1,1 @@\n+KEY=${ONE_LINE}\r\n`;
    const { text, covered } = await new FakeRedaction(new Map([['V' as never, `${ONE_LINE}\r`]])).read(scope =>
      redactedDiff(raw, scope),
    );
    should(text.includes(ONE_LINE)).be.false();
    should(covered).be.true();
  });
});

/**
 * Git prints the nearest line BEFORE a hunk that starts with a letter, `$` or `_` after the closing `@@` (the section
 * heading). When a change follows a value, that heading is the value's first line and the hunk's leading context is
 * the rest, so the value is split across the header and the body. These build that exact shape (FAKE values only).
 */
const HEAD_LINES = ['fixture-heading-a-0010', 'fixture-heading-b-0011', 'fixture-heading-c-0012'];

interface Shape {
  readonly lines: readonly string[];
  readonly eol: string;
  readonly blankEmpty: boolean;
}

/** The diff git prints for appending `c=3` to the file `lines` (3 lines of context, default funcname). */
function appendedDiff({ lines, eol, blankEmpty }: Shape): string {
  const start = Math.max(0, lines.length - 3);
  const heading = lines
    .slice(0, start)
    .findLast(line => /^[A-Za-z$_]/.test(line))
    ?.replace(/\s+$/, '');
  const context = lines.slice(start).map(line => {
    const text = `${line}${eol}`;
    return blankEmpty && line === '' && eol === '\n' ? '\n' : ` ${text}`;
  });
  const header = `@@ -${start + 1},${lines.length - start} +${start + 1},${lines.length - start + 1} @@${heading === undefined ? '' : ` ${heading}`}`;
  return `diff --git a/f b/f\n--- a/f\n+++ b/f\n${header}\n${context.join('')}+c=3${eol}`;
}

describe('a hunk header section heading is part of the old and the new side (R-0151)', () => {
  const stores = [
    { name: 'LF', joiner: '\n' },
    { name: 'CRLF', joiner: '\r\n' },
  ] as const;
  for (const { name, joiner } of stores) {
    for (const eol of ['\n', '\r\n']) {
      for (const blankEmpty of [false, true]) {
        for (const before of [[], ['a=1']]) {
          const label = `a 3-line ${name}-stored value, ${JSON.stringify(eol)} file, ${before.length === 0 ? 'on the first line' : 'mid-file'}${blankEmpty ? ', suppressBlankEmpty' : ''}`;
          it(`R-0151 ${label}: split between the heading and the leading context, it is masked and reported`, async () => {
            const value = HEAD_LINES.join(joiner);
            const lines = [...before, `KEY=${HEAD_LINES[0]}`, HEAD_LINES[1] ?? '', HEAD_LINES[2] ?? '', 'b=2'];
            const raw = appendedDiff({ lines, eol, blankEmpty });
            should(raw.split('\n')[3]?.includes(`@@ KEY=${HEAD_LINES[0]}`)).be.true();
            const { text, covered } = await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
              redactedDiff(raw, scope),
            );
            should(HEAD_LINES.some(line => text.includes(line))).be.false();
            should(covered).be.true();
            should(text.split('\n').length === raw.split('\n').length).be.true();
            should(text.split('\n')[3]?.startsWith('@@ -')).be.true();
          });
        }
      }
    }
  }

  it('R-0151 a value with a blank middle line, split between the heading and the context, is masked under suppressBlankEmpty', async () => {
    const value = `${HEAD_LINES[0]}\n\n${HEAD_LINES[2]}`;
    const lines = ['a=1', `KEY=${HEAD_LINES[0]}`, '', HEAD_LINES[2] ?? '', 'b=2'];
    const raw = appendedDiff({ lines, eol: '\n', blankEmpty: true });
    const { text, covered } = await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
      redactedDiff(raw, scope),
    );
    should(HEAD_LINES.some(line => text.includes(line))).be.false();
    should(covered).be.true();
  });

  it('R-0151 the masked heading keeps its length and the rest of the header byte for byte', async () => {
    const lines = ['a=1', `KEY=${HEAD_LINES[0]}`, HEAD_LINES[1] ?? '', HEAD_LINES[2] ?? '', 'b=2'];
    const raw = appendedDiff({ lines, eol: '\n', blankEmpty: false });
    const out = await new FakeRedaction(new Map([['V' as never, HEAD_LINES.join('\n')]])).read(
      scope => redactedDiff(raw, scope).text,
    );
    const was = raw.split('\n')[3] ?? '';
    const now = out.split('\n')[3] ?? '';
    should(now.length === was.length).be.true();
    should(now === `@@ -3,3 +3,4 @@ KEY=${'*'.repeat(HEAD_LINES[0]?.length ?? 0)}`).be.true();
  });

  it('R-0151 a 2-line value held whole in the context is masked and reported (control)', async () => {
    const value = `${HEAD_LINES[0]}\n${HEAD_LINES[1]}`;
    const lines = ['a=1', `KEY=${HEAD_LINES[0]}`, HEAD_LINES[1] ?? '', 'b=2'];
    const raw = appendedDiff({ lines, eol: '\n', blankEmpty: false });
    const { text, covered } = await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
      redactedDiff(raw, scope),
    );
    should(HEAD_LINES.slice(0, 2).some(line => text.includes(line))).be.false();
    should(covered).be.true();
  });

  it('R-0151 a value split with a digit-start line (git skips it as a heading) is the declared partial: nothing is claimed (control)', async () => {
    const digit = `9${HEAD_LINES[1]}`;
    const value = [HEAD_LINES[0], digit, HEAD_LINES[2], 'tail-line-0013'].join('\n');
    const lines = ['a=1', `KEY=${HEAD_LINES[0]}`, digit, HEAD_LINES[2] ?? '', 'tail-line-0013', 'b=2'];
    const raw = appendedDiff({ lines, eol: '\n', blankEmpty: false });
    const { covered } = await new FakeRedaction(new Map([['V' as never, value]])).read(scope =>
      redactedDiff(raw, scope),
    );
    should(covered).be.false();
  });

  it('R-0151 a heading that is not part of a value stays byte for byte', async () => {
    const raw = `@@ -3,3 +3,4 @@ function plain() {\n ${HEAD_LINES[1]}\n-old\n+${ONE_LINE}\n`;
    const out = await project(raw);
    should(out.includes(ONE_LINE)).be.false();
    should(out.split('\n')[0] === '@@ -3,3 +3,4 @@ function plain() {').be.true();
  });

  it('R-0151 a heading with no body after it is masked on its own', async () => {
    const out = await project(`@@ -1 +1 @@ ${ONE_LINE}\n`);
    should(out.includes(ONE_LINE)).be.false();
  });

  it('R-0151 the shape real `git diff --no-index` prints is masked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdr-heading-'));
    try {
      for (const eol of ['\n', '\r\n']) {
        const base = ['a=1', `KEY=${HEAD_LINES[0]}`, HEAD_LINES[1], HEAD_LINES[2], 'b=2']
          .map(l => `${l}${eol}`)
          .join('');
        writeFileSync(join(dir, 'a'), base);
        writeFileSync(join(dir, 'b'), `${base}c=3${eol}`);
        const run = Bun.spawnSync(['git', 'diff', '--no-index', 'a', 'b'], { cwd: dir });
        const raw = run.stdout.toString();
        should(raw.includes(`@@ KEY=${HEAD_LINES[0]}\n`)).be.true();
        for (const joiner of ['\n', '\r\n']) {
          const { text, covered } = await new FakeRedaction(new Map([['V' as never, HEAD_LINES.join(joiner)]])).read(
            scope => redactedDiff(raw, scope),
          );
          should(HEAD_LINES.some(line => text.includes(line))).be.false();
          should(covered).be.true();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
