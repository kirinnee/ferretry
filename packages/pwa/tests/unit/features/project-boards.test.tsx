import { afterEach, describe, expect, it } from 'bun:test';

import { ProjectBoards } from '../../../src/features/projects/project-boards.tsx';
import { mount, type Mounted, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

let open: Mounted | null = null;
const show = async (element: Parameters<typeof mount>[0]): Promise<Mounted> => {
  open = await mount(element);
  return open;
};
afterEach(async () => {
  await open?.unmount();
  open = null;
});

describe('ProjectBoards', () => {
  it('says a project exposes no board rather than drawing an empty list', async () => {
    // Arrange / Act
    const view = await show(<ProjectBoards sessions={[]} />);

    // Assert
    const empty = must(view.container.querySelector('[data-project-boards="empty"]'), 'the empty note');
    expect(empty.textContent).toContain('None of this project’s sessions currently exposes a board');
    expect(view.container.querySelector('ul')).toBeNull();
  });

  it('names each session that carries a board and the access it carries it with', async () => {
    // Arrange
    const sessions = [
      sessionView('s-1', { config: { name: 'Port the hub', boardAccess: 'read' } }),
      sessionView('s-2', { config: { name: 'Wire the route', boardAccess: 'worker' } }),
    ];

    // Act
    const view = await show(<ProjectBoards sessions={sessions} />);

    // Assert
    const rows = [...view.container.querySelectorAll('li')].map(row => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Port the hub');
    expect(rows[0]).toContain('read access · s-1');
    expect(rows[1]).toContain('Wire the route');
    expect(rows[1]).toContain('worker access · s-2');
    expect(must(view.container.querySelector('ul'), 'the list').getAttribute('data-project-boards')).toBe('ready');
  });
});
