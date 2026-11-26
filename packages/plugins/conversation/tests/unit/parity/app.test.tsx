/**
 * Parity rows S-* that Conversation owns (docs/design/rebuild-parity.tsv). The live tests mount the real screens: the
 * composer's "+" menu (S-0064), the hand-off message (S-0111) and the ledger
 * message's "⋯" menu (S-0134). The skipped rows wait on the Conversation app half's remaining ports (ports-pending.json
 * `pendingHalves`, design D2 #4). The voice and warden settings rows are their plugins' own screens.
 */
import { describe, expect, test } from 'bun:test';
import { createRef } from 'react';
import { type HandoffDocument, turnFileInstruction } from '@ferretry/core-mailbox/contract';
import { ensureDom, interact, mount, must } from '@ferretry/app/testing';
import manifest from '../../../manifest.ts';
import { HandoffSourceProvider, TURN_FILE_EXPLANATION } from '../../../app/chat/handoff-message.tsx';
import { LedgerMessage } from '../../../app/chat/ledger-message.tsx';
import { TranscriptRow } from '../../../app/chat/transcript-row.tsx';
import type { TranscriptEntry } from '../../../app/chat/transcript-entries.ts';
import { AttachmentGalleryProvider } from '../../../app/composer/attachment-gallery.tsx';
import { addMenuActions, ComposerAddMenu } from '../../../app/composer/composer-add-menu.tsx';
import { daemonConnection } from '../../../app/composer/seam.ts';

ensureDom();

describe('the app surfaces Conversation owns', () => {
  test('S-0064 the composer add menu offers each way to add, runs the chosen one once and closes', async () => {
    const calls: string[] = [];
    let closed = 0;
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const anchorRef = createRef<HTMLElement>();
    (anchorRef as { current: HTMLElement | null }).current = anchor;
    const view = await mount(
      <ComposerAddMenu
        actions={addMenuActions({
          photos: () => calls.push('photos'),
          files: () => calls.push('files'),
          camera: () => calls.push('camera'),
          location: () => calls.push('location'),
        })}
        anchorRef={anchorRef}
        onClose={() => {
          closed += 1;
        }}
        open
        variant="sheet"
      />,
    );
    try {
      const dialog = must(document.querySelector('[data-testid="composer-add-menu"]'), 'the menu');
      expect(dialog.getAttribute('aria-label')).toBe('Add to message');
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(rows.map(row => row.textContent)).toEqual([
        'Photos & screenshotsFrom your gallery',
        'FilesDocuments, logs, anything',
        'Take photoUse the camera',
        'Share locationSend where you are, with a map',
      ]);
      await interact(() => rows[1]?.click());
      expect(calls).toEqual(['files']);
      expect(closed).toBe(1);
    } finally {
      await view.unmount();
      anchor.remove();
    }
  });

  test('S-0115 the imported-history page is removed (O8-12): Conversation declares no links screen and no nav entry for it', () => {
    const screens = manifest.ui?.screens ?? [];
    expect(screens.map(screen => screen.id)).not.toContain('links');
    expect(screens.filter(screen => screen.nav !== undefined)).toEqual([]);
  });

  test('S-0111 the hand-off message shows what the person sent, never the turn-file pointer, and says why on request', async () => {
    const path = '/home/kirin/.ferretry/state/sessions/s1/turns/turn-008.md';
    const row: TranscriptEntry = {
      id: 'u1',
      kind: 'user',
      text: turnFileInstruction(path),
      label: 'You',
      at: Date.UTC(2026, 9, 18, 2, 45, 0),
      handoff: { kind: 'turn', name: 'turn-008', turn: 8, path },
    };
    const sent: HandoffDocument = {
      name: 'turn-008',
      message: 'Is this **legit**?\n\nSee the file.',
      attachments: [{ filename: 'elsewhere.pdf', mime: 'application/pdf' }],
    };
    const view = await mount(
      <AttachmentGalleryProvider load={async () => new Blob()}>
        <HandoffSourceProvider
          source={{ daemon: daemonConnection('handoff-daemon'), sessionId: 's1', read: async () => sent }}
        >
          <TranscriptRow answered entry={row} />
        </HandoffSourceProvider>
      </AttachmentGalleryProvider>,
    );
    try {
      await interact(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const handoff = must(view.container.querySelector<HTMLElement>('.fy-handoff'), 'the hand-off');
      expect(handoff.dataset['handoffState']).toBe('read');
      const text = view.container.textContent ?? '';
      expect(text).not.toContain('Read the file');
      expect(must(view.container.querySelector('.fy-handoff-text strong'), 'the bold word').textContent).toBe('legit');
      expect(text).toContain('See the file.');
      expect(must(view.container.querySelector('.fy-handoff-chip'), 'the file chip').textContent).toBe('elsewhere.pdf');
      const via = must(view.container.querySelector<HTMLButtonElement>('.fy-handoff-via-button'), 'via turn file');
      await interact(() => via.click());
      expect(must(view.container.querySelector('[data-handoff-note="explained"]'), 'the note').textContent).toBe(
        TURN_FILE_EXPLANATION,
      );
    } finally {
      await view.unmount();
    }
  });

  test('S-0134 the ledger message more-menu opens on its button, lists send again, cancel and copy, and copies the message', async () => {
    const copied: string[] = [];
    const view = await mount(
      <LedgerMessage
        onCancel={async () => true}
        onRetry={async () => true}
        record={{
          sendId: 'send-1',
          acceptedAt: '2026-10-21T09:00:00.000Z',
          message: 'ship it',
          attachmentIds: [],
          fate: 'accepted',
        }}
        write={async text => void copied.push(text)}
      />,
    );
    try {
      const button = must(view.container.querySelector<HTMLButtonElement>('[data-ledger-more]'), 'the actions button');
      expect(button.getAttribute('aria-label')).toBe('Message actions');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(view.container.querySelector('[role="menu"]')).toBeNull();
      await interact(() => button.click());
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const keys = [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        item => item.dataset['menuKey'],
      );
      expect(keys).toEqual(['send-again', 'cancel', 'copy']);
      await interact(() => must(view.container.querySelector<HTMLElement>('[data-menu-key="copy"]'), 'copy').click());
      expect(copied).toEqual(['ship it']);
      expect(view.container.querySelector('[role="menu"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test.skip('S-0191 S-0192 S-0193 S-0194 S-0352 S-0378 S-0403 the queue page, its rows and route — pending port: Conversation app half', () => {});
  test.skip('S-0319 the queue-view feature — pending port: Conversation app half', () => {});
  test.skip('S-0332 the stuck-messages feature — pending port: Conversation app half', () => {});
  test.skip('S-0394 the imported-history screen, now links — pending port: Conversation app half', () => {});
  test.skip('S-0509 the message-marks setting — pending port: Conversation app half', () => {});
  test.skip('S-0272 the transcription log setting — pending port: Conversation app half', () => {});
  test.skip('S-0475 S-0498 voice chat reading every message or the last of a turn — not Conversation’s: voice', () => {});
  test.skip('S-0530 the warden setting for a question asked — not Conversation’s: warden', () => {});
});
