/**
 * A-36: a stored attachment's tile carries a plus that puts `%attachment:<delivered name>` in THIS ferret's message
 * box, through the shared Add to chat.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { registerComposerQuoteTarget } from '@ferretry/app';
import { ensureDom, interact, mount, must } from '@ferretry/app/testing';
import {
  AttachmentGalleryProvider,
  TranscriptAttachmentGallery,
} from '../../../../app/composer/attachment-gallery.tsx';
import { attachmentToken } from '../../../../app/composer/attachment-plus.tsx';
import type { StoredTranscriptAttachment } from '../../../../app/composer/attachments.ts';
import { daemonConnection } from '../../../../app/composer/seam.ts';

ensureDom();

const daemon = daemonConnection('plus-daemon');
const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

const composer = (daemonId: string, ferretId: string, draft = '') => {
  const state = { draft };
  disposers.push(
    registerComposerQuoteTarget({
      daemonId,
      ferretId,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
      },
    }),
  );
  return state;
};

const stored = (overrides: Partial<StoredTranscriptAttachment> = {}): StoredTranscriptAttachment => ({
  kind: 'attachment',
  ferretId: 'plus-ferret',
  attachmentId: 'att-1',
  filename: 'My Notes (1).md',
  mime: 'text/markdown',
  size: 512,
  ...overrides,
});

const urls = { create: () => 'blob:plus/1', revoke: () => undefined };
const bytes = async () => new Blob(['x'], { type: 'text/markdown' });
const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `an element labelled ${label}`);

describe('the attachment token', () => {
  it('names the file by the name the agent was delivered it under', () => {
    expect(attachmentToken({ attachmentId: 'att-1', filename: 'My Notes (1).md' })).toBe(
      '%attachment:att-1/My-Notes-1-.md',
    );
    expect(attachmentToken({ attachmentId: 'att-1', filename: 'C:\\x\\report.final.pdf' })).toBe(
      '%attachment:att-1/report.final.pdf',
    );
  });

  it('writes nothing for a name the grammar cannot point at', () => {
    expect(attachmentToken({ attachmentId: 'att-1', filename: 'notes-' })).toBeNull();
  });
});

describe('two delivered files of one name', () => {
  it('get two distinct tokens, each naming its own delivered copy, and both can be added', async () => {
    const mine = composer('plus-daemon', 'plus-ferret');
    expect(attachmentToken({ attachmentId: 'att_aa', filename: 'report.pdf' })).toBe('%attachment:att_aa/report.pdf');
    expect(attachmentToken({ attachmentId: 'att_bb', filename: 'report.pdf' })).toBe('%attachment:att_bb/report.pdf');
    const view = await mount(
      <AttachmentGalleryProvider urls={urls} load={bytes}>
        <TranscriptAttachmentGallery
          daemon={daemon}
          images={[
            stored({ attachmentId: 'att_aa', filename: 'report.pdf', mime: 'application/pdf' }),
            stored({ attachmentId: 'att_bb', filename: 'report.pdf', mime: 'application/pdf' }),
          ]}
        />
      </AttachmentGalleryProvider>,
    );
    try {
      const pluses = view.container.querySelectorAll<HTMLElement>('[aria-label="Add report.pdf to the message"]');
      expect(pluses.length).toBe(2);
      await interact(() => {
        pluses[0]?.click();
      });
      await interact(() => {
        pluses[1]?.click();
      });
      expect(mine.draft).toBe('%attachment:att_aa/report.pdf %attachment:att_bb/report.pdf ');
      expect(view.container.textContent).not.toContain('already in this message');
    } finally {
      await view.unmount();
    }
  });
});

describe('the plus on a document card', () => {
  it('adds the reference to this ferret’s message and says so', async () => {
    const mine = composer('plus-daemon', 'plus-ferret', 'read');
    const otherFerret = composer('plus-daemon', 'other-ferret');
    const otherDaemon = composer('other-daemon', 'plus-ferret');
    const view = await mount(
      <AttachmentGalleryProvider urls={urls} load={bytes}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
      </AttachmentGalleryProvider>,
    );
    try {
      await interact(() => {
        byLabel(view.container, 'Add My Notes (1).md to the message').click();
      });
      expect(mine.draft).toBe('read %attachment:att-1/My-Notes-1-.md ');
      expect(otherFerret.draft).toBe('');
      expect(otherDaemon.draft).toBe('');
      expect(view.container.textContent).toContain("Added %attachment:att-1/My-Notes-1-.md to this ferret's message.");
      await interact(() => {
        byLabel(view.container, 'Add My Notes (1).md to the message').click();
      });
      expect(mine.draft).toBe('read %attachment:att-1/My-Notes-1-.md ');
      expect(view.container.textContent).toContain('is already in this message.');
    } finally {
      await view.unmount();
    }
  });

  it('says there is nowhere to add it when no message box is open', async () => {
    const view = await mount(
      <AttachmentGalleryProvider urls={urls} load={bytes}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
      </AttachmentGalleryProvider>,
    );
    try {
      await interact(() => {
        byLabel(view.container, 'Add My Notes (1).md to the message').click();
      });
      expect(view.container.textContent).toContain('No message box is open for this ferret');
    } finally {
      await view.unmount();
    }
  });

  it('says a file name that cannot be written was not added, and leaves the draft alone', async () => {
    const mine = composer('plus-daemon', 'plus-ferret', 'keep');
    const view = await mount(
      <AttachmentGalleryProvider urls={urls} load={bytes}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored({ filename: 'notes-' })]} />
      </AttachmentGalleryProvider>,
    );
    try {
      await interact(() => {
        byLabel(view.container, 'Add notes- to the message').click();
      });
      expect(mine.draft).toBe('keep');
      expect(view.container.textContent).toContain('cannot be written as a reference');
    } finally {
      await view.unmount();
    }
  });
});

describe('the plus on a stored picture', () => {
  it('sits on the loaded picture and adds the same token; an inline picture has none', async () => {
    const mine = composer('plus-daemon', 'plus-ferret');
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const view = await mount(
      <AttachmentGalleryProvider urls={urls} load={async () => new Blob(['x'], { type: 'image/png' })}>
        <TranscriptAttachmentGallery
          daemon={daemon}
          images={[
            stored({ filename: 'shot.png', mime: 'image/png' }),
            { kind: 'inline', src: 'data:image/png;base64,AA', alt: 'chart' },
          ]}
        />
      </AttachmentGalleryProvider>,
    );
    try {
      expect(view.container.querySelectorAll('[aria-label^="Add "]').length).toBe(1);
      await interact(() => {
        byLabel(view.container, 'Add shot.png to the message').click();
      });
      expect(mine.draft).toBe('%attachment:att-1/shot.png ');
    } finally {
      globalThis.IntersectionObserver = original;
      await view.unmount();
    }
  });
});
