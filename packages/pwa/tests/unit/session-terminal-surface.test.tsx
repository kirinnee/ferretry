import { describe, expect, test } from 'bun:test';

import { SessionTerminalSurface } from '../../src/components/session-terminal-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { fakeDeck, terminalListing } from '../support/terminal-deck.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});

type Rendered = ReturnType<typeof render>;

/** The deck's canvas ref needs a measurable host; react-test-renderer has none. */
const mount = (element: Parameters<typeof render>[0]): Rendered =>
  render(element, { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400 }) });

describe('SessionTerminalSurface', () => {
  test('shows a paired-device snapshot without asking the loopback-only attach route', async () => {
    const page = mount(
      <SessionTerminalSurface
        connection={alpha}
        deck={fakeDeck(async () => terminalListing([])).dependencies}
        listTerminals={async () => terminalListing([])}
        readSnapshot={async (daemon, scope) => `${daemon.daemonId}:${scope.sessionId}:snapshot`}
        scope={daemonSessionScope(alpha, 'shared')}
      />,
    );

    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const output = JSON.stringify(page.toJSON());
    expect(output).toContain('managed session pane');
    expect(output).not.toContain('tmux: shared');
    expect(output).toContain('alpha:shared:snapshot');
    // The live deck is the surface's headline now, not a paragraph explaining
    // that there is not one.
    expect(output).toContain('No shell terminals open');
    expect(output).toContain('the agent’s own managed pane');
    run(() => page.unmount());
  });

  test("never paints one daemon's proved pane after switching to another daemon with the same session id", async () => {
    const page = mount(
      <SessionTerminalSurface
        connection={alpha}
        deck={fakeDeck(async () => terminalListing([])).dependencies}
        listTerminals={async () => terminalListing([])}
        readSnapshot={async () => 'alpha output'}
        scope={daemonSessionScope(alpha, 'shared')}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(page.toJSON())).toContain('alpha output');

    run(() =>
      page.update(
        <SessionTerminalSurface
          connection={beta}
          deck={fakeDeck(async () => terminalListing([])).dependencies}
          listTerminals={async () => terminalListing([])}
          readSnapshot={async () => 'beta output'}
          scope={daemonSessionScope(beta, 'shared')}
        />,
      ),
    );
    const switched = JSON.stringify(page.toJSON());
    expect(switched).toContain('(no snapshot yet)');
    expect(switched).not.toContain('alpha output');
    run(() => page.unmount());
  });

  test('reports a snapshot failure without inventing a tmux identity', async () => {
    const page = mount(
      <SessionTerminalSurface
        connection={alpha}
        deck={fakeDeck(async () => terminalListing([])).dependencies}
        listTerminals={async () => terminalListing([])}
        readSnapshot={async () => {
          throw new Error('snapshot unavailable');
        }}
        scope={daemonSessionScope(alpha, 'shared')}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const output = JSON.stringify(page.toJSON());
    expect(output).toContain('snapshot unavailable');
    expect(output).not.toContain('tmux:');
    run(() => page.unmount());
  });
});
