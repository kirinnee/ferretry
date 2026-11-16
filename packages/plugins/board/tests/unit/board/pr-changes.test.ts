import { describe, it } from 'bun:test';
import should from 'should';
import { classifyPrFiles, isDocsOrTestsPath, PR_FILES_READ } from '../../../daemon/lib/board/index.ts';

/** What counts as "nothing a person could try" in a PR, and what does not (docs/agenda.md § Try it only when there is something to try). */
describe('isDocsOrTestsPath', () => {
  it('reads docs, design notes and Markdown as docs', () => {
    for (const path of [
      'docs/agenda.md',
      'docs/design/split-proposal.md',
      'docs/img/screenshot.png',
      'README.md',
      'packages/daemon/README.md',
      'CLAUDE.md',
      'notes/plan.MDX',
    ]) {
      should([path, isDocsOrTestsPath(path)]).eql([path, true]);
    }
  });

  it('reads tests, specs, harnesses and fixtures as tests, at any depth', () => {
    for (const path of [
      'packages/daemon/tests/unit/board/gate-items.test.ts',
      'packages/pwa/tests/unit/x.tsx',
      'tests/sit/run.sh',
      'packages/x/src/__tests__/a.ts',
      'packages/pwa/src/lib/gate-items.test.ts',
      'packages/pwa/src/lib/gate-items.spec.tsx',
      'packages/pwa/harness/agenda-parts-screenshot.ts',
      'packages/daemon/tests/fixtures/ledger.json',
    ]) {
      should([path, isDocsOrTestsPath(path)]).eql([path, true]);
    }
  });

  it('reads everything else as code, even a lookalike', () => {
    for (const path of [
      'packages/daemon/src/lib/board/gate-items.ts',
      'packages/pwa/src/features/agenda/agenda-item-card.tsx',
      'scripts/validate/relay-config.sh',
      '.github/workflows/cd.yaml',
      'package.json',
      'packages/pwa/src/docs/viewer.tsx',
      'packages/daemon/src/lib/tests-helper.ts',
      'packages/daemon/src/attest.ts',
      'src/contest/a.ts',
      // The session harness is shipped code, though its folder is called harness.
      'packages/daemon/src/lib/session/harness/runtime-switch.ts',
      'packages/daemon/src/adapters/session/harness/service.ts',
      'packages/cli/src/lib/harness/fast-mode.ts',
      'harness/run.ts',
    ]) {
      should([path, isDocsOrTestsPath(path)]).eql([path, false]);
    }
  });
});

describe('classifyPrFiles', () => {
  it('is docs-tests only when every changed file is a doc or a test', () => {
    should(classifyPrFiles(2, ['docs/a.md', 'packages/x/tests/a.test.ts'])).equal('docs-tests');
  });

  it('is code when any changed file is code', () => {
    should(classifyPrFiles(2, ['docs/a.md', 'packages/x/src/a.ts'])).equal('code');
  });

  it('is code when there are more files than were read, whatever the first ones are', () => {
    const paths = Array.from({ length: PR_FILES_READ }, (_, index) => `docs/${String(index)}.md`);
    should(classifyPrFiles(PR_FILES_READ, paths)).equal('docs-tests');
    should(classifyPrFiles(PR_FILES_READ + 1, paths)).equal('code');
  });

  it('is unknown, never a guess, when GitHub listed no files or fewer than it counted', () => {
    should(classifyPrFiles(0, [])).be.undefined();
    should(classifyPrFiles(3, [])).be.undefined();
    should(classifyPrFiles(3, ['docs/a.md', 'docs/b.md'])).be.undefined();
  });
});
