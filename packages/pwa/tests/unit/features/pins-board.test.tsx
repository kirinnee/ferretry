import { describe, expect, it } from 'bun:test';
import type { PinSnapshot } from '@ferretry/protocol';
import { PinsBoard, pinMessageLabel, pinProvenanceLabel } from '../../../src/features/pins/pins-board.tsx';
import { interact, mount } from '../../support/dom.ts';

const noteId = '00000000-0000-4000-8000-000000000001';
const messageId = '00000000-0000-4000-8000-000000000002';
const snapshot = (pins: PinSnapshot['pins']): PinSnapshot => ({
  v: 1,
  sessionId: 'session-a',
  pins,
  updatedAt: '2026-08-01T00:00:00.000Z',
});

describe('PinsBoard', () => {
  it('renders daemon-backed note and message pins with visible agent provenance and an exact message action', async () => {
    const opened: string[] = [];
    const board = await mount(
      <PinsBoard
        status="ready"
        snapshot={snapshot([
          {
            id: noteId,
            at: 2,
            kind: 'note',
            text: 'Watch the release window.',
            by: 'agent',
            createdBy: 'session-agent',
            createdByName: 'Mira',
          },
          {
            id: messageId,
            at: 1,
            kind: 'message',
            blockId: 'block-7',
            blockKind: 'assistant',
            preview: 'The deployment is ready.',
            by: 'human',
            createdBy: null,
            createdByName: null,
          },
        ])}
        onAddNote={() => {}}
        onEditNote={() => {}}
        onRemove={() => {}}
        onOpenMessage={id => opened.push(id)}
      />,
    );
    expect(board.container.textContent).toContain('Pinned by Mira');
    expect(board.container.textContent).toContain('Assistant message');
    await interact(() =>
      Array.from(board.container.querySelectorAll('button'))
        .find(button => button.textContent === 'Open message')
        ?.click(),
    );
    expect(opened).toEqual(['block-7']);
  });

  it('validates notes, then sends a trimmed note and supports edit/remove actions', async () => {
    const added: string[] = [];
    const edited: string[][] = [];
    const removed: string[] = [];
    const board = await mount(
      <PinsBoard
        status="ready"
        snapshot={snapshot([
          { id: noteId, at: 1, kind: 'note', text: 'Original', by: 'human', createdBy: null, createdByName: null },
        ])}
        onAddNote={text => added.push(text)}
        onEditNote={(...value) => edited.push(value)}
        onRemove={id => removed.push(id)}
      />,
    );
    const newNote = board.container.querySelector('textarea[aria-label="New pin note"]') as HTMLTextAreaElement;
    await interact(() => newNote.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(() =>
      board.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(board.container.textContent).toContain('Enter a note');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(newNote, '  Keep this  ');
    await interact(() => newNote.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(() =>
      board.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(added).toEqual(['Keep this']);
    await interact(() =>
      Array.from(board.container.querySelectorAll('button'))
        .find(button => button.textContent?.includes('Edit'))
        ?.click(),
    );
    const edit = board.container.querySelector('textarea[aria-label="Edit pin note"]') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(edit, 'Revised');
    await interact(() => edit.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(() =>
      Array.from(board.container.querySelectorAll('button'))
        .find(button => button.textContent === 'Save')
        ?.click(),
    );
    await interact(() =>
      Array.from(board.container.querySelectorAll('button'))
        .find(button => button.textContent?.includes('Remove'))
        ?.click(),
    );
    expect(edited).toEqual([[noteId, 'Revised']]);
    expect(removed).toEqual([noteId]);
  });

  it('makes empty, loading, and unreachable states explicit', async () => {
    const loading = await mount(
      <PinsBoard status="loading" snapshot={null} onAddNote={() => {}} onEditNote={() => {}} onRemove={() => {}} />,
    );
    expect(loading.container.textContent).toContain('Loading pins');
    const empty = await mount(
      <PinsBoard
        status="ready"
        snapshot={snapshot([])}
        onAddNote={() => {}}
        onEditNote={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(empty.container.textContent).toContain('No pins yet.');
    const unavailable = await mount(
      <PinsBoard
        status="error"
        snapshot={snapshot([])}
        onAddNote={() => {}}
        onEditNote={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(unavailable.container.textContent).toMatch(/Can't reach the daemon/);
  });

  it('formats provenance and message labels without using colour as the distinction', () => {
    expect(pinProvenanceLabel({ by: 'human', createdByName: null })).toBeNull();
    expect(pinProvenanceLabel({ by: 'agent', createdByName: null })).toBe('Pinned by an agent');
    expect(
      pinMessageLabel({
        id: messageId,
        at: 1,
        kind: 'message',
        blockId: 'block',
        blockKind: 'assistant',
        preview: 'x',
        by: 'human',
        createdBy: null,
        createdByName: null,
      }),
    ).toBe('Assistant message');
  });
});
