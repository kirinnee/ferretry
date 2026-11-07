/** Finding 5: Settings › Lessons edits the Global lessons document, so the owner changes or removes an applied rule. */
import { describe, expect, it } from 'bun:test';
import { LessonsSettingsSurface } from '../../../app/src/lessons-settings.tsx';
import { byText, click, typeInto, waitFor, waitForText } from '../../support/app/dom-helpers.ts';
import { mount, must } from '../../support/app/dom.ts';
import { fakeLessonsDaemon } from '../../support/app/lessons.ts';

describe('Settings › Lessons › Global lessons', () => {
  it('shows the document and saves the owner’s edit against the etag it read', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.state.global = { text: '## Lessons\n\n- Use bun.\n- Use direnv.\n', etag: 'etag-a' };
    const view = await mount(<LessonsSettingsSurface connection={daemon.connection} />);
    const section = must(view.container.querySelector('[data-global-lessons]'), 'Global lessons section');
    await waitForText(section, 'Global lessons');
    const editor = must(section.querySelector<HTMLTextAreaElement>('textarea'), 'editor');
    await waitFor(() => editor.value.includes('- Use bun.'), 'the document to load');

    await typeInto(editor, '## Lessons\n\n- Use direnv.\n');
    await click(byText(section, 'button', 'Save'));
    await waitForText(section, 'Saved.');
    expect(daemon.calls.find(call => call.route === 'PUT /v1/lessons/global')?.body).toEqual({
      text: '## Lessons\n\n- Use direnv.\n',
      etag: 'etag-a',
    });
    expect(daemon.state.global.text).toBe('## Lessons\n\n- Use direnv.\n');
    await view.unmount();
  });
});
