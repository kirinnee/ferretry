import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';

import type { FleetClient } from '../../../../src/features/fleet/fleet-api.ts';
import {
  FleetConfigurationSurface,
  fleetSettingsTab,
} from '../../../../src/features/fleet/fleet-configuration-surface.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../../support/dom.ts';
import {
  absent,
  account,
  accountId,
  area,
  button,
  choose,
  chooser,
  click,
  config,
  field,
  manifest,
  permissions,
  pick,
  proposal,
  scaffoldProposal,
  type,
} from './fleet-support.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

const refusal = (code: string, message: string, status = 409): FyHttpError => new FyHttpError(message, status, code);

interface Script {
  permissions?: () => unknown;
  accounts?: () => unknown;
  config?: () => unknown;
  assets?: () => unknown;
  asset?: (path: string) => unknown;
  propose?: (body: unknown) => unknown;
  proposal?: () => unknown;
  apply?: (body: unknown) => unknown;
}

interface Call {
  readonly path: string;
  readonly body: unknown;
}

/** A daemon that answers exactly what a test scripted, and is loud about anything it did not. */
const fakeDaemon = (script: Script) => {
  const calls: Call[] = [];
  const answer = (path: string, body: unknown): unknown => {
    const tail = path.slice('/v1/fleet'.length);
    if (tail === '/permissions') return (script.permissions ?? (() => permissions()))();
    if (tail === '/accounts') return (script.accounts ?? (() => manifest()))();
    if (tail === '/config') return (script.config ?? (() => config()))();
    if (tail === '/assets') return (script.assets ?? (() => ({ files: [], complete: true })))();
    if (tail.startsWith('/assets/')) {
      if (script.asset === undefined) throw new Error(`no asset scripted for ${tail}`);
      return script.asset(decodeURIComponent(tail.slice('/assets/'.length)));
    }
    if (tail === '/proposals') {
      if (script.propose === undefined) throw new Error('no proposal scripted');
      return script.propose(body);
    }
    if (tail.endsWith('/apply')) {
      if (script.apply === undefined) throw new Error('no apply scripted');
      return script.apply(body);
    }
    if (script.proposal === undefined) throw new Error(`no route scripted for ${tail}`);
    return script.proposal();
  };
  const client: FleetClient = {
    request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
      calls.push({ path, body });
      return schema.parse(answer(path, body));
    },
  };
  return { client, calls, paths: () => calls.map(call => call.path) };
};

const open = async (script: Script, connection = laptop) => {
  const daemon = fakeDaemon(script);
  const mounted = await mount(
    <FleetConfigurationSurface connection={connection} createClient={async () => daemon.client} />,
  );
  // The first read is three awaited round trips deep; one more flush settles them all.
  await interact(() => undefined);
  return { ...mounted, daemon };
};

describe('reading one daemon fleet', () => {
  it('renders the accounts a daemon positively published, and nothing it did not', async () => {
    const surface = await open({});
    expect(pick(surface.container, '[data-fleet-configuration]').getAttribute('data-fleet-daemon-id')).toBe(
      'daemon/laptop',
    );
    expect(surface.container.textContent).toContain('claude-studio');
    expect(surface.container.textContent).toContain('Last published manifest');
    expect(absent(surface.container, '[data-fleet-state]')).toBe(true);
    // M5: this renders inside a settings tab panel whose page already owns the <h1>.
    expect(surface.container.querySelectorAll('h1')).toHaveLength(0);
    expect(pick(surface.container, '#fleet-configuration-heading').tagName).toBe('H2');
    // L10: the live region is permanent, so its text can change where a screen reader is listening.
    expect(pick(surface.container, '[data-fleet-announcement]').getAttribute('role')).toBe('status');
    await surface.unmount();
  });

  it('shows a published manifest with no accounts as an observed empty fleet', async () => {
    const surface = await open({ accounts: () => manifest([]) });
    expect(pick(surface.container, '[data-fleet-live-empty]').textContent).toContain('observed empty fleet');
    await surface.unmount();
  });

  it('keeps a first run, an unpublished fleet, a damaged one and a refused one apart', async () => {
    const first = await open({
      accounts: () => {
        throw refusal('fleet_not_applied', 'no published fleet manifest at /m; apply the fleet first');
      },
      config: () => {
        throw refusal('fleet_config_missing', 'no fleet config at /c; write the declared config before applying');
      },
    });
    expect(pick(first.container, '[data-fleet-state]').getAttribute('data-fleet-state')).toBe('uninitialized');
    expect(first.container.textContent).toContain('no fleet config at /c');
    await first.unmount();

    const unpublished = await open({
      accounts: () => {
        throw refusal('fleet_not_applied', 'no published fleet manifest');
      },
    });
    expect(pick(unpublished.container, '[data-fleet-state]').getAttribute('data-fleet-state')).toBe('not-applied');
    await unpublished.unmount();

    const damaged = await open({
      accounts: () => {
        throw refusal('fleet_manifest_invalid', 'fleet manifest at /m is unreadable or invalid');
      },
    });
    const state = pick(damaged.container, '[data-fleet-state]');
    expect(state.getAttribute('data-fleet-state')).toBe('damaged');
    expect(state.textContent).toContain('NOT an empty fleet');
    expect(absent(damaged.container, '[data-fleet-side="live"]')).toBe(true);
    await damaged.unmount();

    const forbidden = await open({
      accounts: () => {
        throw refusal('forbidden', 'a paired device may inspect the fleet but may not apply it', 403);
      },
      permissions: () => {
        throw refusal('forbidden', 'no', 403);
      },
    });
    expect(pick(forbidden.container, '[data-fleet-state]').getAttribute('data-fleet-state')).toBe('forbidden');
    expect(pick(forbidden.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'read-only',
    );
    expect(forbidden.container.textContent).toContain('cannot stage a change');
    await forbidden.unmount();
  });

  it('says a daemon that never answered is unreachable rather than empty', async () => {
    const mounted = await mount(
      <FleetConfigurationSurface
        connection={laptop}
        createClient={async () => {
          throw new Error('the relay did not connect');
        }}
      />,
    );
    await interact(() => undefined);
    expect(pick(mounted.container, '[data-fleet-state]').getAttribute('data-fleet-state')).toBe('unreachable');
    expect(mounted.container.textContent).toContain('the relay did not connect');
    await mounted.unmount();
  });

  it('reads the authority the daemon reports rather than assuming one', async () => {
    const host = await open({
      permissions: () => permissions({ mayApplyDirectly: true, mayApplyWithApproval: false }),
    });
    expect(pick(host.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'direct',
    );
    await host.unmount();
  });
});

describe('creating an account', () => {
  /** Fills a draft that resolves every problem, so the preview control is actually reachable. */
  const draftIn = async (surface: Awaited<ReturnType<typeof open>>): Promise<void> => {
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await type(field(surface.container, '-account-name'), 'atelier');
    await type(area(surface.container, '-account-models'), 'claude-opus-5');
    await type(field(surface.container, '-instructions-path'), 'instructions/atelier.md');
    await type(area(surface.container, '-instructions-text'), '# atelier');
    await choose(chooser(surface.container, '-account-default-model'), 'claude-opus-5');
  };

  it('suggests the harness the existing evidence points at, without restating the policy', async () => {
    const surface = await open({ accounts: () => manifest([account({ kind: 'codex', wrapper: 'codex-only' })]) });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    expect(
      pick(surface.container, '[data-fleet-harness-choice="codex"]').getAttribute('data-fleet-harness-selected'),
    ).toBe('true');
    expect(pick(surface.container, '[data-fleet-derived-wrapper]').textContent).toBe('codex-');
    await surface.unmount();
  });

  it('sends one named mutation with its asset text and shows the daemon plan that came back', async () => {
    const surface = await open({ propose: () => proposal() });
    await draftIn(surface);
    await click(button(surface.container, 'Preview this change'));

    const sent = surface.daemon.calls.find(call => call.path.endsWith('/proposals'))?.body as {
      mutation: Record<string, unknown>;
      assetEdits: readonly { path: string; content: string }[];
    };
    expect(sent.mutation).toMatchObject({
      kind: 'create-account',
      harness: 'claude',
      name: 'atelier',
      variant: 'default',
      models: ['claude-opus-5'],
      defaultModel: 'claude-opus-5',
      layer: { memory: 'instructions/atelier.md' },
    });
    expect(sent.assetEdits).toEqual([{ path: 'instructions/atelier.md', content: '# atelier' }]);
    // No account id is ever sent: the daemon mints identity.
    expect(Object.keys(sent.mutation)).not.toContain('id');
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    expect(surface.container.textContent).toContain('01');
    await surface.unmount();
  });

  it('keeps a refused derivation as the daemon worded it, without a proposal', async () => {
    const surface = await open({
      propose: () => {
        throw refusal(
          'fleet_proposal_refused',
          'the resulting fleet configuration would be invalid:\nagents.0.routes.default.home: duplicate home',
        );
      },
    });
    await draftIn(surface);
    await click(button(surface.container, 'Preview this change'));
    const alert = pick(surface.container, '[data-fleet-refusal="refused"]');
    expect(alert.textContent).toContain('duplicate home');
    expect(pick(surface.container, '[data-fleet-refusal] pre').textContent?.split('\n')).toHaveLength(2);
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    await surface.unmount();
  });
});

describe('editing one account layer', () => {
  it('loads every asset the layer references, not just the instructions file', async () => {
    const surface = await open({
      config: () =>
        config({
          default: {
            id: account().id,
            wrapper: 'claude-studio',
            layer: {
              memory: 'instructions/studio.md',
              skills: 'skills/studio',
              settings: { model: 'opus' },
              env: { FY_LANE: 'studio' },
            },
          },
        }),
      assets: () => ({
        files: [
          { path: 'instructions/studio.md', bytes: 6, readable: true },
          { path: 'skills/studio/review.md', bytes: 4, readable: true },
          { path: 'instructions/other.md', bytes: 4, readable: true },
        ],
        complete: true,
      }),
      asset: path => ({ path, content: `text of ${path}`, bytes: 10 }),
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);

    expect(area(surface.container, '-instructions-text').value).toBe('text of instructions/studio.md');
    expect(field(surface.container, '-skill-path-0').value).toBe('skills/studio/review.md');
    expect(area(surface.container, '-skill-text-0').value).toBe('text of skills/studio/review.md');
    expect(JSON.parse(area(surface.container, '-settings-text').value)).toEqual({ model: 'opus' });
    expect(field(surface.container, '-env-name-0').value).toBe('FY_LANE');
    // A file in the tree that this layer does not reference is not pulled in.
    expect(absent(surface.container, '[id$="-skill-path-1"]')).toBe(true);
    await surface.unmount();
  });

  it('refuses to stage while an asset it would overwrite could not be read', async () => {
    const surface = await open({
      config: () =>
        config({
          default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/studio' } },
        }),
      assets: () => ({
        files: [
          { path: 'skills/studio/huge.md', bytes: 999_999, readable: false, reason: 'over the 65536-byte limit' },
          { path: 'skills/studio/ok.md', bytes: 4, readable: true },
        ],
        complete: true,
      }),
      asset: () => {
        throw refusal('fleet_asset_refused', 'asset "skills/studio/ok.md" is not editable text');
      },
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);

    expect(surface.container.textContent).toContain('over the 65536-byte limit');
    expect(surface.container.textContent).toContain('overwrite text this browser never saw');
    expect(surface.container.textContent).toContain('is not editable text');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('refuses to stage when the declared instructions file is not in the index at all', async () => {
    const surface = await open({
      config: () =>
        config({
          default: { id: account().id, wrapper: 'claude-studio', layer: { memory: 'instructions/studio.md' } },
        }),
      // The walk lists other things and not this one. Absent, or simply not reached — the editor cannot
      // tell from here, so it must ATTEMPT the read rather than treat an empty box as the contents.
      assets: () => ({ files: [{ path: 'instructions/other.md', bytes: 4, readable: true }], complete: true }),
      asset: path => {
        throw refusal('fleet_asset_refused', `no asset at "${path}" in this daemon's asset tree`);
      },
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);

    expect(surface.daemon.paths()).toContain('/v1/fleet/assets/instructions%2Fstudio.md');
    expect(surface.container.textContent).toContain('no asset at "instructions/studio.md"');
    expect(surface.container.textContent).toContain('overwrite text this browser never saw');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('treats an asset tree it could not even list as unknown rather than empty', async () => {
    const surface = await open({
      config: () =>
        config({ default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/studio' } } }),
      assets: () => {
        throw refusal('fleet_asset_refused', 'the fleet asset directory is not readable');
      },
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('fleet/assets');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('opens an account with no declared assets immediately, with nothing to read', async () => {
    const surface = await open({ propose: () => proposal({ summary: 'change claude-studio' }) });
    await click(button(surface.container, 'Edit layer'));
    expect(absent(surface.container, '[data-fleet-layer-loading]')).toBe(true);
    expect(surface.daemon.paths().some(path => path.includes('/assets'))).toBe(false);

    await type(field(surface.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(surface.container, 'Preview this change'));
    expect(surface.daemon.calls.find(call => call.path.endsWith('/proposals'))?.body).toEqual({
      mutation: {
        kind: 'edit-account',
        accountId: account().id,
        // A patch: the one concern that was filled in, and an explicit removal for the three that were not.
        layer: { memory: 'instructions/studio.md', skills: null, settings: null, env: null },
      },
      assetEdits: [{ path: 'instructions/studio.md', content: '' }],
    });
    await surface.unmount();
  });

  it('discards a draft without asking the daemon anything', async () => {
    const surface = await open({});
    await click(button(surface.container, 'Edit layer'));
    await click(button(surface.container, 'Discard draft'));
    expect(absent(surface.container, '[data-fleet-layer-form]')).toBe(true);
    await surface.unmount();
  });
});

describe('authorizing and applying one exact proposal', () => {
  const staged = async (script: Script) => {
    const surface = await open({ propose: () => proposal(), ...script });
    await click(button(surface.container, 'Edit layer'));
    await type(field(surface.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(surface.container, 'Preview this change'));
    return surface;
  };

  it('shows the exact host command for that proposal and never a token', async () => {
    const surface = await staged({});
    expect(pick(surface.container, '[data-fleet-authority="approval"] pre').textContent).toBe(
      'fy fleet authorize fy_fprop_AAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(surface.container.textContent).not.toContain('token-laptop');
    await surface.unmount();
  });

  it('will not spend an attempt on something that is not a code', async () => {
    const surface = await staged({});
    await type(field(surface.container, '-approval-code'), 'nope');
    await click(pick(surface.container, '[data-fleet-apply]'));
    expect(surface.daemon.paths().some(path => path.endsWith('/apply'))).toBe(false);
    expect(surface.container.textContent).toContain('no attempt was spent');
    await surface.unmount();
  });

  it('applies with the normalised code, then re-reads the daemon rather than patching the list', async () => {
    let published = manifest();
    const surface = await staged({
      accounts: () => published,
      apply: () => {
        published = manifest([account({ id: accountId(4), wrapper: 'claude-atelier', displayName: 'Atelier' })]);
        return {
          outcome: 'committed',
          result: { accountCount: 1, operationCount: 4, manifestPath: '/m', prunedWrappers: [], sharedHistory: [] },
        };
      },
    });
    await type(field(surface.container, '-approval-code'), '7f3k m9qw');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    const applied = surface.daemon.calls.find(call => call.path.endsWith('/apply'));
    expect(applied?.body).toEqual({ approvalCode: '7F3K-M9QW' });
    expect(pick(surface.container, '[data-fleet-outcome]').getAttribute('data-fleet-outcome')).toBe('committed');
    // The roster is what the daemon now says, not what the browser hoped.
    expect(surface.container.textContent).toContain('claude-atelier');
    expect(surface.daemon.paths().filter(path => path.endsWith('/accounts'))).toHaveLength(2);
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    await surface.unmount();
  });

  it('reports a rollback that could not be verified, and still re-reads the host', async () => {
    const surface = await staged({
      apply: () => ({
        outcome: 'rollback-incomplete',
        failedOperation: 'settings /homes/studio/settings.json',
        reason: 'no space left on device',
        unrestored: [{ path: '/homes/studio/settings.json', reason: 'rename failed', backup: '/tmp/s.bak' }],
      }),
    });
    await type(field(surface.container, '-approval-code'), '7F3K-M9QW');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(pick(surface.container, '[data-fleet-outcome]').getAttribute('data-fleet-outcome')).toBe(
      'rollback-incomplete',
    );
    expect(surface.container.textContent).toContain('/tmp/s.bak');
    expect(surface.daemon.paths().filter(path => path.endsWith('/accounts'))).toHaveLength(2);
    await surface.unmount();
  });

  it('reports a fleet that landed with a failed history step as landed', async () => {
    const surface = await staged({
      apply: () => ({
        outcome: 'committed-with-history-failure',
        failedHarness: 'claude',
        reason: 'pool /pool/claude is not writable',
        committed: {
          accountCount: 2,
          operationCount: 9,
          manifestPath: '/m',
          manifest: manifest(),
          prunedWrappers: [],
          sharedHistory: [],
        },
      }),
    });
    await type(field(surface.container, '-approval-code'), '7F3K-M9QW');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('The fleet DID land');
    expect(surface.container.textContent).toContain('Do not re-apply');
    await surface.unmount();
  });

  it('keeps the proposal applicable when the daemon refused the code', async () => {
    const surface = await staged({
      apply: () => {
        throw refusal('fleet_proposal_unauthorized', 'that approval code is not the one minted for this proposal');
      },
    });
    await type(field(surface.container, '-approval-code'), '7F3K-M9QW');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('not the one minted');
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    await surface.unmount();
  });

  it('stops offering a proposal the daemon no longer holds', async () => {
    const surface = await staged({
      apply: () => {
        throw refusal('fleet_proposal_stale', 'the fleet configuration changed on this host after this was previewed');
      },
    });
    await type(field(surface.container, '-approval-code'), '7F3K-M9QW');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('changed on this host');
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    await surface.unmount();
  });

  it('reports a 403 raced at apply time truthfully', async () => {
    const surface = await staged({
      apply: () => {
        throw refusal('forbidden', 'a paired device may inspect the fleet but may not apply it', 403);
      },
    });
    await type(field(surface.container, '-approval-code'), '7F3K-M9QW');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(pick(surface.container, '[data-fleet-refusal="forbidden"]').textContent).toContain('may not apply');
    await surface.unmount();
  });

  it('re-reads the held proposal to learn an approval is now outstanding', async () => {
    const surface = await staged({
      proposal: () => proposal({ approval: { outstanding: true, expiresAt: '2026-08-05T06:02:00.000Z' } }),
    });
    await click(button(surface.container, 'Check for approval'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('An approval is outstanding until');
    await surface.unmount();
  });

  it('keeps a refusal from the re-read visible', async () => {
    const surface = await staged({
      proposal: () => {
        throw refusal('fleet_proposal_expired', 'this proposal expired; review the change again');
      },
    });
    await click(button(surface.container, 'Check for approval'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('expired');
    // And retires it: learning the proposal is gone and then leaving an enabled Apply bound to its id
    // would be the worst of both answers.
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    await surface.unmount();
  });

  it('keeps the proposal when the re-read merely refused, rather than saying it is gone', async () => {
    const surface = await staged({
      proposal: () => {
        throw refusal('fleet_asset_refused', 'the asset tree is not readable right now');
      },
    });
    await click(button(surface.container, 'Check for approval'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('not readable right now');
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    await surface.unmount();
  });

  it('discards a staged change without touching the host', async () => {
    const surface = await staged({});
    await click(button(surface.container, 'Discard'));
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    expect(surface.daemon.paths().some(path => path.endsWith('/apply'))).toBe(false);
    await surface.unmount();
  });
});

describe('a first run', () => {
  it('previews the scaffold through the daemon and applies it', async () => {
    const surface = await open({
      accounts: () => {
        throw refusal('fleet_not_applied', 'no published fleet manifest');
      },
      config: () => {
        throw refusal('fleet_config_missing', 'no fleet config at /c');
      },
      permissions: () => permissions({ mayApplyDirectly: true, mayApplyWithApproval: false }),
      propose: () => scaffoldProposal(),
      // Preparing a host is its OWN outcome. Reporting it as a committed apply of zero accounts would
      // tell a person their fleet is empty rather than that it is now ready.
      apply: () => ({
        outcome: 'initialized',
        created: ['/home/pilot/.ferretry/fleet/config.yaml', '/home/pilot/.ferretry/fleet/bin/.keep'],
        kept: ['/home/pilot/.ferretry/fleet/assets/instructions/shared.md'],
        directories: ['/home/pilot/.ferretry/fleet', '/home/pilot/.ferretry/fleet/bin'],
        pathEntry: 'export PATH="$HOME/.ferretry/fleet/bin:$PATH"',
      }),
    });
    await click(pick(surface.container, '[data-fleet-start-initialize]'));
    expect(surface.daemon.calls.find(call => call.path.endsWith('/proposals'))?.body).toEqual({
      mutation: { kind: 'initialize' },
    });
    expect(surface.container.textContent).toContain('First run');
    expect(surface.container.textContent).toContain('never replaces a file');

    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(pick(surface.container, '[data-fleet-outcome]').getAttribute('data-fleet-outcome')).toBe('initialized');
    expect(surface.container.textContent).toContain('Host prepared');
    expect(surface.container.textContent).toContain('NO fleet manifest has been published yet');
    expect(surface.container.textContent).toContain('kept 1 that already existed');
    await surface.unmount();
  });
});

describe('two daemons', () => {
  it('drops every draft, proposal and result when the daemon changes', async () => {
    const laptopDaemon = fakeDaemon({ propose: () => proposal() });
    const workstationDaemon = fakeDaemon({
      accounts: () =>
        manifest([account({ id: accountId(8), wrapper: 'claude-workstation', displayName: 'Workstation' })]),
    });
    const clientFor = async (connection: typeof laptop) =>
      connection.daemonId === laptop.daemonId ? laptopDaemon.client : workstationDaemon.client;

    const mounted = await mount(<FleetConfigurationSurface connection={laptop} createClient={clientFor} />);
    await interact(() => undefined);
    await click(button(mounted.container, 'Edit layer'));
    await type(field(mounted.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(mounted.container, 'Preview this change'));
    await type(field(mounted.container, '-approval-code'), '7F3K-M9QW');
    expect(pick(mounted.container, '[data-fleet-proposal-id]')).toBeDefined();

    await mounted.render(<FleetConfigurationSurface connection={workstation} createClient={clientFor} />);
    await interact(() => undefined);

    expect(pick(mounted.container, '[data-fleet-configuration]').getAttribute('data-fleet-daemon-id')).toBe(
      'daemon/workstation',
    );
    expect(mounted.container.textContent).toContain('claude-workstation');
    expect(mounted.container.textContent).not.toContain('claude-studio');
    expect(absent(mounted.container, '[data-fleet-proposal-id]')).toBe(true);
    expect(absent(mounted.container, '[data-fleet-layer-form]')).toBe(true);
    expect(absent(mounted.container, '[id$="-approval-code"]')).toBe(true);
    expect(workstationDaemon.paths().some(path => path.endsWith('/apply'))).toBe(false);
    await mounted.unmount();
  });
});

describe('one daemon id, two credentials', () => {
  it('drops a read still in flight when the address or token changes under the same id', async () => {
    const stale = fakeDaemon({ accounts: () => manifest([account({ wrapper: 'claude-stale' })]) });
    const fresh = fakeDaemon({ accounts: () => manifest([account({ id: accountId(7), wrapper: 'claude-fresh' })]) });
    // The first client is handed over only after the connection has already been replaced, which is
    // exactly the race a daemon-id-only guard lets through.
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let opened = 0;
    const clientFor = async (): Promise<FleetClient> => {
      opened += 1;
      if (opened === 1) {
        await held;
        return stale.client;
      }
      return fresh.client;
    };

    const rekeyed = daemonConnection({
      daemonId: 'daemon/laptop',
      baseUrl: 'https://laptop.example.test',
      deviceToken: 'token-rotated',
    });

    const mounted = await mount(<FleetConfigurationSurface connection={laptop} createClient={clientFor} />);
    await mounted.render(<FleetConfigurationSurface connection={rekeyed} createClient={clientFor} />);
    await interact(() => release?.());
    await interact(() => undefined);

    expect(mounted.container.textContent).toContain('claude-fresh');
    expect(mounted.container.textContent).not.toContain('claude-stale');
    await mounted.unmount();
  });
});

describe('an equivalent connection object', () => {
  it('is not a new connection: no reset, no second read, and the draft survives', async () => {
    const daemon = fakeDaemon({});
    let opened = 0;
    const clientFor = async (): Promise<FleetClient> => {
      opened += 1;
      return daemon.client;
    };
    const mounted = await mount(<FleetConfigurationSurface connection={laptop} createClient={clientFor} />);
    await interact(() => undefined);
    await click(button(mounted.container, 'Edit layer'));
    await type(field(mounted.container, '-instructions-path'), 'instructions/studio.md');

    // A caller that rebuilds an equal object each render has NOT re-paired. `sameDaemonConnection`
    // compares field by field for exactly this reason; object identity would throw the draft away.
    const rebuilt = daemonConnection({
      daemonId: 'daemon/laptop',
      baseUrl: 'https://laptop.example.test',
      deviceToken: 'token-laptop',
    });
    expect(rebuilt).not.toBe(laptop);
    await mounted.render(<FleetConfigurationSurface connection={rebuilt} createClient={clientFor} />);
    await interact(() => undefined);

    expect(opened).toBe(1);
    expect(daemon.paths().filter(path => path.endsWith('/accounts'))).toHaveLength(1);
    expect(field(mounted.container, '-instructions-path').value).toBe('instructions/studio.md');
    await mounted.unmount();
  });
});

describe('an ABA connection switch', () => {
  it('drops the FIRST session read even when the connection returns to identical credentials', async () => {
    const first = fakeDaemon({ accounts: () => manifest([account({ wrapper: 'claude-first-a' })]) });
    const other = fakeDaemon({ accounts: () => manifest([account({ id: accountId(2), wrapper: 'claude-b' })]) });
    const third = fakeDaemon({ accounts: () => manifest([account({ id: accountId(3), wrapper: 'claude-third-a' })]) });
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let opened = 0;
    const clientFor = async (): Promise<FleetClient> => {
      opened += 1;
      if (opened === 1) {
        // The original A's client arrives only after A → B → A has already happened.
        await held;
        return first.client;
      }
      return opened === 2 ? other.client : third.client;
    };

    const mounted = await mount(<FleetConfigurationSurface connection={laptop} createClient={clientFor} />);
    await mounted.render(<FleetConfigurationSurface connection={workstation} createClient={clientFor} />);
    // Back to a connection whose daemon id, address and token are all identical to the first.
    await mounted.render(<FleetConfigurationSurface connection={laptop} createClient={clientFor} />);
    await interact(() => release?.());
    await interact(() => undefined);

    expect(mounted.container.textContent).toContain('claude-third-a');
    expect(mounted.container.textContent).not.toContain('claude-first-a');
    expect(mounted.container.textContent).not.toContain('claude-b');
    // And the thing that distinguishes the sessions is never the credential: no token, and no
    // token-derived key, reaches the rendered markup.
    expect(mounted.container.innerHTML).not.toContain('token-laptop');
    expect(mounted.container.innerHTML).not.toContain('token-workstation');
    expect(mounted.container.innerHTML).not.toContain(laptop.baseUrl);
    await mounted.unmount();
  });
});

describe('the mounted settings tab', () => {
  it('is one definition the composition root can mount as it stands', async () => {
    const daemon = fakeDaemon({});
    const tab = fleetSettingsTab(async () => daemon.client);
    expect(tab.id).toBe('fleet');
    expect(tab.label).toBe('Fleet');
    const mounted = await mount(<tab.Surface connection={laptop} />);
    await interact(() => undefined);
    expect(pick(mounted.container, '[data-fleet-configuration]')).toBeDefined();
    await mounted.unmount();
  });
});

describe('the declared limits', () => {
  it('are on screen rather than in a document nobody opens', async () => {
    const surface = await open({});
    expect(surface.container.textContent).toContain('YAML comments');
    expect(surface.container.textContent).toContain('MERGED');
    await surface.unmount();
  });
});
