import { describe, expect, it } from 'bun:test';
import type { IFyApiClient, WardenConfigView, WardenStatusView } from '@ferretry/protocol';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  editableWardenConfig,
  wardenAccountHealth,
  wardenConfigPatch,
  WardenConfigCard,
  WardenConfigSurface,
} from '../../../src/features/warden/warden-config-card.tsx';
import { wardenFailover, wardenStatus } from '../../support/warden.ts';
import { render, run, runAsync } from '../../support/react.ts';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceToken: `token-${id}` });
const view = (agent = 'claude-auto-loge'): WardenConfigView => ({
  config: { ...wardenStatus().config, accounts: [{ agent }] },
  accounts: [{ agent }],
  warnings: ['Account order is applied on the next sweep.'],
});

describe('WardenConfigCard', () => {
  it('preserves account health, ordering and the live failover patch', () => {
    const saved: unknown[] = [];
    const renderer = render(
      <WardenConfigCard
        connection={connection('a')}
        view={view()}
        failover={wardenFailover()}
        availableAccounts={[{ agent: 'codex-auto-terra' }]}
        onSave={patch => {
          saved.push(patch);
        }}
      />,
    );

    run(() =>
      renderer.root
        .findByProps({ 'aria-label': 'Add warden account' })
        .props.onChange({ target: { value: 'codex-auto-terra' } }),
    );
    run(() => renderer.root.findByProps({ 'aria-label': 'Add selected warden account' }).props.onClick());
    run(() => renderer.root.findByProps({ 'aria-label': 'Move codex-auto-terra up' }).props.onClick());
    run(() =>
      renderer.root
        .findByProps({ 'aria-label': 'Enable LLM escalation' })
        .props.onChange({ target: { checked: false } }),
    );
    run(() => {
      const save = renderer.root.findAllByType('button').find(button => button.children.join('') === 'Save');
      if (!save) throw new Error('Save button is missing');
      save.props.onClick();
    });

    expect(saved).toEqual([
      {
        enabled: false,
        accounts: [{ agent: 'codex-auto-terra' }, { agent: 'claude-auto-loge' }],
        failover: { policy: 'fallback', failureThreshold: 3, cooldownMinutes: 30 },
      },
    ]);
    expect(renderer.root.findByProps({ 'data-testid': 'warden-config-card' }).type).toBe('section');
  });

  it('keeps view-derived helpers safe for missing or rejected health', () => {
    expect(editableWardenConfig(view()).accounts).toEqual([{ agent: 'claude-auto-loge' }]);
    expect(
      wardenConfigPatch({
        enabled: true,
        accounts: [{ agent: 'a' }],
        policy: 'fallback',
        failureThreshold: 0,
        cooldownMinutes: Number.NaN,
      }),
    ).toEqual({
      enabled: true,
      accounts: [{ agent: 'a' }],
      failover: { policy: 'fallback', failureThreshold: 1, cooldownMinutes: 1 },
    });
    expect(wardenAccountHealth({ agent: 'absent' }, undefined)).toEqual({ label: 'health unknown', tone: 'muted' });
    expect(
      wardenAccountHealth(
        { agent: 'claude-auto-loge' },
        wardenFailover({ accounts: [{ agent: 'claude-auto-loge', eligible: false, reason: 'at limit' }] }),
      ),
    ).toEqual({ label: 'at limit', tone: 'warn' });
  });

  it('removes an account without leaving a stale entry in the draft', () => {
    const renderer = render(
      <WardenConfigCard
        connection={connection('a')}
        view={view()}
        availableAccounts={[{ agent: 'codex-auto-terra' }]}
        onSave={() => {}}
      />,
    );

    run(() =>
      renderer.root
        .findByProps({ 'aria-label': 'Add warden account' })
        .props.onChange({ target: { value: 'codex-auto-terra' } }),
    );
    run(() => renderer.root.findByProps({ 'aria-label': 'Add selected warden account' }).props.onClick());
    run(() => renderer.root.findByProps({ 'aria-label': 'Remove codex-auto-terra' }).props.onClick());

    expect(renderer.root.findByProps({ 'aria-label': 'Warden accounts' }).children).toHaveLength(1);
    expect(renderer.root.findByProps({ 'aria-label': 'Remove claude-auto-loge' }).props.disabled).toBe(true);
  });

  it("drops a late daemon response instead of showing another daemon's configuration", async () => {
    let releaseA: ((value: WardenConfigView) => void) | undefined;
    const client = (
      response: Promise<WardenConfigView>,
    ): Pick<IFyApiClient, 'wardenConfig' | 'wardenStatus' | 'updateWardenConfig'> => ({
      wardenConfig: () => response,
      wardenStatus: async () => wardenStatus() as WardenStatusView,
      updateWardenConfig: async () => view(),
    });
    const lateA = new Promise<WardenConfigView>(resolve => {
      releaseA = resolve;
    });
    const createClient = (active: ReturnType<typeof connection>) =>
      Promise.resolve(active.daemonId === 'a' ? client(lateA) : client(Promise.resolve(view('codex-auto-terra'))));
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={createClient} />);
    run(() => renderer.update(<WardenConfigSurface connection={connection('b')} createClient={createClient} />));
    await runAsync(async () => {
      if (!releaseA) throw new Error('daemon A request did not begin');
      releaseA(view('claude-auto-loge'));
      await Promise.resolve();
    });
    await runAsync(async () => {
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('codex-auto-terra');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('claude-auto-loge');
  });

  it('loads and saves only through the paired daemon client', async () => {
    const updateCalls: unknown[] = [];
    const nextView = view('codex-auto-terra');
    const client: Pick<IFyApiClient, 'wardenConfig' | 'wardenStatus' | 'updateWardenConfig'> = {
      wardenConfig: async () => view(),
      wardenStatus: async () => wardenStatus() as WardenStatusView,
      updateWardenConfig: async patch => {
        updateCalls.push(patch);
        return nextView;
      },
    };
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={async () => client} />);
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    run(() =>
      renderer.root
        .findByProps({ 'aria-label': 'Enable LLM escalation' })
        .props.onChange({ target: { checked: false } }),
    );
    const save = renderer.root.findAllByType('button').find(button => button.children.join('') === 'Save');
    if (!save) throw new Error('Save button is missing');
    await runAsync(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateCalls).toEqual([
      {
        enabled: false,
        accounts: [{ agent: 'claude-auto-loge' }],
        failover: { policy: 'fallback', failureThreshold: 3, cooldownMinutes: 30 },
      },
    ]);
    expect(JSON.stringify(renderer.toJSON())).toContain('Saved — the next sweep uses this configuration.');
  });

  it('hides an unavailable editor and reports a save rejection in the rendered card', async () => {
    const unavailable = render(
      <WardenConfigSurface
        connection={connection('a')}
        createClient={async () => Promise.reject(new Error('older daemon'))}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unavailable.toJSON()).toBeNull();

    const client: Pick<IFyApiClient, 'wardenConfig' | 'wardenStatus' | 'updateWardenConfig'> = {
      wardenConfig: async () => view(),
      wardenStatus: async () => wardenStatus() as WardenStatusView,
      updateWardenConfig: async () => Promise.reject(new Error('save refused')),
    };
    const renderer = render(<WardenConfigSurface connection={connection('a')} createClient={async () => client} />);
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    run(() =>
      renderer.root
        .findByProps({ 'aria-label': 'Enable LLM escalation' })
        .props.onChange({ target: { checked: false } }),
    );
    const save = renderer.root.findAllByType('button').find(button => button.children.join('') === 'Save');
    if (!save) throw new Error('Save button is missing');
    await runAsync(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('save refused');
  });
});
