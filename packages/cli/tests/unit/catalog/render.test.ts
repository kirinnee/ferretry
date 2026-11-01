import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderCatalogCreated,
  renderCatalogDeleted,
  renderCatalogList,
  renderCatalogUpdated,
  renderChanges,
  renderExported,
  renderPreview,
  renderPublished,
  renderSigning,
  renderVersions,
  renderWithdrawn,
} from '../../../src/lib/catalog/render';
import {
  AT,
  CATALOG_ID,
  catalog,
  catalogList,
  mcpItem,
  preview,
  published,
  SKILL_ID,
  sharedItem,
  skillItem,
  withdrawn,
} from './fixtures';

describe('rendering the catalog list', () => {
  it('should say how to start when there are no catalogs', () => {
    should(renderCatalogList(catalogList([]))).equal('No catalogs yet. Make one with: fy catalog create <name>');
  });

  it('should list each catalog with its revision, item count, visibility and items', () => {
    const text = renderCatalogList(catalogList());
    should(text).containEql(`Team tools (${CATALOG_ID}) · revision 3 · 2 items · members`);
    should(text).containEql(`skill pdf-tools v1 (${SKILL_ID})`);
    should(text).containEql('GitHub issues');
  });

  it('should say 1 item, show the description, and not count a withdrawn item', () => {
    const text = renderCatalogList(
      catalogList([
        catalog({
          description: 'for the team',
          items: [skillItem(), mcpItem({ withdrawnAt: AT, sourceState: 'withdrawn' })],
        }),
      ]),
    );
    should(text).containEql('· 1 item ·');
    should(text).containEql('  for the team');
    should(text).containEql(`withdrawn ${AT}`);
  });

  it('should mark an item whose source changed, and one whose source is gone', () => {
    const text = renderCatalogList(
      catalogList([
        catalog({
          items: [
            skillItem({ sourceState: 'changed' }),
            mcpItem({ sourceState: 'unavailable', sourceNote: 'no server called github' }),
            skillItem({ itemId: `itm_${'x'.repeat(22)}`, name: 'bare', sourceState: 'unavailable' }),
          ],
        }),
      ]),
    );
    should(text).containEql('source changed since this version — publish to update');
    should(text).containEql('source unavailable: no server called github');
    should(text).match(/bare v1 .*source unavailable$/mu);
  });

  it('should leave the version off an item with no versions to name', () => {
    const bare = { ...skillItem(), versions: [] } as unknown as ReturnType<typeof skillItem>;
    should(renderCatalogList(catalogList([catalog({ items: [bare] })]))).containEql('skill pdf-tools (');
  });

  it('should say nothing about the source when the daemon was not asked', () => {
    const { sourceState: _unused, ...unchecked } = skillItem();
    const text = renderCatalogList(catalogList([catalog({ items: [unchecked] })]));
    should(text).not.containEql('source');
  });

  it('should say a withdrawn item with no instant', () => {
    should(renderCatalogList(catalogList([catalog({ items: [skillItem({ sourceState: 'withdrawn' })] })]))).containEql(
      ' · withdrawn\n',
    );
  });
});

describe('rendering results', () => {
  it('should say what was created, updated, deleted, published, withdrawn and exported', () => {
    should(renderCatalogCreated(catalog())).equal(`Created catalog Team tools (${CATALOG_ID}).`);
    should(renderCatalogUpdated(catalog())).equal(`Catalog Team tools (${CATALOG_ID}) is now at revision 3.`);
    should(renderCatalogDeleted('Team tools', CATALOG_ID)).equal(`Deleted catalog Team tools (${CATALOG_ID}).`);
    should(renderPublished(published())).equal(`Published pdf-tools version 1 (${SKILL_ID}); catalog revision 4.`);
    should(renderWithdrawn(withdrawn(), 'pdf-tools')).equal(`Withdrew pdf-tools (${SKILL_ID}); catalog revision 5.`);
    should(renderExported('Team tools', 1, '/w/a.json')).equal('Exported Team tools (1 item) to /w/a.json.');
    should(renderExported('Team tools', 2, '/w/a.json')).containEql('2 items');
  });
});

describe('rendering what an export signs', () => {
  it('should name the catalog, its publisher name, and one line per item', () => {
    const text = renderSigning(catalog(), ['a v1 sha256:x', 'b v2 sha256:y']);
    should(text).startWith(`This will sign Team tools (${CATALOG_ID}) at revision 3, published as laptop:`);
    should(text).containEql('\n  a v1 sha256:x\n  b v2 sha256:y');
    should(renderSigning(catalog(), [])).endWith('  no items');
  });
});

describe('rendering a preview', () => {
  it('should show every entry in full, documents as indented blocks, then the digest', () => {
    const text = renderPreview(preview());
    should(text).containEql('skill pdf-tools · version 1 · 120 bytes');
    should(text).containEql('Summary: Split, merge and OCR PDFs');
    should(text).containEql('Read from: /home/u/.claude/skills/pdf-tools/SKILL.md');
    should(text).containEql('  Skill file SKILL.md:\n    # pdf\n    line two\n\n    line four');
    should(text).containEql('  Starts: npx -y thing');
    should(text).endWith(`Digest: sha256:${'1'.repeat(64)}`);
    should(text).not.containEql('Warnings:');
    should(text).not.containEql('Left out');
  });

  it('should list warnings and what was left out with its reason', () => {
    const text = renderPreview(
      preview({
        warnings: [{ code: 'carries-scripts', text: 'This skill carries scripts.' }],
        problems: [{ subject: 'logo.png', reason: 'not text' }],
      }),
    );
    should(text).containEql('Warnings:\n  - This skill carries scripts.');
    should(text).containEql('Left out of the frozen copy:\n  - logo.png: not text');
  });
});

describe('rendering what changed', () => {
  const base = { entries: [], unchanged: 0, newWarnings: [], goneWarnings: [] };

  it('should say plainly when a reader would see nothing differently', () => {
    should(renderChanges(base)).equal(
      'What changed since the version installers get now:\n  nothing a reader would see differently',
    );
  });

  it('should show a one-line entry before and after, with its flag', () => {
    const text = renderChanges({
      ...base,
      unchanged: 2,
      entries: [
        { label: 'Starts', change: 'changed', document: false, before: 'npx a', after: 'npx b', flag: 'command' },
        { label: 'Reaches', change: 'added', document: false, after: 'https://x' },
        { label: 'Environment K', change: 'removed', document: false, before: 'old' },
      ],
    });
    should(text).containEql('  ~ Starts [command]\n    was: npx a\n    now: npx b');
    should(text).containEql('  + Reaches\n    now: https://x');
    should(text).containEql('  - Environment K\n    was: old');
    should(text).containEql('  2 parts the same');
  });

  it('should show hunks, whole added and removed files, and a file too large for a diff', () => {
    const text = renderChanges({
      ...base,
      unchanged: 1,
      entries: [
        {
          label: 'Skill file SKILL.md',
          change: 'changed',
          document: true,
          hunks: [
            {
              beforeStart: 2,
              beforeLines: 2,
              afterStart: 2,
              afterLines: 2,
              lines: [
                { kind: 'context', text: 'same' },
                { kind: 'remove', text: 'old' },
                { kind: 'add', text: 'new' },
              ],
            },
          ],
        },
        { label: 'Skill file a.sh', change: 'added', document: true, after: 'echo hi\nexit', flag: 'script' },
        { label: 'Skill file b.txt', change: 'removed', document: true, before: 'gone' },
        { label: 'Skill file c.txt', change: 'changed', document: true, tooLarge: true },
        { label: 'Skill file d.txt', change: 'changed', document: true },
      ],
      newWarnings: [{ code: 'carries-scripts', text: 'This skill carries scripts.' }],
      goneWarnings: [{ code: 'carries-scripts', text: 'Old one.' }],
      truncated: true,
    });
    should(text).containEql('    @@ -2,2 +2,2 @@\n      same\n    - old\n    + new');
    should(text).containEql('  + Skill file a.sh [script]\n    echo hi\n    exit');
    should(text).containEql('  - Skill file b.txt\n    gone');
    should(text).containEql('too large to show line by line');
    should(text).containEql('  ~ Skill file d.txt');
    should(text).containEql('  1 part the same');
    should(text).containEql('new warning: This skill carries scripts.');
    should(text).containEql('no longer warned: Old one.');
    should(text).containEql('cut short');
  });

  it('should come before the full review in a preview', () => {
    const text = renderPreview(preview({ changes: base }));
    should(text.indexOf('What changed')).be.above(-1);
    should(text.indexOf('What changed')).be.below(text.indexOf('What an installer would get'));
  });
});

describe('rendering the versions of an item', () => {
  it('should mark the current one and a retired one, oldest first', () => {
    const text = renderVersions(
      sharedItem({
        current: 2,
        versions: [
          { version: 1, size: 10, publishedAt: AT, summary: 'first', retiredAt: AT, usedBy: { catalogIds: [] } },
          { version: 2, size: 20, publishedAt: AT, summary: 'second', usedBy: { catalogIds: [] } },
          { version: 3, size: 30, publishedAt: AT, summary: 'third', usedBy: { catalogIds: [] } },
        ],
      }),
    );
    should(text).startWith('pdf-tools (' + SKILL_ID + ') · 3 versions');
    should(text).containEql('v1 · ' + AT + ' · 10 bytes · retired ' + AT + '\n    first');
    should(text).containEql('v2 · ' + AT + ' · 20 bytes · current\n    second');
    should(text).containEql('v3 · ' + AT + ' · 30 bytes\n    third');
  });
});
