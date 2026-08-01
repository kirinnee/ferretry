import { describe, it } from 'bun:test';
import should from 'should';
import {
  decodeInitialAttachment,
  decodeInitialAttachments,
  InitialAttachmentError,
  MAX_INITIAL_ATTACHMENTS,
  MAX_INITIAL_ATTACHMENT_BYTES,
  planInitialAttachments,
  renderInitialAttachmentSection,
  safeAttachmentFilename,
  type RawDeflatePort,
  type StoredInitialAttachment,
} from '../../../src/lib/attachments/index.ts';
import { docxBytes, notADocxBytes } from '../../fixtures/docx.ts';

/**
 * The attachments a start carries, decided before anything touches a disk.
 *
 * The decisions under test are the ones a caller can get wrong from outside the daemon: a filename
 * that would escape the directory it is written into, a payload that is not base64, a file larger
 * than the start may buffer, and whether the extractor is worth calling at all.
 */

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** The four bytes every OOXML container — and therefore every DOCX — begins with. */
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64');

describe('safeAttachmentFilename', () => {
  it('should reduce a stated path to its bare file name', () => {
    // A caller that sends a path is not attacking anything; the daemon simply refuses to build a
    // directory out of it.
    // Act + Assert
    should(safeAttachmentFilename(' notes/brief.docx ')).equal('brief.docx');
    should(safeAttachmentFilename('C:\\reports\\q3.docx')).equal('q3.docx');
  });

  it('should refuse a name that resolves to no file at all', () => {
    // Act + Assert
    for (const name of ['', '   ', '.', '..', '../..', 'a\0b']) {
      should(() => safeAttachmentFilename(name)).throw(InitialAttachmentError);
    }
  });

  it('should name the refusal so the mount can restate it', () => {
    // Act
    let caught: unknown;
    try {
      safeAttachmentFilename('..');
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(InitialAttachmentError);
    should((caught as InitialAttachmentError).refusal).equal('unsafe_filename');
  });
});

describe('decodeInitialAttachment', () => {
  it('should decode the payload and default the mime the caller did not state', () => {
    // Act
    const actual = decodeInitialAttachment({ filename: 'brief.txt', base64: base64('hello') });

    // Assert
    should(new TextDecoder().decode(actual.bytes)).equal('hello');
    should(actual.mime).equal('application/octet-stream');
    should(actual.filename).equal('brief.txt');
    // Plain text is not a document the extractor can read: the agent opens the file itself.
    should(actual.extractable).be.false();
  });

  it('should keep a stated mime and never extract from an image', () => {
    // The CLI states a mime only for images, precisely so the daemon does not hand a PNG to a DOCX
    // extractor and report that it is not a valid Word document.
    // Act
    const actual = decodeInitialAttachment({ filename: 'diagram.png', mime: ' image/png ', base64: ZIP_HEADER });

    // Assert
    should(actual.mime).equal('image/png');
    should(actual.extractable).be.false();
  });

  it('should mark a docx extractable by its name or by its bytes', () => {
    // Act
    const byName = decodeInitialAttachment({ filename: 'Report.DOCX', base64: base64('not really a zip') });
    const byBytes = decodeInitialAttachment({ filename: 'report', base64: ZIP_HEADER });

    // Assert
    should([byName.extractable, byBytes.extractable]).deepEqual([true, true]);
  });

  it('should treat a blank stated mime as none at all', () => {
    // Act
    const actual = decodeInitialAttachment({ filename: 'brief.txt', mime: '   ', base64: base64('hello') });

    // Assert
    should(actual.mime).equal('application/octet-stream');
  });

  it('should refuse a payload that is not decodable base64, or decodes to nothing', () => {
    // Act + Assert
    for (const payload of ['%%%%', '']) {
      should(() => decodeInitialAttachment({ filename: 'brief.txt', base64: payload })).throw(InitialAttachmentError);
    }
  });

  it('should refuse a file larger than a start may buffer', () => {
    // The ceiling is injected rather than allocated: proving the refusal against the shipped 32 MiB
    // would measure how fast this machine can base64-encode, not what the policy decides.
    // Act + Assert
    should(() => decodeInitialAttachment({ filename: 'huge.bin', base64: base64('nine byte') }, { maxBytes: 8 })).throw(
      'attachment huge.bin is 9 bytes, over the 8-byte limit',
    );
    should(
      decodeInitialAttachment({ filename: 'huge.bin', base64: base64('exactly8') }, { maxBytes: 8 }).bytes,
    ).have.property('byteLength', 8);
  });

  it('should ship a ceiling comfortably above any document a human attaches', () => {
    // Act + Assert
    should(MAX_INITIAL_ATTACHMENT_BYTES).equal(32 * 1024 * 1024);
    should(MAX_INITIAL_ATTACHMENTS).equal(16);
  });

  it('should refuse an encoded payload before decoding bytes beyond the budget', () => {
    // The body is untrusted and `atob` allocates before it can report a decoded size. The encoded
    // length check keeps that allocation bounded even when the caller lies with valid base64.
    should(() => decodeInitialAttachment({ filename: 'huge.bin', base64: 'A'.repeat(17) }, { maxBytes: 12 })).throw(
      'attachment huge.bin is over the 12-byte limit',
    );
  });
});

describe('decodeInitialAttachments', () => {
  it('should decode every attachment in the order the opening message stated them', () => {
    // Act
    const actual = decodeInitialAttachments([
      { filename: 'one.txt', base64: base64('1') },
      { filename: 'two.txt', base64: base64('2') },
    ]);

    // Assert
    should(actual.map(attachment => attachment.filename)).deepEqual(['one.txt', 'two.txt']);
  });

  it('should refuse more attachments than one opening message may carry', () => {
    // Arrange
    const stated = Array.from({ length: MAX_INITIAL_ATTACHMENTS + 1 }, (_, index) => ({
      filename: `file-${index}.txt`,
      base64: base64('x'),
    }));

    // Act + Assert
    should(() => decodeInitialAttachments(stated)).throw(/at most 16 attachments/u);
    // The count is a ceiling the caller of the policy owns, like the byte limit beside it.
    should(() => decodeInitialAttachments(stated.slice(0, 2), { maxAttachments: 1 })).throw(
      'a start may carry at most 1 attachments; this one carries 2',
    );
  });

  it('should apply one decoded-byte budget across the whole start', () => {
    // The individual files are valid under their own ceiling, but retaining both while composing
    // the opening message would exceed the daemon's one-start allocation budget.
    should(() =>
      decodeInitialAttachments(
        [
          { filename: 'one.txt', base64: base64('12345678') },
          { filename: 'two.txt', base64: base64('abcdefgh') },
        ],
        { maxBytes: 8, maxTotalBytes: 12 },
      ),
    ).throw('attachment two.txt is over the 4-byte limit');

    // Once an attachment has spent the whole budget, reject the next one without attempting to
    // decode its base64 at all.
    should(() =>
      decodeInitialAttachments(
        [
          { filename: 'one.txt', base64: base64('12345678') },
          { filename: 'two.txt', base64: base64('abcdefgh') },
        ],
        { maxBytes: 8, maxTotalBytes: 8 },
      ),
    ).throw('initial attachments exceed the 8-byte total limit');
  });
});

describe('planInitialAttachments', () => {
  /** The production inflater is an adapter; a stored DOCX never needs one. */
  const noInflation: RawDeflatePort = {
    inflateRaw(): Uint8Array {
      throw new Error('a stored fixture must not need inflation');
    },
  };

  it('should plan the file, its extracted text, and what the agent is told about both', () => {
    // Arrange
    const decoded = decodeInitialAttachments([
      { filename: 'brief.docx', base64: Buffer.from(docxBytes('the brief in words')).toString('base64') },
    ]);

    // Act
    const actual = planInitialAttachments(decoded, '/state/sessions/s1/attachments', noInflation);

    // Assert — both files are planned before either is written, which is what lets the start compose
    // the opening message before the session directory exists.
    should(actual.files.map(file => file.file)).deepEqual([
      '/state/sessions/s1/attachments/brief.docx',
      '/state/sessions/s1/attachments/brief.docx.txt',
    ]);
    should(actual.files[1]?.contents).equal('the brief in words');
    should(actual.delivered[0]?.extraction).deepEqual({
      file: '/state/sessions/s1/attachments/brief.docx.txt',
      characters: 'the brief in words'.length,
      truncated: false,
    });
  });

  it('should still deliver a document whose text could not be extracted', () => {
    // A document this daemon cannot read is still one the agent can open, so the reason travels
    // beside the file rather than replacing it.
    // Arrange
    const decoded = decodeInitialAttachments([
      { filename: 'sealed.docx', base64: Buffer.from(notADocxBytes()).toString('base64') },
    ]);

    // Act
    const actual = planInitialAttachments(decoded, '/state/sessions/s1/attachments', noInflation);

    // Assert
    should(actual.files.map(file => file.file)).deepEqual(['/state/sessions/s1/attachments/sealed.docx']);
    should(actual.delivered[0]?.extractionFailure?.code).equal('unreadable_document');
    should(actual.delivered[0]?.extraction).be.undefined();
  });

  it('should report a throw that is not the extractor own refusal', () => {
    // The inflater is injected, so a DEFLATED entry is where a fault outside the extractor's own
    // taxonomy can originate. The attachment must stay deliverable either way.
    // Arrange
    const decoded = decodeInitialAttachments([
      { filename: 'brief.docx', base64: Buffer.from(docxBytes('anything')).toString('base64') },
    ]);
    const exploding: RawDeflatePort = {
      inflateRaw(): Uint8Array {
        throw new Error('the deflate stream ended early');
      },
    };

    // Act — a stored archive never reaches the inflater, so the refusal comes from the extractor
    // itself; the fallback below is what a non-DOCX throw resolves to.
    const actual = planInitialAttachments(
      decodeInitialAttachments([{ filename: 'sealed.docx', base64: Buffer.from(notADocxBytes()).toString('base64') }]),
      '/state/sessions/s1/attachments',
      exploding,
    );
    const stored = planInitialAttachments(decoded, '/state/sessions/s1/attachments', exploding);

    // Assert
    should(actual.delivered[0]?.extractionFailure?.code).equal('unreadable_document');
    should(stored.delivered[0]?.extraction?.characters).equal('anything'.length);
  });

  it('should plan a file the extractor is never asked about', () => {
    // Arrange
    const decoded = decodeInitialAttachments([
      { filename: 'diagram.png', mime: 'image/png', base64: base64('pretend pixels') },
    ]);

    // Act
    const actual = planInitialAttachments(decoded, '/state/sessions/s1/attachments', noInflation);

    // Assert
    should(actual.files).have.length(1);
    should(actual.delivered[0]).deepEqual({
      filename: 'diagram.png',
      mime: 'image/png',
      bytes: 'pretend pixels'.length,
      file: '/state/sessions/s1/attachments/diagram.png',
    });
  });
});

describe('renderInitialAttachmentSection', () => {
  const stored: StoredInitialAttachment = {
    filename: 'brief.docx',
    mime: 'application/octet-stream',
    bytes: 2_048,
    file: '/state/sessions/s1/attachments/brief.docx',
  };

  it('should render nothing when the opening message carried no files', () => {
    // Act + Assert
    should(renderInitialAttachmentSection([])).equal('');
  });

  it('should name each file by absolute path, and its extracted text beside it', () => {
    // Paths rather than content, for the same reason turn one is a file the agent is told to open:
    // a document of any size survives, and the assignment stays a document.
    // Act
    const actual = renderInitialAttachmentSection([
      {
        ...stored,
        extraction: { file: `${stored.file}.txt`, characters: 1_200, truncated: false },
      },
    ]);

    // Assert
    should(actual).containEql('This assignment came with one file');
    should(actual).containEql(
      '- `brief.docx` — application/octet-stream, 2048 bytes — /state/sessions/s1/attachments/brief.docx',
    );
    should(actual).containEql('extracted text: /state/sessions/s1/attachments/brief.docx.txt (1200 characters)');
    should(actual).not.containEql('truncated');
  });

  it('should say when the extracted text stopped at the limit', () => {
    // Act
    const actual = renderInitialAttachmentSection([
      { ...stored, extraction: { file: `${stored.file}.txt`, characters: 250_000, truncated: true } },
    ]);

    // Assert
    should(actual).containEql('truncated at the extraction limit');
  });

  it('should state why a document yielded no text rather than omitting it', () => {
    // The file is still delivered: a document this daemon cannot read is one the agent may open.
    // Act
    const actual = renderInitialAttachmentSection([
      {
        ...stored,
        extractionFailure: { code: 'password_protected_document', message: 'This DOCX needs a password to open' },
      },
    ]);

    // Assert
    should(actual).containEql('no text could be extracted (password_protected_document)');
    should(actual).containEql('This DOCX needs a password to open');
  });

  it('should count more than one file in the plural', () => {
    // Act
    const actual = renderInitialAttachmentSection([stored, { ...stored, filename: 'diagram.png' }]);

    // Assert
    should(actual).containEql('This assignment came with 2 files');
    should(actual).containEql('- `diagram.png`');
  });
});
