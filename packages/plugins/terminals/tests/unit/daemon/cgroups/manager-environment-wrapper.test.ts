import { describe, it } from 'bun:test';
import should from 'should';
import { agentScopeCommand, MANAGER_ENVIRONMENT_NAMES } from '../../../../daemon/lib/cgroups/index.ts';

const BASE = { scope: 's.scope', slice: 'f.slice', properties: [], command: ['sh'] } as const;

describe('the scope wrapper’s own manager environment', () => {
  it('should start `systemd-run` under `env` with the two manager names and nothing else', () => {
    // Act
    const argv = agentScopeCommand({
      ...BASE,
      environment: {
        XDG_RUNTIME_DIR: '/run/user/1',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus',
        GH_TOKEN: 'x',
      },
    });

    // Assert
    should(argv.slice(0, 4)).deepEqual([
      'env',
      'XDG_RUNTIME_DIR=/run/user/1',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1/bus',
      'systemd-run',
    ]);
    should(argv.join(' ')).not.containEql('GH_TOKEN');
  });

  it('should be unchanged with no environment, or with empty values', () => {
    should(agentScopeCommand(BASE)[0]).equal('systemd-run');
    should(agentScopeCommand({ ...BASE, environment: { XDG_RUNTIME_DIR: '' } })[0]).equal('systemd-run');
  });

  it('should name the same two variables as the kernel gives a manager program', () => {
    should([...MANAGER_ENVIRONMENT_NAMES]).deepEqual(['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
  });
});
