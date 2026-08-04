import { describe, expect, test } from 'bun:test';

import { SessionTerminalSurface } from '../../src/components/session-terminal-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
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
  test('labels the real daemon-proved tmux pane and states the interactive-ticket gap', async () => {
    const page = render(
      <SessionTerminalSurface
        client={{ attachTarget: async () => ({ tmuxSession: 'fy-alpha-proof' }) } as never}
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
    expect(page.root.findByProps({ title: 'fy-alpha-proof' }).children.join('')).toBe('tmux: fy-alpha-proof');
    expect(output).toContain('alpha:shared:snapshot');
    expect(output).toContain('does not mint a one-time stream ticket');
    run(() => page.unmount());
  });

  test("never paints one daemon's proved pane after switching to another daemon with the same session id", async () => {
    const page = render(
      <SessionTerminalSurface
        client={{ attachTarget: async () => ({ tmuxSession: 'fy-alpha-proof' }) } as never}
        connection={alpha}
        readSnapshot={async () => 'alpha output'}
        scope={daemonSessionScope(alpha, 'shared')}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(page.toJSON())).toContain('fy-alpha-proof');

    run(() =>
      page.update(
        <SessionTerminalSurface
          client={{ attachTarget: async () => await new Promise(() => undefined) } as never}
          connection={beta}
          readSnapshot={async () => 'beta output'}
          scope={daemonSessionScope(beta, 'shared')}
        />,
      ),
    );
    const switched = JSON.stringify(page.toJSON());
    expect(switched).toContain('Verifying the managed session pane');
    expect(switched).not.toContain('fy-alpha-proof');
    expect(switched).not.toContain('alpha output');
    run(() => page.unmount());
  });

  test('reports attach evidence failure instead of inventing a tmux identity', async () => {
    const page = render(
      <SessionTerminalSurface
        client={
          {
            attachTarget: async () => {
              throw new Error('pane registration is missing');
            },
          } as never
        }
        connection={alpha}
        readSnapshot={async () => 'must not render'}
        scope={daemonSessionScope(alpha, 'shared')}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const output = JSON.stringify(page.toJSON());
    expect(output).toContain('Could not verify this session');
    expect(output).toContain('pane registration is missing');
    expect(output).not.toContain('tmux:');
    run(() => page.unmount());
  });
});
