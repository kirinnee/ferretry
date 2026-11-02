import { describe, it } from 'bun:test';
import should from 'should';
import { renderInstalls, renderPreview } from '../../../src/lib/local-skill-install/render.ts';
import { installOf, INSTALL_ID, previewOf } from './support.ts';

describe('local skill rendering', () => {
  it('should show where it came from, every file, and nothing optional when there is none', () => {
    const text = renderPreview(previewOf());

    should(text).containEql('pdf-tools copied from account claude-work (claude)');
    should(text).containEql('Skill file SKILL.md:\n    | line one\n    | line two');
    should(text).containEql('Starts: acme');
    should(text).not.containEql('Warnings:');
    should(text).not.containEql('Not copied');
    should(text).not.containEql('Replaces');
  });

  it('should list warnings, what was not copied, and the copy it replaces', () => {
    const text = renderPreview(
      previewOf({
        warnings: [{ code: 'hidden-characters', text: 'hidden characters' }],
        skipped: [{ subject: '.env', reason: 'a credential file' }],
        replaces: { installId: INSTALL_ID },
        origin: {
          kind: 'project',
          owner: '/work/other',
          harness: 'codex',
          path: '/work/other/.agents/skills/x/SKILL.md',
        },
      }),
    );

    should(text).containEql('Warnings:\n  ! hidden characters');
    should(text).containEql('Not copied:\n  .env: a credential file');
    should(text).containEql(`Replaces the copy you made there (${INSTALL_ID})`);
    should(text).containEql('project /work/other (codex)');
  });

  it('should list no copies plainly, and each copy with its file count', () => {
    should(renderInstalls([])).equal('No skills were copied from this machine.');
    should(renderInstalls([installOf()])).containEql('(1 files)');
  });
});
