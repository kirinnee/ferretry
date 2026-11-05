import { describe, test } from 'bun:test';
import should from 'should';
import '../support/dom.ts';
import {
  AttachmentIndex,
  createAttachmentReferenceResolver,
  revealAttachmentTile,
} from '../../src/lib/attachment-references.ts';
import { insertAtSelection, referenceToken } from '../../src/lib/composer-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  findReferences,
  formatReference,
  isAttachmentReferenceName,
  parseReferenceHref,
  parseReferenceToken,
  type ResolvedAttachment,
  type ResolvedAttachmentReference,
  referenceHref,
  referenceIdentity,
  remarkReferences,
  resolveReference,
  revalidateReference,
} from '../../src/lib/references.ts';

const daemonId = 'daemon-a' as DaemonId;
const scope = { daemonId, sessionId: 'sess-1' };
const att = (attachmentId: string, name: string): ResolvedAttachment => ({
  daemonId,
  sessionId: 'sess-1',
  attachmentId,
  name,
});

const raws = (text: string): string[] => findReferences(text).map(match => match.raw);

describe('%attachment: grammar', () => {
  test('should read a delivered name as one attachment reference', () => {
    // Assert
    should(parseReferenceToken('%attachment:shot.png')).deepEqual({ kind: 'attachment', name: 'shot.png' });
    should(parseReferenceToken('%attachment:My-Notes-1-.md')).deepEqual({ kind: 'attachment', name: 'My-Notes-1-.md' });
    should(parseReferenceToken('%ATTACHMENT:shot.png')).deepEqual({ kind: 'attachment', name: 'shot.png' });
  });

  test('should keep the name case-sensitive, because filenames are', () => {
    // Assert
    should(parseReferenceToken('%attachment:Shot.PNG')).deepEqual({ kind: 'attachment', name: 'Shot.PNG' });
    should(formatReference({ kind: 'attachment', name: 'Shot.PNG' })).equal('%attachment:Shot.PNG');
  });

  test('should refuse a name that is not a delivered name', () => {
    // Assert
    should(parseReferenceToken('%attachment:')).be.null();
    should(parseReferenceToken('%attachment:.hidden')).be.null();
    should(parseReferenceToken('%attachment:-lead')).be.null();
    should(parseReferenceToken('%attachment:shot.')).be.null();
    should(parseReferenceToken('%attachment:shot-')).be.null();
    should(parseReferenceToken('%attachment:has space')).be.null();
    should(parseReferenceToken(`%attachment:${'a'.repeat(129)}`)).be.null();
    should(isAttachmentReferenceName('a'.repeat(128))).be.true();
    should(isAttachmentReferenceName('a'.repeat(129))).be.false();
    should(() => formatReference({ kind: 'attachment', name: 'shot.' })).throw(TypeError);
  });

  test('should leave a sentence full stop to the sentence', () => {
    // Assert
    should(raws('see %attachment:shot.png.')).deepEqual(['%attachment:shot.png']);
    should(raws('see %attachment:shot.png, then %attachment:b.md!')).deepEqual([
      '%attachment:shot.png',
      '%attachment:b.md',
    ]);
    should(raws('(%attachment:shot.png)')).deepEqual(['%attachment:shot.png']);
    should(raws('%attachment:shot.png:')).deepEqual(['%attachment:shot.png']);
  });

  test('should not open a candidate when the name ends in a dash, or the sigil is welded to a word', () => {
    // Assert
    should(raws('see %attachment:shot.png-')).deepEqual([]);
    should(raws('100%attachment:shot.png')).deepEqual([]);
    should(raws('50% of it, 100%')).deepEqual([]);
    should(raws('a %attachment: with nothing')).deepEqual([]);
  });

  test('should round-trip through the envelope and carry the session', () => {
    // Arrange
    const proved = resolveReference(
      { kind: 'attachment', name: 'shot.png' },
      { attachment: name => (name === 'shot.png' ? att('att_1', name) : null) },
    ) as ResolvedAttachmentReference;

    // Act
    const href = referenceHref(proved);

    // Assert
    should(proved).deepEqual({
      kind: 'attachment',
      daemonId,
      sessionId: 'sess-1',
      attachmentId: 'att_1',
      name: 'shot.png',
    });
    should(parseReferenceHref(href)).deepEqual(proved);
    should(parseReferenceHref(`${href}&extra=1`)).be.null();
    should(referenceIdentity(proved)).equal('attachment:daemon-a:sess-1:att_1');
  });
});

describe('%attachment: proof', () => {
  test('should link nothing without a resolver, or when the resolver answers for another name', () => {
    // Assert
    should(resolveReference({ kind: 'attachment', name: 'shot.png' }, {})).be.null();
    should(
      resolveReference({ kind: 'attachment', name: 'shot.png' }, { attachment: () => att('att_1', 'other.png') }),
    ).be.null();
    should(resolveReference({ kind: 'attachment', name: 'shot.png' }, { attachment: () => null })).be.null();
    should(
      resolveReference(
        { kind: 'attachment', name: 'shot.png' },
        {
          attachment: () => {
            throw new Error('boom');
          },
        },
      ),
    ).be.null();
  });

  test('should re-prove a click against the same file, not merely the same name', () => {
    // Arrange
    const proved = resolveReference(
      { kind: 'attachment', name: 'shot.png' },
      { attachment: () => att('att_1', 'shot.png') },
    ) as ResolvedAttachmentReference;

    // Assert
    should(revalidateReference(proved, { attachment: () => att('att_1', 'shot.png') })).deepEqual(proved);
    should(revalidateReference(proved, { attachment: () => att('att_2', 'shot.png') })).be.null();
    should(revalidateReference(proved, {})).be.null();
  });

  test('should turn a proved token in prose into a link and leave an unproved one as text', () => {
    // Arrange
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'look at %attachment:shot.png and %attachment:gone.png' }],
        },
      ],
    };

    // Act
    remarkReferences({ resolvers: { attachment: name => (name === 'shot.png' ? att('att_1', name) : null) } })(tree);

    // Assert
    const paragraph = tree.children[0] as {
      children: { type: string; value?: string; children?: { value: string }[] }[];
    };
    should(paragraph.children.map(node => node.type)).deepEqual(['text', 'link', 'text']);
    should(paragraph.children[1]?.children?.[0]?.value).equal('%attachment:shot.png');
    should(paragraph.children[2]?.value).equal(' and %attachment:gone.png');
  });

  test('should write the token only for a name the grammar accepts', () => {
    // Assert
    should(referenceToken({ kind: 'attachment', name: 'shot.png' })).equal('%attachment:shot.png');
    should(referenceToken({ kind: 'attachment', name: 'my shot.png' })).be.null();
  });
});

describe('AttachmentIndex', () => {
  test('should prefer the file on the same message, then the newest message', () => {
    // Arrange
    const index = new AttachmentIndex();
    index.record('turn-3', [{ attachmentId: 'att_old', filename: 'shot.png' }]);
    index.record('turn-9', [{ attachmentId: 'att_new', filename: 'shot.png' }]);
    index.record('turn-5', [{ attachmentId: 'att_mid', filename: 'shot.png' }]);

    // Assert
    should(index.find('shot.png')?.attachmentId).equal('att_new');
    should(index.find('shot.png', [{ attachmentId: 'att_old', filename: 'shot.png' }])?.attachmentId).equal('att_old');
    should(index.find('nothing.png')).be.undefined();
  });

  test('should rank a queued send behind every delivered turn, and a later file of one message last', () => {
    // Arrange
    const index = new AttachmentIndex();
    index.record('queued-abc', [
      { attachmentId: 'att_q1', filename: 'a.png' },
      { attachmentId: 'att_q2', filename: 'a.png' },
    ]);
    index.record('turn-100', [{ attachmentId: 'att_t', filename: 'a.png' }]);

    // Assert
    should(index.find('a.png')?.attachmentId).equal('att_q2');
  });

  test('should rank two queued sends by when they landed, not by the order their documents were read', () => {
    // Arrange: the newer send's document is read FIRST.
    const index = new AttachmentIndex();
    index.record('queued-b', [{ attachmentId: 'att_b', filename: 'a.png' }], 200);
    index.record('queued-a', [{ attachmentId: 'att_a', filename: 'a.png' }], 100);

    // Assert
    should(index.find('a.png')?.attachmentId).equal('att_b');
  });

  test('should not let an older queued send beat a later delivered turn of the same name', () => {
    // Arrange
    const index = new AttachmentIndex();
    index.record('queued-old', [{ attachmentId: 'att_q', filename: 'a.png' }], 100);
    index.record('turn-9', [{ attachmentId: 'att_t', filename: 'a.png' }], 200);

    // Assert
    should(index.find('a.png')?.attachmentId).equal('att_t');

    // ...and a queued send that landed after the turn does win.
    index.record('queued-new', [{ attachmentId: 'att_q2', filename: 'a.png' }], 300);
    should(index.find('a.png')?.attachmentId).equal('att_q2');
  });

  test('should re-rank a message whose time becomes known, and say so to subscribers', () => {
    // Arrange
    const index = new AttachmentIndex();
    let heard = 0;
    index.subscribe(() => {
      heard += 1;
    });
    index.record('queued-x', [{ attachmentId: 'att_x', filename: 'a.png' }]);
    index.record('turn-9', [{ attachmentId: 'att_t', filename: 'a.png' }], 200);
    should(index.find('a.png')?.attachmentId).equal('att_x');

    // Act
    index.record('queued-x', [{ attachmentId: 'att_x', filename: 'a.png' }], 100);

    // Assert
    should(index.find('a.png')?.attachmentId).equal('att_t');
    should(heard).equal(3);
  });

  test('should tell a subscriber when it learns a file, and stay quiet when nothing changed', () => {
    // Arrange
    const index = new AttachmentIndex();
    let heard = 0;
    const stop = index.subscribe(() => {
      heard += 1;
    });

    // Act
    index.record('turn-1', [{ attachmentId: 'att_1', filename: 'a.png' }]);
    index.record('turn-1', [{ attachmentId: 'att_1', filename: 'a.png' }]);
    index.record('turn-2', []);
    stop();
    index.record('turn-3', [{ attachmentId: 'att_3', filename: 'b.png' }]);

    // Assert
    should(heard).equal(1);
    should(index.version()).equal(2);
  });

  test('should not let a row that shows no files erase what the row that does recorded', () => {
    // Arrange
    const index = new AttachmentIndex();
    index.record('turn-4', [{ attachmentId: 'att_1', filename: 'a.png' }]);

    // Act
    index.record('turn-4', []);

    // Assert
    should(index.find('a.png')?.attachmentId).equal('att_1');
  });

  test('should resolve for its own daemon and session, and refuse a name the grammar cannot write', () => {
    // Arrange
    const index = new AttachmentIndex();
    index.record('turn-1', [{ attachmentId: 'att_1', filename: 'shot.png' }]);
    const resolve = createAttachmentReferenceResolver(scope, index);

    // Assert
    should(resolve('shot.png')).deepEqual(att('att_1', 'shot.png'));
    should(resolve('bad name')).be.null();
    should(resolve('missing.png')).be.null();
  });
});

describe('insertAtSelection', () => {
  test('should put the token at the caret with a space on either side where it needs one', () => {
    // Assert
    should(insertAtSelection('look at the', 11, 11, '%attachment:a.png')).deepEqual({
      draft: 'look at the %attachment:a.png ',
      caret: 'look at the %attachment:a.png '.length,
    });
    should(insertAtSelection('', 0, 0, '%attachment:a.png').draft).equal('%attachment:a.png ');
    should(insertAtSelection('see  now', 4, 4, 'T')).deepEqual({ draft: 'see T now', caret: 5 });
    should(insertAtSelection('seenow', 3, 3, 'T').draft).equal('see T now');
  });

  test('should replace a selection and clamp a caret that points past the draft', () => {
    // Assert
    should(insertAtSelection('look at THIS now', 8, 12, 'T').draft).equal('look at T now');
    should(insertAtSelection('abc', 99, 120, 'T').draft).equal('abc T ');
  });
});

describe('revealAttachmentTile', () => {
  const dom = (html: string): HTMLElement => {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
  };
  /** Timers that wait to be fired, so a test sees the ring while it is on. */
  const manual = () => {
    const pending: (() => void)[] = [];
    return {
      pending,
      timers: { setTimeout: ((run: () => void) => pending.push(run)) as unknown as typeof setTimeout },
    };
  };
  const timers = manual().timers;

  test("should ring the tile and answer true, preferring the tile in the clicked chip's own message", () => {
    // Arrange
    const root = dom(
      '<div data-handoff="turn-2"><div data-attachment-id="att_1" id="one"></div><a id="chip"></a></div>' +
        '<div data-handoff="turn-9"><div data-attachment-id="att_1" id="two"></div></div>',
    );
    const chip = root.querySelector('#chip');

    const clock = manual();

    // Act
    const found = revealAttachmentTile(root, 'att_1', chip, clock.timers);

    // Assert
    should(found).be.true();
    should(root.querySelector('#one')?.hasAttribute('data-attachment-flash')).be.true();
    should(root.querySelector('#two')?.hasAttribute('data-attachment-flash')).be.false();
    for (const run of clock.pending) run();
    should(root.querySelector('#one')?.hasAttribute('data-attachment-flash')).be.false();
  });

  test('should fall back to the newest tile and answer false when the file is not on the page', () => {
    // Arrange
    const root = dom('<div data-attachment-id="att_1" id="a"></div><div data-attachment-id="att_1" id="b"></div>');
    let scrolled = '';
    for (const element of root.querySelectorAll<HTMLElement>('[data-attachment-id]'))
      element.scrollIntoView = () => {
        scrolled += element.id;
      };

    // Assert
    should(revealAttachmentTile(root, 'att_1', null, timers)).be.true();
    should(scrolled).equal('b');
    should(revealAttachmentTile(root, 'att_404', null, timers)).be.false();
  });
});
