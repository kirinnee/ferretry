import { describe, expect, test } from 'bun:test';

import { SessionTerminalSurface } from '../../src/components/session-terminal-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

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

describe('SessionTerminalSurface', () => {
  test('shows a paired-device snapshot without asking the loopback-only attach route', async () => {
    const page = render(
      <SessionTerminalSurface
        connection={alpha}
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
    expect(output).toContain('can mint a one-time terminal ticket');
    expect(output).toContain('no interactive terminal renderer');
    run(() => page.unmount());
  });

  test("never paints one daemon's proved pane after switching to another daemon with the same session id", async () => {
    const page = render(
      <SessionTerminalSurface
        connection={alpha}
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
    const page = render(
      <SessionTerminalSurface
        connection={alpha}
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
