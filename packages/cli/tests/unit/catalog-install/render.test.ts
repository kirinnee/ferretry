import { describe, it } from 'bun:test';
import should from 'should';
import { renderInstalls, renderPreview } from '../../../src/lib/catalog-install/render.ts';
import { installOf, previewOf } from './support.ts';

describe('catalog install rendering', () => {
  it('should say a first install pins the publisher, and show every part of an item', () => {
    const text = renderPreview(
      previewOf({
        publisher: { ...previewOf().publisher, firstSeen: true },
        secrets: [{ placeholder: 'TOKEN', held: false }],
      }),
    );
    should(text).containEql('first time you install from them');
    should(text).containEql('Secrets it asks for:\n  TOKEN');
    should(text).not.containEql('Warnings:');
    should(text).not.containEql('Replaces');
  });

  it('should name a link as the source, since a link has no catalog', () => {
    const { catalogId: _id, catalogName: _name, ...shared } = previewOf().provenance as Record<string, unknown>;
    const provenance = { ...shared, link: { linkId: `lnk_${'l'.repeat(22)}`, kind: 'public', sequence: 1 } } as never;
    should(renderPreview(previewOf({ provenance }))).containEql('version 2) from a shared link');
    should(renderInstalls([{ ...installOf(), provenance }])).containEql('from a shared link by kirin-box');
  });

  it('should list no installs plainly', () => {
    should(renderInstalls([])).equal('No catalog items are installed.');
    should(renderInstalls([installOf()])).not.containEql('secrets:');
  });
});
