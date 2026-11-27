/**
 * The browser entry for "the plus on an attachment tile": Conversation's REAL `TranscriptAttachmentGallery` over fake
 * files (a PDF, a long-named document, a stored picture, a 16px one), above a stand-in message box registered as the ferret's real
 * composer target, so the plus reaches it through the real Add to chat. Everything is fake data.
 *
 *   ?theme=<palette>-<mode>   (the test sets `data-style` itself)
 */

import { registerComposerQuoteTarget } from '@ferretry/app';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AttachmentGalleryProvider,
  TranscriptAttachmentGallery,
} from '../../../../app/composer/attachment-gallery.tsx';
import type { StoredTranscriptAttachment } from '../../../../app/composer/attachments.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const daemon = daemonConnection('scene-daemon');
const FERRET = 'scene-ferret';
const INITIAL_DRAFT = params.get('draft') ?? '';

const picture = (width = 480, height = 300): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const draw = canvas.getContext('2d');
    if (draw === null) return reject(new Error('no canvas'));
    draw.fillStyle = '#26364f';
    draw.fillRect(0, 0, width, height);
    draw.fillStyle = '#5eead4';
    draw.fillRect(width / 8, height * 0.27, width * 0.75, height * 0.46);
    canvas.toBlob(blob => (blob === null ? reject(new Error('no blob')) : resolve(blob)), 'image/png');
  });

const file = (attachmentId: string, filename: string, mime: string, size: number): StoredTranscriptAttachment => ({
  kind: 'attachment',
  ferretId: FERRET,
  attachmentId,
  filename,
  mime,
  size,
});
const FILES = [
  file('att-pdf', 'quarterly report.pdf', 'application/pdf', 482_000),
  file(
    'att-long',
    'a-very-long-document-name-that-keeps-going-and-going-for-the-phone-column-to-wrap.md',
    'text/markdown',
    3_100,
  ),
  file('att-png', 'screenshot.png', 'image/png', 90_000),
  file('att-tiny', 'tiny.png', 'image/png', 120),
];

const Scene = ({ image, tiny }: { image: Blob; tiny: Blob }) => {
  const [draft, setDraft] = useState(INITIAL_DRAFT);
  useEffect(() => {
    let current = INITIAL_DRAFT;
    return registerComposerQuoteTarget({
      daemonId: daemon.daemonId,
      ferretId: FERRET,
      draft: () => current,
      replaceDraft: next => {
        current = next;
        setDraft(next);
      },
    });
    // The registered target reads and writes its own copy; the state is only for drawing it.
  }, []);
  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-3 p-4">
      <AttachmentGalleryProvider
        urls={{ create: blob => URL.createObjectURL(blob), revoke: url => URL.revokeObjectURL(url) }}
        load={async (_daemon, scope) =>
          scope.attachmentId === 'att-png'
            ? image
            : scope.attachmentId === 'att-tiny'
              ? tiny
              : new Blob(['%PDF-1.4'], { type: 'application/pdf' })
        }
      >
        <TranscriptAttachmentGallery daemon={daemon} images={FILES} />
      </AttachmentGalleryProvider>
      <div
        className="min-h-[44px] rounded-panel border border-border-soft bg-surface-2 p-panel text-left"
        data-scene-message-box
      >
        <span className="text-meta text-faint">Message</span>
        <div data-scene-draft className="break-words">
          {draft}
        </div>
      </div>
    </main>
  );
};

const mount = document.getElementById('root');
if (mount === null) throw new Error('no root');
void Promise.all([picture(), picture(16, 16)]).then(([image, tiny]) =>
  createRoot(mount).render(<Scene image={image} tiny={tiny} />),
);
