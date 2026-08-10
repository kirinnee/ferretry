import { afterEach, describe, expect, it } from 'bun:test';

import type { ReactElement } from 'react';

import { ProjectFiles } from '../../../src/features/projects/project-files.tsx';
import { SessionSearchProvider } from '../../../src/features/session-search/session-search.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount, type Mounted, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const daemon = daemonConnection({
  daemonId: 'workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'device-token',
});

/**
 * The shell wraps every daemon route in the shared current-session search
 * provider, and the file browser mounts that control. This suite supplies the
 * same provider with the SAME null scope a project route carries — a project is
 * not a session, so current-session search has nothing to be scoped to.
 */
const shell = (element: ReactElement): ReactElement => (
  <SessionSearchProvider connection={daemon} focusSignal={0} scope={null}>
    {element}
  </SessionSearchProvider>
);

// The file browser reads over the production `browserFetch`, so this suite
// replaces the global and puts it back. Bun runs the whole unit tier in ONE
// process, and a leaked stub would answer every later suite's requests.
const realFetch = globalThis.fetch;
const reads: string[] = [];

let open: Mounted | null = null;
const show = async (element: Parameters<typeof mount>[0]): Promise<Mounted> => {
  open = await mount(element);
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return open;
};

afterEach(async () => {
  await open?.unmount();
  open = null;
  globalThis.fetch = realFetch;
  reads.length = 0;
});

const answerFs = (): void => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    reads.push(String(url));
    return new Response(JSON.stringify({ path: '.', entries: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
};

describe('ProjectFiles', () => {
  it('refuses to browse a project root when the project has no session', async () => {
    // Arrange
    answerFs();

    // Act
    const view = await show(shell(<ProjectFiles connection={daemon} session={null} />));

    // Assert
    const note = must(view.container.querySelector('[data-project-files="unavailable"]'), 'the refusal');
    expect(note.textContent).toContain('Files are unavailable until this project has a session');
    expect(note.textContent).toContain('Ferretry does not browse a project root directly');
    // The refusal is the point: nothing was read from the daemon at all.
    expect(reads).toEqual([]);
  });

  it('roots the browser in the named session and addresses it to this daemon only', async () => {
    // Arrange
    answerFs();
    const session = sessionView('s-1', { config: { name: 'Port the hub', cwd: '/work/ferretry' } });

    // Act
    const view = await show(shell(<ProjectFiles connection={daemon} session={session} />));

    // Assert
    const pane = must(view.container.querySelector('[data-project-files="s-1"]'), 'the files pane');
    expect(pane.textContent).toContain('Files of most recently active session');
    expect(pane.textContent).toContain('Port the hub');
    // Every read is addressed to this daemon's base URL and to this session's
    // scope — a session id alone can never reach another daemon's tree.
    expect(reads.length).toBeGreaterThan(0);
    for (const url of reads) {
      expect(url.startsWith('https://workstation.example.test/')).toBe(true);
      expect(url).toContain('/sessions/s-1/');
    }
  });
});
