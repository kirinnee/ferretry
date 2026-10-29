import { describe, expect, it } from 'bun:test';
import {
  DictationInsertedToast,
  INSERTED_TOAST_MS,
  insertionStillUndoable,
} from '../../src/components/dictation-inserted-toast.tsx';
import type { DictationAutoInsertion } from '../../src/hooks/use-dictation.ts';
import { interact, mount, must } from '../support/dom.ts';
import { settleUntil } from '../support/settle.ts';

const insertion: DictationAutoInsertion = {
  before: { text: 'note:', caret: 5 },
  after: { text: 'note: spoken', caret: 12 },
};

const shown = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-dictation-inserted]');

describe('insertionStillUndoable', () => {
  it('holds while the draft is the inserted result or the text it started from', () => {
    expect(insertionStillUndoable(insertion, 'note: spoken')).toBe(true);
    expect(insertionStillUndoable(insertion, 'note:')).toBe(true);
  });

  it('lets go once the person has edited the draft', () => {
    expect(insertionStillUndoable(insertion, 'note: spoken!')).toBe(false);
    expect(insertionStillUndoable(insertion, '')).toBe(false);
  });
});

describe('<DictationInsertedToast>', () => {
  it('shows nothing, but keeps its live region mounted, with no insertion', async () => {
    const view = await mount(
      <DictationInsertedToast insertion={null} draft="" onUndo={() => undefined} onDismiss={() => undefined} />,
    );
    expect(shown(view.container)).toBeNull();
    expect(view.container.querySelector('[role="status"]')).not.toBeNull();
    await view.unmount();
  });

  it('says Inserted and hands the insertion to Undo', async () => {
    const undone: DictationAutoInsertion[] = [];
    const view = await mount(
      <DictationInsertedToast
        insertion={insertion}
        draft="note: spoken"
        onUndo={value => undone.push(value)}
        onDismiss={() => undefined}
      />,
    );
    expect(must(shown(view.container), 'the note').textContent).toContain('Inserted');
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('button[aria-label="Undo the inserted dictation"]'),
        'the undo button',
      ).click(),
    );
    expect(undone).toEqual([insertion]);
    await view.unmount();
  });

  it('dismisses itself after its time', async () => {
    let dismissed = 0;
    const view = await mount(
      <DictationInsertedToast
        insertion={insertion}
        draft="note: spoken"
        durationMs={5}
        onUndo={() => undefined}
        onDismiss={() => {
          dismissed += 1;
        }}
      />,
    );
    await settleUntil(() => dismissed > 0, 'the note to dismiss itself', interact);
    expect(dismissed).toBeGreaterThan(0);
    expect(INSERTED_TOAST_MS).toBeGreaterThan(1000);
    await view.unmount();
  });

  it('dismisses itself, and hides, when the draft is edited away from the insertion', async () => {
    let dismissed = 0;
    const onDismiss = (): void => {
      dismissed += 1;
    };
    const view = await mount(
      <DictationInsertedToast
        insertion={insertion}
        draft="note: spoken"
        onUndo={() => undefined}
        onDismiss={onDismiss}
      />,
    );
    expect(shown(view.container)).not.toBeNull();
    await view.render(
      <DictationInsertedToast
        insertion={insertion}
        draft="note: spoken!"
        onUndo={() => undefined}
        onDismiss={onDismiss}
      />,
    );
    expect(shown(view.container)).toBeNull();
    expect(dismissed).toBeGreaterThan(0);
    await view.unmount();
  });
});
