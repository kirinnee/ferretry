import { describe, expect, test } from 'bun:test';
import { LocalModelsNote } from '../../src/components/local-models-note.tsx';
import { interact, mount, must } from '../support/dom.ts';
import { localModelsFixture, PULL } from '../support/local-models.ts';

describe('LocalModelsNote', () => {
  test('renders nothing before a read and when models were found', async () => {
    const unread = await mount(<LocalModelsNote id="n" local={undefined} write={async () => undefined} />);
    expect(unread.container.querySelector('[data-local-models-note]')).toBeNull();
    await unread.unmount();
    const found = await mount(
      <LocalModelsNote id="n" local={localModelsFixture('found')} write={async () => undefined} />,
    );
    expect(found.container.querySelector('[data-local-models-note]')).toBeNull();
    await found.unmount();
  });

  test('says what to do and gives the exact pull command, selectable and copyable', async () => {
    const copied: string[] = [];
    const view = await mount(
      <LocalModelsNote
        id="note"
        local={localModelsFixture('none-pulled')}
        write={async text => {
          copied.push(text);
        }}
      />,
    );
    const note = must(view.container.querySelector('[data-local-models-note="none-pulled"]'), 'the note');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.id).toBe('note');
    expect(note.querySelector('p')?.textContent).toBe('Ollama is running, but no model is installed yet.');
    expect(note.querySelector('[data-local-models-command]')?.textContent).toBe(PULL);
    await interact(() => must(note.querySelector<HTMLButtonElement>(`[aria-label="Copy ${PULL}"]`), 'copy').click());
    expect(copied).toEqual([PULL]);
    await view.unmount();
  });

  test('shows a state with no command as a sentence alone, and the browser clipboard by default', async () => {
    const view = await mount(<LocalModelsNote id="n" local={localModelsFixture('refused')} />);
    const note = must(view.container.querySelector('[data-local-models-note="refused"]'), 'the note');
    expect(note.textContent).toContain('OLLAMA_HOST');
    expect(note.querySelector('code')).toBeNull();
    await view.unmount();
    const disabled = await mount(<LocalModelsNote id="n" local={localModelsFixture('disabled')} />);
    expect(disabled.container.querySelector('[data-local-models-note="disabled"]')?.className).toContain('surface-2');
    await disabled.unmount();
    const withCopy = await mount(<LocalModelsNote id="n" local={localModelsFixture('not-running')} />);
    expect(withCopy.container.querySelector('[data-local-models-command]')?.textContent).toBe(PULL);
    await withCopy.unmount();
  });
});
