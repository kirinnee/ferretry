import { describe, it } from 'bun:test';
import should from 'should';
import { openingAttachmentsSource } from '../../../daemon/attachments/adapters/opening-attachments.ts';
import { MAX_INITIAL_ATTACHMENTS } from '../../../daemon/attachments/lib/index.ts';
import { docxBytes } from '../../support/docx.ts';

/**
 * What Conversation answers Ferrets when a start carries files (`fy start -f`, V-0443): the plan for the opening message.
 * Pure: nothing is written; the paths are the folder Ferrets names.
 */

const DIRECTORY = '/state/ferrets/sessions/f1/attachments';
const base64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString('base64');

describe('V-0443 the opening attachments Conversation plans for a start', () => {
  it('V-0443 should plan an image and a document, with the document’s text extracted beside it and every file named by absolute path in the section', () => {
    const source = openingAttachmentsSource();
    const planned = source.plan({
      directory: DIRECTORY,
      attachments: [
        { filename: 'shot.png', mime: 'image/png', base64: base64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff])) },
        { filename: 'brief.docx', base64: base64(docxBytes('Ship the login fix by Friday.')) },
      ],
    });
    should(planned.ok).be.true();
    if (!planned.ok) return;
    should(planned.value.files.map(file => file.file)).eql([
      `${DIRECTORY}/shot.png`,
      `${DIRECTORY}/brief.docx`,
      `${DIRECTORY}/brief.docx.txt`,
    ]);
    should(String(planned.value.files[2]?.contents)).containEql('Ship the login fix by Friday.');
    should(planned.value.section).containEql('## Attachments');
    should(planned.value.section).containEql(`${DIRECTORY}/shot.png`);
    should(planned.value.section).containEql(`${DIRECTORY}/brief.docx.txt`);
    should(planned.value.section).containEql('image/png');
  });

  it('V-0443 should answer a refusal as a sentence for the caller: too many files, an unsafe name, bytes that are not base64 content', () => {
    const source = openingAttachmentsSource();
    const one = { filename: 'a.png', base64: base64('x') };
    const many = source.plan({
      directory: DIRECTORY,
      attachments: Array.from({ length: MAX_INITIAL_ATTACHMENTS + 1 }, () => one),
    });
    should(many.ok).be.false();
    if (!many.ok) should(many.error).containEql(`at most ${MAX_INITIAL_ATTACHMENTS}`);
    const unsafe = source.plan({ directory: DIRECTORY, attachments: [{ filename: '..', base64: base64('x') }] });
    should(unsafe.ok).be.false();
    if (!unsafe.ok) should(unsafe.error).containEql('not a plain file name');
    // `atob` accepts only base64; an empty decode is refused too.
    const empty = source.plan({ directory: DIRECTORY, attachments: [{ filename: 'a.png', base64: '====' }] });
    should(empty.ok).be.false();
  });

  it('V-0443 should plan a plain file without ever calling the inflater (only a document is extracted)', () => {
    const source = openingAttachmentsSource({
      inflateRaw: () => {
        throw new Error('the inflater itself broke');
      },
    });
    // A plain file never reaches the inflater, so the planner answers normally.
    should(
      source.plan({ directory: DIRECTORY, attachments: [{ filename: 'a.txt', base64: base64('hi') }] }).ok,
    ).be.true();
  });
});
