import { describe, expect, it } from 'bun:test';
import type { CgroupConfigView, IFyApiClient } from '@ferretry/protocol';
import {
  CgroupConfigCard,
  CgroupConfigSurface,
  cgroupConfigPatch,
  editableCgroupConfig,
} from '../../../src/features/settings/cgroup-settings.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../../support/react.ts';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });

const view = (supported = true): CgroupConfigView => ({
  config: {
    enabled: true,
    fleet: { cpuPercent: 80, memoryPercent: 80 },
    perAgent: { cpuPercent: 40, memoryPercent: 40 },
  },
  supported,
  fleetSlice: 'ferretry-fleet.slice',
  effective: {
    cpus: 8,
    memoryBytes: 8_000_000,
    fleet: { cpuQuota: '640%', memoryMax: '6400000' },
    perAgent: { cpuQuota: '320%', memoryMax: '3200000' },
  },
  restartRequiredSessions: ['agent-one'],
  warnings: ['scope agent-two could not be read'],
});

describe('CgroupConfigCard', () => {
  it('bounds an agent cap under the aggregate cap before saving', () => {
    expect(editableCgroupConfig(view()).agentCpuPercent).toBe(40);
    expect(
      cgroupConfigPatch({
        enabled: true,
        fleetCpuPercent: 30,
        fleetMemoryPercent: 25,
        agentCpuPercent: 70,
        agentMemoryPercent: Number.NaN,
      }),
    ).toEqual({
      enabled: true,
      fleet: { cpuPercent: 30, memoryPercent: 25 },
      perAgent: { cpuPercent: 30, memoryPercent: 1 },
    });
  });

  it('states restart and apply warnings rather than claiming success', () => {
    const renderer = render(<CgroupConfigCard connection={connection('a')} view={view()} onSave={() => {}} />);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Restart required before the change applies to: ');
    expect(text).toContain('agent-one');
    expect(text).toContain('Resource-limit warning: ');
    expect(text).toContain('scope agent-two could not be read');
    expect(text).toContain('daemon and Warden stay outside that slice');
  });

  it('offers only a safe disable action where enforcement is unavailable', async () => {
    const saved: unknown[] = [];
    const renderer = render(
      <CgroupConfigCard
        connection={connection('mac')}
        view={view(false)}
        onSave={patch => {
          saved.push(patch);
        }}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('unavailable on this platform');
    expect(text).not.toContain('Apply resource limits');
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(renderer.root.findAllByType('button')).toHaveLength(1);
    await runAsync(async () => {
      renderer.root.findAllByType('button')[0]?.props.onClick();
      await Promise.resolve();
    });
    expect(saved).toEqual([{ enabled: false }]);
  });

  it('renders no inert action when unsupported enforcement is already disabled', () => {
    const unsupported = view(false);
    const renderer = render(
      <CgroupConfigCard
        connection={connection('mac')}
        view={{ ...unsupported, config: { ...unsupported.config, enabled: false } }}
        onSave={() => {}}
      />,
    );
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(renderer.root.findAllByType('button')).toHaveLength(0);
  });

  it('keeps an unavailable daemon as unknown instead of treating it as uncapped', async () => {
    const renderer = render(
      <CgroupConfigSurface
        connection={connection('a')}
        createClient={async () => Promise.reject(new Error('older daemon'))}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('will not assume that limits are disabled or applied');
  });

  it('saves through the selected daemon only', async () => {
    const saved: unknown[] = [];
    const client: Pick<IFyApiClient, 'cgroupConfig' | 'updateCgroupConfig'> = {
      cgroupConfig: async () => view(),
      updateCgroupConfig: async patch => {
        saved.push(patch);
        return view();
      },
    };
    const renderer = render(<CgroupConfigSurface connection={connection('a')} createClient={async () => client} />);
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const inputs = renderer.root.findAllByType('input');
    await runAsync(async () => {
      inputs[1]?.props.onChange({ target: { value: '60' } });
      await Promise.resolve();
    });
    await runAsync(async () => {
      renderer.root.findAllByType('button')[0]?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saved).toEqual([
      { enabled: true, fleet: { cpuPercent: 60, memoryPercent: 80 }, perAgent: { cpuPercent: 40, memoryPercent: 40 } },
    ]);
    expect(JSON.stringify(renderer.toJSON())).toContain('Saved. Restart requirements');
  });

  it('reports a failed apply without treating the requested limits as active', async () => {
    const client: Pick<IFyApiClient, 'cgroupConfig' | 'updateCgroupConfig'> = {
      cgroupConfig: async () => view(),
      updateCgroupConfig: async () => Promise.reject(new Error('systemd user manager unavailable')),
    };
    const renderer = render(<CgroupConfigSurface connection={connection('a')} createClient={async () => client} />);
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await runAsync(async () => {
      renderer.root.findAllByType('input')[1]?.props.onChange({ target: { value: '60' } });
      await Promise.resolve();
    });
    await runAsync(async () => {
      renderer.root.findAllByType('button')[0]?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Apply failed: ');
    expect(text).toContain('systemd user manager unavailable');
    expect(text).toContain('may retain their prior limits');
  });

  it('cleans up an in-flight daemon read when the surface unmounts', async () => {
    let resolve: ((value: CgroupConfigView) => void) | undefined;
    const delayed = new Promise<CgroupConfigView>(next => {
      resolve = next;
    });
    const renderer = render(
      <CgroupConfigSurface
        connection={connection('a')}
        createClient={async () => ({ cgroupConfig: async () => delayed, updateCgroupConfig: async () => view() })}
      />,
    );
    run(() => renderer.unmount());
    await runAsync(async () => {
      resolve?.(view());
      await Promise.resolve();
    });
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('CgroupConfigCard while a save is in flight', () => {
  const spinning = (text: string): boolean => text.includes('animate-spin');

  it('shows a spinner on Apply and locks it while the limits are being applied', () => {
    const idle = render(<CgroupConfigCard connection={connection('a')} view={view()} onSave={() => {}} />);
    const busy = render(<CgroupConfigCard connection={connection('a')} view={view()} saving onSave={() => {}} />);

    expect(spinning(JSON.stringify(idle.toJSON()))).toBe(false);
    expect(spinning(JSON.stringify(busy.toJSON()))).toBe(true);
    const buttons = busy.root.findAllByType('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.disabled).toBe(true);
  });

  it('shows the same spinner on Disable where enforcement is unavailable but still saved as on', () => {
    const idle = render(<CgroupConfigCard connection={connection('mac')} view={view(false)} onSave={() => {}} />);
    const busy = render(
      <CgroupConfigCard connection={connection('mac')} view={view(false)} saving onSave={() => {}} />,
    );

    expect(spinning(JSON.stringify(idle.toJSON()))).toBe(false);
    expect(spinning(JSON.stringify(busy.toJSON()))).toBe(true);
    expect(busy.root.findAllByType('button')[0]?.props.disabled).toBe(true);
  });
});

describe('CgroupConfigCard when no session needs a restart', () => {
  it('says nothing about restarting', () => {
    const renderer = render(
      <CgroupConfigCard
        connection={connection('a')}
        view={{ ...view(), restartRequiredSessions: [] }}
        onSave={() => {}}
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).not.toContain('Restart required');
  });
});
