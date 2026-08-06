import { describe, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import should from 'should';

/**
 * THE GATE PROVED ON A PLANTED VIOLATION, which is the only thing that
 * distinguishes a contract from a comment.
 *
 * `docs/standards/contracts/README.md` is explicit: "verify it FIRES on a
 * deliberately planted violation, not merely that it passes on a clean tree — a
 * gate that never fails is indistinguishable from one that does nothing." A
 * clean-tree run exercises neither the match nor the allowlist, so it cannot
 * tell a working filter from a broken one, and `no-fy-render-in-docs.sh` shipped
 * with no such proof.
 *
 * IT RUNS THE REAL SCRIPT, NEVER A COPY OF ITS RULES. A test that reimplemented
 * the pattern would prove only that two regexes agree.
 *
 * IT CANNOT REACH THIS REPOSITORY. The script begins with
 * `git rev-parse --show-toplevel` and `cd`s to the answer, so running it with
 * `cwd` inside a throwaway repository scopes every `git grep` to that repository.
 * Nothing here writes to, stages in, or reads from the real worktree.
 *
 * The cases mirror the renderer's real activation grammar. remark produces the
 * same node for three or more backticks, three or more tildes, and any of those
 * nested in a blockquote or list item, so all of them render — and a gate that
 * missed one would wave a renderable opener into a durable file.
 */

const scriptPath = resolve(import.meta.dir, '../../../../scripts/validate/no-fy-render-in-docs.sh');
/** Assembled, never typed: this file is tracked, and the gate scans tracked files. */
const BACKTICK = String.fromCharCode(96);
const FENCE = BACKTICK.repeat(3);
const LONG_FENCE = BACKTICK.repeat(4);
const TILDE = '~'.repeat(3);

const opener = (fence: string): string => `${fence}fy-render\ntype: svg\nalt: A square\n---\n<svg/>\n${fence}\n`;

interface GateRun {
  readonly code: number;
  readonly output: string;
}

/** Build a throwaway repository, stage the files, and run the real gate in it. */
function runGate(files: Readonly<Record<string, string>>): GateRun {
  const repository = mkdtempSync(join(tmpdir(), 'fy-render-gate-'));
  for (const command of [
    ['git', 'init', '-q'],
    ['git', 'config', 'user.email', 'gate@example.test'],
    ['git', 'config', 'user.name', 'gate'],
  ]) {
    Bun.spawnSync(command, { cwd: repository });
  }
  for (const [path, body] of Object.entries(files)) {
    const full = join(repository, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  // Tracked, because the gate deliberately scans what a commit would contain.
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repository });
  const result = Bun.spawnSync(['bash', scriptPath], { cwd: repository });
  return {
    code: result.exitCode,
    output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
  };
}

describe('no-fy-render-in-docs gate', () => {
  test('should exist as the executable the pre-commit hook names', () => {
    should(readFileSync(scriptPath, 'utf8')).containEql('fy-render fence openers');
  });

  test('should pass a tree that contains no opener', () => {
    // Act
    const run = runGate({ 'docs/notes.md': '# ordinary documentation\n' });

    // Assert
    should(run.code).equal(0);
    should(run.output).containEql('no fy-render fence openers');
  });

  test('should fire on every delimiter form the renderer accepts', () => {
    for (const [name, fence] of [
      ['three backticks', FENCE],
      ['four backticks', LONG_FENCE],
      ['three tildes', TILDE],
    ] as const) {
      // Act
      const run = runGate({ 'docs/handover.md': opener(fence) });

      // Assert — the failure must name the file, or it cannot be acted on.
      should(run.code).equal(1);
      should(run.output).containEql('docs/handover.md');
      should(name).be.a.String();
    }
  });

  test('should fire on an opener nested in a blockquote or a list item', () => {
    // Arrange — the delimiter is not at column zero in either, which is the
    // shape a line-anchored pattern would miss.
    const quoted = `> ${FENCE}fy-render\n> type: svg\n> ${FENCE}\n`;
    const listed = `- an illustration:\n\n  ${FENCE}fy-render\n  type: svg\n  ${FENCE}\n`;

    // Assert
    should(runGate({ 'docs/quoted.md': quoted }).code).equal(1);
    should(runGate({ 'docs/listed.md': listed }).code).equal(1);
  });

  test('should fire wherever the opener is, not only in documentation', () => {
    should(runGate({ 'packages/pwa/src/thing.ts': `// ${FENCE}fy-render\n` }).code).equal(1);
    should(runGate({ 'README.md': opener(FENCE) }).code).equal(1);
  });

  test('should allow the two files whose job is to teach the syntax', () => {
    // Act
    const run = runGate({
      'docs/fy-render.md': opener(FENCE),
      '.claude/skills/fy-render-authoring/SKILL.md': opener(FENCE),
    });

    // Assert
    should(run.code).equal(0);
  });

  test('should not fire on a fence that is a different language', () => {
    // Arrange — both of these render as ordinary fences, so reporting them would
    // make the gate disagree with the product it is protecting.
    const near = {
      'docs/a.md': `${FENCE}fy-render-notes\nnot this one\n${FENCE}\n`,
      'docs/b.md': `${FENCE}fy-render notes\nnor this one\n${FENCE}\n`,
    };

    // Assert
    should(runGate(near).code).equal(0);
  });

  /**
   * FILENAMES ARE NOT COLON-DELIMITED RECORDS.
   *
   * The gate used to read `git grep -n` output and take the path as everything
   * before the first colon, so a tracked `docs/fy-render.md:evil` produced
   * `docs/fy-render.md:evil:1:…`, split to exactly `docs/fy-render.md`, and was
   * waved through as the allowlisted contract document. Git permits both a colon
   * and a newline in a filename, so both shapes are exercised here.
   */
  test('should not mistake a colon-bearing neighbour for the allowlisted file', () => {
    // Act
    const run = runGate({ 'docs/fy-render.md:evil': opener(FENCE) });

    // Assert — the comparison is over the WHOLE filename.
    should(run.code).equal(1);
    should(run.output).containEql('evil');
  });

  test('should not mistake a newline-bearing neighbour for the allowlisted file', () => {
    // Arrange — a path whose first line is exactly the allowlisted one. A
    // line-oriented read of the match list sees the allowlisted name and stops.
    const hostile = 'docs/fy-render.md\nevil.md';

    // Act
    const run = runGate({ [hostile]: opener(FENCE) });

    // Assert
    should(run.code).equal(1);
  });

  test('should still allow the two exact paths beside their hostile neighbours', () => {
    // Arrange — the real files and the impostors in one tree, so the test cannot
    // pass by refusing everything.
    const mixed = runGate({
      'docs/fy-render.md': opener(FENCE),
      '.claude/skills/fy-render-authoring/SKILL.md': opener(FENCE),
      'docs/fy-render.md:evil': opener(FENCE),
    });
    const cleanPair = runGate({
      'docs/fy-render.md': opener(FENCE),
      '.claude/skills/fy-render-authoring/SKILL.md': opener(FENCE),
    });

    // Assert — read the VIOLATION REPORT, which is the output up to the first
    // blank line. Every violation also prints standing guidance that names both
    // teaching files on purpose, so a substring test against the whole output
    // can never show that only the impostor was reported; and indentation cannot
    // separate them either, because the guidance bullets are indented too and
    // both contain "fy-render".
    should(cleanPair.code).equal(0);
    should(mixed.code).equal(1);
    const report = mixed.output.split('\n\n')[0] ?? '';
    should(report).containEql('evil');
    should(report).not.containEql('SKILL.md');
  });

  test('should count a newline-bearing filename once in its clean report', () => {
    // Arrange — a clean tree holding one ordinary file and one whose name spans
    // two lines. A line-based count reports three files for these two.
    const run = runGate({ 'docs/notes.md': '# ordinary\n', 'docs/two\nlines.md': '# also ordinary\n' });

    // Assert — the matcher is NUL-safe, so the tally it prints must be too, or
    // the gate's own summary contradicts the class of path it now supports.
    should(run.code).equal(0);
    should(run.output).containEql('2 tracked files searched');
  });

  test('should ignore a file nobody is committing', () => {
    // Arrange — an untracked scratch file must not fail somebody else's commit.
    const repository = mkdtempSync(join(tmpdir(), 'fy-render-gate-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repository });
    writeFileSync(join(repository, 'scratch.md'), opener(FENCE));

    // Act
    const result = Bun.spawnSync(['bash', scriptPath], { cwd: repository });

    // Assert
    should(result.exitCode).equal(0);
  });
});
