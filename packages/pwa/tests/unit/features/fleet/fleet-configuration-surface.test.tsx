import { afterEach, describe, expect, it } from 'bun:test';
import { OPERATOR_UNLOCK_HEADER } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';

import type { FleetClient } from '../../../../src/features/fleet/fleet-api.ts';
import {
  FleetConfigurationSurface,
  fleetSettingsTab,
} from '../../../../src/features/fleet/fleet-configuration-surface.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { grantGuidance, UNLOCK_LIMIT_NOTE } from '../../../../src/lib/grants.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import {
  absent,
  absentCodex,
  account,
  accountId,
  area,
  button,
  choose,
  chooser,
  click,
  config,
  confirmingPermissions,
  discovery,
  field,
  harness,
  lockedPermissions,
  manifest,
  permissions,
  pick,
  proposal,
  scaffoldProposal,
  type,
  unlockView,
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
  /** What this HOST has. Scripted by default, because every account form now opens from it. */
  harnesses?: () => unknown;
  assets?: () => unknown;
  asset?: (path: string) => unknown;
  propose?: (body: unknown) => unknown;
  proposal?: () => unknown;
  apply?: (body: unknown) => unknown;
  /**
   * `POST /v1/grants/unlock`, because the fleet panel now mints through the SAME route the grants
   * surface does rather than through a fleet-private authorization of its own.
   */
  unlock?: (body: unknown) => unknown;
}

interface Call {
  readonly path: string;
  readonly body: unknown;
  /** The headers the call carried, so a suite can prove where an unlock travelled. */
  readonly headers: Readonly<Record<string, string>> | undefined;
}

/** A daemon that answers exactly what a test scripted, and is loud about anything it did not. */
const fakeDaemon = (script: Script) => {
  const calls: Call[] = [];
  const answer = (path: string, body: unknown): unknown => {
    if (path === '/v1/grants/unlock') return (script.unlock ?? (() => unlockView()))(body);
    const tail = path.slice('/v1/fleet'.length);
    if (tail === '/permissions') return (script.permissions ?? (() => permissions()))();
    if (tail === '/accounts') return (script.accounts ?? (() => manifest()))();
    if (tail === '/config') return (script.config ?? (() => config()))();
    if (tail === '/harnesses') return (script.harnesses ?? (() => discovery()))();
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
      calls.push({ path, body, headers: init?.headers as Readonly<Record<string, string>> | undefined });
      return schema.parse(answer(path, body));
    },
  };
  return { client, calls, paths: () => calls.map(call => call.path) };
};

/** Now, fixed, so a held unlock is live for the whole of a test rather than for however long it ran. */
const NOW = Date.parse('2026-08-05T06:00:00.000Z');

/**
 * Every surface this file mounts, unmounted whether or not its test got as far as saying so.
 *
 * A failing assertion skips the explicit `unmount()`, and the leaked root keeps rendering into a live
 * document — so the next test fails too and the real failure is buried under consequences of it.
 */
const live: Awaited<ReturnType<typeof mount>>[] = [];

afterEach(async () => {
  for (const mounted of live.splice(0)) await mounted.unmount().catch(() => undefined);
});

const open = async (script: Script, connection = laptop) => {
  const daemon = fakeDaemon(script);
  const mounted = await mount(
    <FleetConfigurationSurface connection={connection} createClient={async () => daemon.client} now={() => NOW} />,
  );
  live.push(mounted);
  // The first read is several awaited round trips deep; one more flush settles them all.
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
    // Suffix, because the surface's ids are instance-local now (audit A3).
    expect(pick(surface.container, '[id$="-configuration-heading"]').tagName).toBe('H2');
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
    // `unreadable`, not a refusal: the permissions read itself failed, and rendering that as the operator
    // refusing would put a sentence about somebody's decisions on screen on the strength of no answer.
    expect(pick(forbidden.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'unreadable',
    );
    expect(forbidden.container.textContent).toContain('cannot stage a change');
    expect(pick(forbidden.container, '[data-fleet-host-guidance]').textContent).toContain('Changes from the host');
    expect(forbidden.container.textContent).toContain('fy fleet init --first-account');
    expect(forbidden.container.textContent).toContain('fy fleet apply');
    // A refusal with no grant code says nothing about the operator, because nothing told it to.
    expect(absent(forbidden.container, '[data-fleet-state-grant]')).toBe(true);
    await forbidden.unmount();
  });

  /**
   * "This credential may not read the fleet" is true of three different situations and actionable for
   * none of them. When the daemon names which one, the panel says it — that is the difference between
   * a person going to the host and a person going to look at the network.
   */
  it('names the operator refusal behind a 403 rather than only that the read was refused', async () => {
    const locked = await open({
      accounts: () => {
        throw refusal('grant_locked', 'changing the settings for the agent fleet needs the operator password', 403);
      },
      permissions: () => {
        throw refusal('grant_locked', 'no', 403);
      },
    });
    expect(pick(locked.container, '[data-fleet-state]').getAttribute('data-fleet-state')).toBe('forbidden');
    expect(pick(locked.container, '[data-fleet-state-grant]').getAttribute('data-fleet-state-grant')).toBe('locked');
    expect(locked.container.textContent).toContain('needs the operator password');
    await locked.unmount();

    const switchedOff = await open({
      accounts: () => {
        throw refusal('grant_not_granted', 'the operator has not granted the UI the use of the agent fleet', 403);
      },
      permissions: () => {
        throw refusal('grant_not_granted', 'no', 403);
      },
    });
    expect(pick(switchedOff.container, '[data-fleet-state-grant]').getAttribute('data-fleet-state-grant')).toBe(
      'not-granted',
    );
    expect(switchedOff.container.textContent).toContain('switched this off');
    await switchedOff.unmount();
  });

  it('says a daemon that answered invalidly is damaged, not silent', async () => {
    // F4: the manifest arrives, parses against the shared schema, and fails. RED before this: the surface
    // said "This daemon did not answer" about a daemon that did, sending a person to look at the network
    // instead of at the host. The answer is structurally invalid — `generatedAt` is not an instant.
    const surface = await open({
      accounts: () => ({ ...manifest(), generatedAt: 'not-an-instant' }),
    });
    const state = pick(surface.container, '[data-fleet-state]');
    expect(state.getAttribute('data-fleet-state')).toBe('damaged');
    expect(state.textContent).toContain('NOT an empty fleet');
    expect(state.textContent).toContain('does not match the fleet contract');
    expect(state.textContent).not.toContain('did not answer');
    // Still fails closed: a damaged host renders no roster and stages nothing.
    expect(absent(surface.container, '[data-fleet-side="live"]')).toBe(true);
    expect(absent(surface.container, '[data-fleet-start-create]')).toBe(true);
    await surface.unmount();
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

  it('reads the authority the daemon reports rather than assuming one, in the SHARED vocabulary', async () => {
    // Arrange / Assert — the ungoverned caller, which is the default fixture and the owner's own case.
    const host = await open({});
    const badge = pick(host.container, '[data-fleet-authority-mode]');
    expect(badge.getAttribute('data-fleet-authority-mode')).toBe('open');
    // The badge says what the grants surface would say, not 'Approval required'.
    expect(badge.textContent).toContain(grantGuidance('granted').badge);
    expect(host.container.textContent).not.toContain('Approval');
    await host.unmount();

    const governed = await open({ permissions: () => confirmingPermissions() });
    expect(pick(governed.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'confirm',
    );
    await governed.unmount();

    const locked = await open({ permissions: () => lockedPermissions() });
    expect(pick(locked.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'locked',
    );
    await locked.unmount();
  });
});

describe('creating an account', () => {
  /** Fills a draft that resolves every problem, so the preview control is actually reachable. */
  const draftIn = async (surface: Awaited<ReturnType<typeof open>>): Promise<void> => {
    await click(pick(surface.container, '[data-fleet-start-create]'));
    // A new account writes asset text too, so the form waits for the asset listing before it is usable.
    await interact(() => undefined);
    await type(field(surface.container, '-account-name'), 'atelier');
    await type(area(surface.container, '-account-models'), 'claude-opus-5');
    await type(field(surface.container, '-instructions-path'), 'instructions/atelier.md');
    await type(area(surface.container, '-instructions-text'), '# atelier');
    await choose(chooser(surface.container, '-account-default-model'), 'claude-opus-5');
  };

  it('falls back to the published fleet for the harness when the host read was refused, and says so', async () => {
    // Arrange — an older daemon, or a credential refused the harness read. Something still has to be
    // preselected, and the sentence has to say it is an inference off the manifest rather than a PATH
    // lookup on this machine.
    const surface = await open({
      accounts: () => manifest([account({ kind: 'codex', wrapper: 'codex-only' })]),
      harnesses: () => {
        throw refusal('fleet_asset_refused', 'this credential may not read the fleet');
      },
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    expect(
      pick(surface.container, '[data-fleet-harness-choice="codex"]').getAttribute('data-fleet-harness-selected'),
    ).toBe('true');
    expect(pick(surface.container, '[data-fleet-derived-wrapper]').textContent).toBe('codex-');
    expect(pick(surface.container, '[data-fleet-harness-detection="detected"]').textContent).toContain(
      'not evidence that this host can launch it',
    );
    // And NOTHING was prefilled from an absence of evidence: the form is the old, unfilled one.
    expect(area(surface.container, '-account-models').value).toBe('');
    expect(area(surface.container, '-instructions-text').value).toBe('');
    await surface.unmount();
  });

  it('opens the account form already filled in from what this host has', async () => {
    // Arrange — the whole point. RED before this: the person typed the harness, both model fields, the
    // asset path and the entire instructions document by hand, from a daemon that knew all four.
    const surface = await open({});

    // Act
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);

    // Assert — harness, models, default model and the imported document, each with its provenance.
    expect(
      pick(surface.container, '[data-fleet-harness-choice="claude"]').getAttribute('data-fleet-harness-selected'),
    ).toBe('true');
    expect(area(surface.container, '-account-models').value).toBe('claude-opus-5\nclaude-sonnet-5');
    expect(chooser(surface.container, '-account-default-model').value).toBe('claude-opus-5');
    expect(area(surface.container, '-instructions-text').value).toBe('# House rules\n');
    expect(pick(surface.container, '[data-fleet-prefill="instructionsText"]').textContent).toContain(
      '/home/pilot/.claude/CLAUDE.md',
    );
    expect(pick(surface.container, '[data-fleet-harness-detection="detected"]').textContent).toContain(
      '/usr/local/bin/claude',
    );

    // Act — the ONE thing left to type. The document path follows it.
    await type(field(surface.container, '-account-name'), 'atelier');

    // Assert
    expect(field(surface.container, '-instructions-path').value).toBe('instructions/claude-atelier.md');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });

  it('warns when NO harness is installed on this host, and still lets the account be declared', async () => {
    // Arrange — the state a person most needs told. It is a warning rather than a refusal: installing a
    // harness minutes later is ordinary, and the daemon re-reads the manifest on every session start.
    const surface = await open({
      harnesses: () => discovery([harness({ command: undefined }), absentCodex()]),
    });

    // Act
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await type(field(surface.container, '-account-name'), 'atelier');

    // Assert
    expect(pick(surface.container, '[data-fleet-harness-detection="none-installed"]').textContent).toContain(
      'Neither claude nor codex is on this host’s PATH',
    );
    expect(absent(surface.container, '[data-fleet-prefill="harness"]')).toBe(true);
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });

  it('reads a shared instructions document the account is pointed at, rather than writing over it', async () => {
    // Arrange — the fleet has a document more than one account can read. Choosing it must load it: until
    // the text is here, staging would replace somebody's house rules with an empty string.
    const surface = await open({
      assets: () => ({ files: [{ path: 'instructions/house-rules.md', bytes: 12, readable: true }], complete: true }),
      asset: path => ({ path, content: '# Shared rules\n', bytes: 15 }),
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await type(field(surface.container, '-account-name'), 'atelier');

    // Act
    await choose(chooser(surface.container, '-instructions-choice'), 'asset:instructions/house-rules.md');
    await interact(() => undefined);

    // Assert — the document's own text is here, the path points at it, and staging is unblocked because
    // this browser has now SEEN what it would rewrite.
    expect(field(surface.container, '-instructions-path').value).toBe('instructions/house-rules.md');
    expect(area(surface.container, '-instructions-text').value).toBe('# Shared rules\n');
    expect(surface.container.textContent).not.toContain('has not loaded the document already at that path');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    expect(surface.daemon.paths()).toContain('/v1/fleet/assets/instructions%2Fhouse-rules.md');
    await surface.unmount();
  });

  it('keeps a shared document that could not be read blocking, in the daemon own words', async () => {
    // Arrange — a refused read must not leave an empty box that looks like the document's contents.
    const surface = await open({
      assets: () => ({ files: [{ path: 'instructions/house-rules.md', bytes: 12, readable: true }], complete: true }),
      asset: () => {
        throw refusal('fleet_asset_refused', 'the asset is not a regular file');
      },
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await type(field(surface.container, '-account-name'), 'atelier');

    // Act
    await choose(chooser(surface.container, '-instructions-choice'), 'asset:instructions/house-rules.md');
    await interact(() => undefined);

    // Assert
    expect(surface.container.textContent).toContain('the asset is not a regular file');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);

    // Act — going back to this account's own new document clears it: nothing is overwritten any more.
    await choose(chooser(surface.container, '-instructions-choice'), 'new-imported');

    // Assert
    expect(field(surface.container, '-instructions-path').value).toBe('instructions/claude-atelier.md');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
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

  it('refuses to let a new account write over a document that is already there', async () => {
    const surface = await open({
      propose: () => proposal(),
      // A new account never READS anything — it has no declared layer — so every document the daemon
      // already lists is text this browser has not seen.
      assets: () => ({ files: [{ path: 'instructions/shared.md', bytes: 9, readable: true }], complete: true }),
    });
    await draftIn(surface);
    expect(surface.daemon.paths()).toContain('/v1/fleet/assets');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);

    // RED before this: the create form staged `{path: "instructions/shared.md", content: "# atelier"}`,
    // overwriting a shared document with a new lane's text.
    await type(field(surface.container, '-instructions-path'), 'instructions/shared.md');
    expect(surface.container.textContent).toContain('has not loaded the document already at that path');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);

    // A path that is not there yet is the ordinary case: a new account writing its own instructions.
    await type(field(surface.container, '-instructions-path'), 'instructions/atelier.md');
    expect(surface.container.textContent).not.toContain('has not loaded the document already at that path');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });

  it('refuses to create anything when the asset tree cannot be enumerated', async () => {
    const refused = await open({
      assets: () => {
        throw refusal('fleet_asset_refused', 'the fleet asset directory is not readable');
      },
    });
    await draftIn(refused);
    expect(refused.container.textContent).toContain('the fleet asset directory is not readable');
    expect(button(refused.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await refused.unmount();

    // A walk that stopped at a bound is not a short tree: what it did not reach could be the very
    // document this account is about to write, so it blocks on the same terms.
    const truncated = await open({
      assets: () => ({ files: [{ path: 'instructions/one.md', bytes: 3, readable: true }], complete: false }),
    });
    await draftIn(truncated);
    expect(truncated.container.textContent).toContain('stopped walking the asset tree at a bound');
    expect(button(truncated.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await truncated.unmount();
  });

  it('refuses a draft that writes two texts to one path', async () => {
    const surface = await open({ propose: () => proposal() });
    await draftIn(surface);
    await type(field(surface.container, '-skills-directory'), 'instructions');
    await click(button(surface.container, 'Add skill document'));
    // The same path as the instructions file. `assetEdits` used to send both and let the last one win,
    // so the review showed two texts for one document and no way to tell which would survive.
    await type(field(surface.container, '-skill-path-0'), 'instructions/atelier.md');
    expect(surface.container.textContent).toContain('is written twice by this change');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);

    await type(field(surface.container, '-skill-path-0'), 'instructions/review.md');
    expect(surface.container.textContent).not.toContain('is written twice by this change');
    await surface.unmount();
  });

  it('does not call a malformed proposal answer a refusal, and stages nothing', async () => {
    // The adjacent path for the same mapping: the daemon answered the proposal call with something that
    // does not match the contract (`expiresAt` is not an instant). It did not refuse — saying it did would
    // send a person hunting for a permission that is not the problem.
    const surface = await open({ propose: () => ({ ...proposal(), expiresAt: 'whenever' }) });
    await draftIn(surface);
    await click(button(surface.container, 'Preview this change'));

    const alert = pick(surface.container, '[data-fleet-refusal="malformed"]');
    expect(alert.textContent).toContain('answered something this browser cannot read');
    expect(alert.textContent).toContain('does not match the fleet contract at expiresAt');
    expect(alert.textContent).not.toContain('invalid_type');
    expect(alert.textContent).not.toContain('The daemon refused');
    // No proposal came back, so there is nothing to authorize and nothing to apply.
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    expect(surface.daemon.paths().some(path => path.endsWith('/apply'))).toBe(false);
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

  it('unblocks when the person clears the reference to the file it could not read', async () => {
    const surface = await open({
      config: () =>
        config({
          default: { id: account().id, wrapper: 'claude-studio', layer: { memory: 'instructions/huge.md' } },
        }),
      assets: () => ({
        files: [{ path: 'instructions/huge.md', bytes: 999_999, readable: false, reason: 'over the 65536-byte limit' }],
        complete: true,
      }),
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    expect(surface.container.textContent).toContain('over the 65536-byte limit');

    // Clearing the path is the one repair a browser can make: the patch then sends `memory: null` and
    // carries no asset text, so there is nothing left to overwrite — and nothing left to warn about.
    await type(field(surface.container, '-instructions-path'), '');
    expect(surface.container.textContent).not.toContain('over the 65536-byte limit');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });

  it('keeps a truncated asset walk blocking whatever the person types', async () => {
    const surface = await open({
      config: () =>
        config({
          default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/studio' } },
        }),
      // A walk the daemon stopped at a bound. No edit in the browser can answer what it did not reach.
      assets: () => ({ files: [{ path: 'skills/studio/one.md', bytes: 4, readable: true }], complete: false }),
      asset: path => ({ path, content: 'one', bytes: 3 }),
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('stopped walking the asset tree at a bound');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);

    await type(field(surface.container, '-skills-directory'), '');
    expect(surface.container.textContent).toContain('stopped walking the asset tree at a bound');
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

  it('refuses to stage over a document the person retargeted the path to', async () => {
    const surface = await open({
      config: () =>
        config({
          default: { id: account().id, wrapper: 'claude-studio', layer: { memory: 'instructions/a.md' } },
        }),
      // Both are there and readable. Only `a.md` is referenced, so only `a.md` is read.
      assets: () => ({
        files: [
          { path: 'instructions/a.md', bytes: 3, readable: true },
          { path: 'instructions/b.md', bytes: 9, readable: true },
        ],
        complete: true,
      }),
      asset: path => ({ path, content: 'AAA', bytes: 3 }),
      propose: () => proposal({ summary: 'change claude-studio' }),
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    expect(area(surface.container, '-instructions-text').value).toBe('AAA');
    expect(surface.daemon.paths()).not.toContain('/v1/fleet/assets/instructions%2Fb.md');

    // RED before B1: this staged `{path: "instructions/b.md", content: "AAA"}` — a.md's text written
    // over a document this browser never read, the exact invariant the unreadable machinery exists for.
    await type(field(surface.container, '-instructions-path'), 'instructions/b.md');
    expect(surface.container.textContent).toContain('has not loaded the document already at that path');
    expect(surface.container.textContent).toContain('overwrite text this browser never saw');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);

    // A path the index does not list is a document being created, which stays perfectly valid.
    await type(field(surface.container, '-instructions-path'), 'instructions/new.md');
    expect(surface.container.textContent).not.toContain('has not loaded the document already at that path');
    await click(button(surface.container, 'Preview this change'));
    expect(surface.daemon.calls.find(call => call.path.endsWith('/proposals'))?.body).toMatchObject({
      assetEdits: [{ path: 'instructions/new.md', content: 'AAA' }],
    });
    await surface.unmount();
  });

  it('refuses to stage a new skill row that names an existing document it never read', async () => {
    const surface = await open({
      config: () => config({ default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/a' } } }),
      assets: () => ({
        files: [
          { path: 'skills/a/one.md', bytes: 3, readable: true },
          { path: 'skills/b/two.md', bytes: 3, readable: true },
        ],
        complete: true,
      }),
      asset: path => ({ path, content: 'one', bytes: 3 }),
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);

    // Move the directory to one whose contents were never loaded, then name a document that is there.
    await type(field(surface.container, '-skills-directory'), 'skills/b');
    await click(button(surface.container, 'Add skill document'));
    await type(field(surface.container, '-skill-path-1'), 'skills/b/two.md');
    // RED before B1: `assetEdits` pushed `{path: "skills/b/two.md", content: ""}` — emptying a real file.
    expect(surface.container.textContent).toContain('"skills/b/two.md" could not be read');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);

    // Naming a document that is not there yet is how a person adds one, and stays unblocked.
    await type(field(surface.container, '-skill-path-1'), 'skills/b/three.md');
    expect(surface.container.textContent).not.toContain('"skills/b/two.md" could not be read');
    await surface.unmount();
  });

  it('lists the asset index even for a layer that declares nothing, and reads no document', async () => {
    const surface = await open({
      propose: () => proposal({ summary: 'change claude-studio' }),
      // Knowing what is already there is what lets a typed path be judged at all, so the LISTING happens
      // for every layer. Only the per-document reads are scoped to what the layer declares.
      assets: () => ({ files: [{ path: 'instructions/there.md', bytes: 4, readable: true }], complete: true }),
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    expect(absent(surface.container, '[data-fleet-layer-loading]')).toBe(true);
    expect(surface.daemon.paths()).toContain('/v1/fleet/assets');
    expect(surface.daemon.paths().some(path => path.startsWith('/v1/fleet/assets/'))).toBe(false);

    // And the knowledge is real: naming the document that is already there blocks here too.
    await type(field(surface.container, '-instructions-path'), 'instructions/there.md');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);

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

  it('states a malformed asset listing in a sentence, and still refuses to stage', async () => {
    const surface = await open({
      config: () => config({ default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/a' } } }),
      // A 200 that does not match the contract: `bytes` is a string. The client's `schema.parse` throws a
      // ZodError whose own message is a multi-line JSON dump of every issue.
      assets: () => ({ files: [{ path: 'skills/a/one.md', bytes: 'twelve', readable: true }], complete: true }),
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);

    const problems = pick(surface.container, '[data-fleet-problems]');
    // F3: one sentence naming where the answer went wrong, not a JSON blob in a blocker.
    expect(problems.textContent).toContain('does not match the fleet contract at files.0.bytes');
    expect(problems.textContent).not.toContain('"code"');
    expect(problems.textContent).not.toContain('invalid_type');
    expect(problems.getAttribute('data-fleet-problems')).toBe('1');
    // Unchanged and non-negotiable: an answer nobody could read blocks staging.
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('blocks a layer that declares nothing when the asset tree itself is unknowable', async () => {
    // The deliberate cost of listing for every layer: on a host whose asset tree cannot be enumerated,
    // even an env-only edit is refused. Fail closed is the right side to err on — with no listing, a path
    // the person types cannot be judged at all — and the sentence on screen says exactly why.
    const surface = await open({
      assets: () => {
        throw refusal('fleet_asset_refused', 'the fleet asset directory is not readable');
      },
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('the fleet asset directory is not readable');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(true);
    await surface.unmount();
  });

  it('discards a draft without asking the daemon anything', async () => {
    const surface = await open({});
    await click(button(surface.container, 'Edit layer'));
    // Settled first: the form is disabled while the index is in flight, so a click before that proves
    // nothing about the button a person can actually press.
    await interact(() => undefined);
    await click(button(surface.container, 'Discard draft'));
    expect(absent(surface.container, '[data-fleet-layer-form]')).toBe(true);
    await surface.unmount();
  });
});

describe('applying one exact proposal', () => {
  const staged = async (script: Script) => {
    const surface = await open({ propose: () => proposal(), ...script });
    await click(button(surface.container, 'Edit layer'));
    // The index listing is in flight until this settles, and the form is disabled while it is.
    await interact(() => undefined);
    await type(field(surface.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(surface.container, 'Preview this change'));
    return surface;
  };

  const COMMITTED = {
    outcome: 'committed',
    result: { accountCount: 1, operationCount: 4, manifestPath: '/m', prunedWrappers: [], sharedHistory: [] },
  };

  /** The one password field this panel ever renders. */
  const password = (container: HTMLElement): HTMLInputElement =>
    must(container.querySelector<HTMLInputElement>('[data-fleet-operator-password]'), 'the operator password field');

  const applyCall = (surface: Awaited<ReturnType<typeof staged>>) =>
    surface.daemon.calls.find(call => call.path.endsWith('/apply'));

  /**
   * PROOF 1 — an ungoverned caller applies with one click and is shown nothing else.
   *
   * The whole owner-visible defect, asserted at the surface as well as at the component: the surface is
   * what decides which authority the component is handed, so a regression could reintroduce the two
   * gates here without the component's own suite noticing.
   */
  it('shows an ungoverned caller one Apply, no id, no command, no code field and no timer', async () => {
    const surface = await staged({});
    const text = surface.container.textContent ?? '';

    expect(pick(surface.container, '[data-fleet-apply]').hasAttribute('disabled')).toBe(false);
    expect(text).not.toContain('fy_fprop_');
    expect(text).not.toContain('fy fleet authorize');
    expect(text).not.toContain('Approval');
    expect(text).not.toContain('Host authority');
    expect(absent(surface.container, '[data-fleet-operator-password]')).toBe(true);
    expect(text).not.toContain('token-laptop');
    await surface.unmount();
  });

  it('applies with an empty body, then re-reads the daemon rather than patching the list', async () => {
    let published = manifest();
    const surface = await staged({
      accounts: () => published,
      apply: () => {
        published = manifest([account({ id: accountId(4), wrapper: 'claude-atelier', displayName: 'Atelier' })]);
        return COMMITTED;
      },
    });
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // No secret, because the daemon said none was needed.
    expect(applyCall(surface)?.body).toEqual({});
    expect(applyCall(surface)?.headers).toEqual({ 'content-type': 'application/json' });
    expect(surface.daemon.paths().some(path => path === '/v1/grants/unlock')).toBe(false);
    expect(pick(surface.container, '[data-fleet-outcome]').getAttribute('data-fleet-outcome')).toBe('committed');
    // The roster is what the daemon now says, not what the browser hoped.
    expect(surface.container.textContent).toContain('claude-atelier');
    expect(surface.daemon.paths().filter(path => path.endsWith('/accounts'))).toHaveLength(2);
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    await surface.unmount();
  });

  /** PROOF 3 — the per-change confirmation reaches the apply BODY and nothing is minted. */
  it('sends a confirming caller’s password as operatorPassword, and mints no unlock for it', async () => {
    // Arrange — `confirmation: 'operator-password'` with `mayApply: true`: a governed caller on a machine
    // with a password, already past the grant gate.
    const surface = await staged({ permissions: () => confirmingPermissions(), apply: () => COMMITTED });

    // Act — typed once.
    await type(password(surface.container), 'correct horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — in the body, and in nothing else. There is no unlock to mint: this caller is not locked,
    // so spending an attempt on one would be a second round trip for no authority.
    expect(applyCall(surface)?.body).toEqual({ operatorPassword: 'correct horse battery' });
    expect(surface.daemon.paths().some(path => path === '/v1/grants/unlock')).toBe(false);
    expect(applyCall(surface)?.headers).toEqual({ 'content-type': 'application/json' });
    expect(pick(surface.container, '[data-fleet-outcome]')).toBeDefined();
    // And it is nowhere on screen afterwards.
    expect(surface.container.textContent).not.toContain('correct horse battery');
    await surface.unmount();
  });

  /**
   * PROOF 2 — THE HEADLINE. A locked caller unlocks and applies from ONE typed password.
   *
   * This is the assertion the whole task is for: the password is typed once, the mint and the apply both
   * happen, and the apply carries both the unlock header and the confirmation.
   */
  it('mints an unlock and applies from ONE typed password, in one click', async () => {
    // Arrange — locked AND owing a confirmation, which is a remote caller on a machine with a password.
    const surface = await staged({ permissions: () => lockedPermissions(), apply: () => COMMITTED });
    expect(surface.container.textContent).toContain(grantGuidance('locked', 'fleet').explanation);
    expect(surface.container.textContent).toContain(UNLOCK_LIMIT_NOTE);
    // ONE field on the whole panel, so the human cannot be asked twice.
    expect(surface.container.querySelectorAll('[data-fleet-operator-password]')).toHaveLength(1);

    // Act — typed once, clicked once.
    await type(password(surface.container), 'correct horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — the mint spent the password, in a body, on the shared grants route.
    const minted = surface.daemon.calls.find(call => call.path === '/v1/grants/unlock');
    expect(minted?.body).toEqual({ password: 'correct horse battery' });

    // And the apply carried BOTH: the token in the shared header, the password in the body.
    expect(applyCall(surface)?.headers).toEqual({
      'content-type': 'application/json',
      [OPERATOR_UNLOCK_HEADER]: unlockView().token,
    });
    expect(applyCall(surface)?.body).toEqual({ operatorPassword: 'correct horse battery' });

    // The change landed, and the panel never asked for the password a second time.
    expect(pick(surface.container, '[data-fleet-outcome]').getAttribute('data-fleet-outcome')).toBe('committed');
    expect(absent(surface.container, '[data-fleet-operator-password]')).toBe(true);
    await surface.unmount();
  });

  it('sends no confirmation when the daemon asked only for the unlock', async () => {
    // Arrange — `locked` with `confirmation: 'none'`: a LOCAL browser on a machine with a password, which
    // is ungoverned once it unlocks. A password on the apply body here would be a secret on the wire for
    // nothing, and it is the case PR #358 shipped: unlock once, then no second gate ever.
    const surface = await staged({
      permissions: () => lockedPermissions({ confirmation: 'none' }),
      apply: () => COMMITTED,
    });

    // Act
    await type(password(surface.container), 'correct horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — minted, header sent, body empty.
    expect(surface.daemon.calls.find(call => call.path === '/v1/grants/unlock')).toBeDefined();
    expect(applyCall(surface)?.headers).toEqual({
      'content-type': 'application/json',
      [OPERATOR_UNLOCK_HEADER]: unlockView().token,
    });
    expect(applyCall(surface)?.body).toEqual({});
    await surface.unmount();
  });

  it('reuses a held unlock rather than spending a second attempt on the next change', async () => {
    // Arrange — the requirement in the owner's words: unlock once, then no second gate, ever. The daemon
    // keeps reporting `locked` here on purpose, which is the harsher case: even a permissions read that
    // has not caught up must not cost a second mint while the token this screen holds is still live.
    const surface = await staged({ permissions: () => lockedPermissions(), apply: () => COMMITTED });
    await type(password(surface.container), 'correct horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.daemon.paths().filter(path => path === '/v1/grants/unlock')).toHaveLength(1);

    // Act — a SECOND change, staged and applied with the same screen.
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    await type(field(surface.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(surface.container, 'Preview this change'));
    await type(password(surface.container), 'correct horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — STILL one mint. The held token is presented again; the confirmation is still per-change.
    expect(surface.daemon.paths().filter(path => path === '/v1/grants/unlock')).toHaveLength(1);
    const applies = surface.daemon.calls.filter(call => call.path.endsWith('/apply'));
    expect(applies).toHaveLength(2);
    expect(applies[1]?.headers?.[OPERATOR_UNLOCK_HEADER]).toBe(unlockView().token);
    await surface.unmount();
  });

  it('stops at the mint when the password is wrong, and never spends the change on it', async () => {
    // Arrange — the mint is the half that reports "wrong password, four tries left", and it is the half
    // that must fail first: sending the apply anyway would spend the change's own attempt on a secret
    // already known to be wrong.
    const surface = await staged({
      permissions: () => lockedPermissions(),
      unlock: () => {
        throw refusal(
          'grant_wrong_password',
          'that is not this machine’s operator password; 4 attempts remaining',
          401,
        );
      },
    });

    // Act
    await type(password(surface.container), 'wrong horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — no apply was attempted, the daemon's own sentence is on screen with its number, and the
    // change is still staged with a field to retype into.
    expect(surface.daemon.paths().some(path => path.endsWith('/apply'))).toBe(false);
    expect(pick(surface.container, '[data-fleet-operator-password-failure]').textContent).toContain(
      '4 attempts remaining',
    );
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    expect(pick(surface.container, '[data-fleet-operator-password]')).toBeDefined();
    await surface.unmount();
  });

  it('says a daemon that stopped checking has stopped, rather than inviting more guesses', async () => {
    const surface = await staged({
      permissions: () => lockedPermissions(),
      unlock: () => {
        throw refusal('grant_rate_limited', 'too many wrong operator passwords; try again in 15 minutes', 429);
      },
    });
    await type(password(surface.container), 'wrong horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(
      pick(surface.container, '[data-fleet-operator-password-failure]').getAttribute(
        'data-fleet-operator-password-failure',
      ),
    ).toBe('final');
    expect(surface.container.textContent).toContain('15 minutes');
    await surface.unmount();
  });

  /** PROOF 4 — a refusal no unlock would fix gets the shared sentence and no field. */
  it('renders the shared sentence for a switched-off fleet and offers no unlock for it', async () => {
    // Arrange — `mayApply: false` with `applyRefusal: 'not-granted'`. An unlock would not help, and
    // offering one is the theatre this codebase refuses.
    const surface = await staged({
      permissions: () => permissions({ mayApply: false, applyRefusal: 'not-granted' }),
    });

    // Assert
    expect(surface.container.textContent).toContain(grantGuidance('not-granted', 'fleet').explanation);
    expect(absent(surface.container, '[data-fleet-operator-password]')).toBe(true);
    expect(pick(surface.container, '[data-fleet-apply]').hasAttribute('disabled')).toBe(true);
    // And pressing it does nothing at all, rather than producing a refusal round trip.
    await click(pick(surface.container, '[data-fleet-apply]'));
    expect(surface.daemon.paths().some(path => path.endsWith('/apply'))).toBe(false);
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
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('The fleet DID land');
    expect(surface.container.textContent).toContain('Do not re-apply');
    await surface.unmount();
  });

  it('keeps the proposal applicable when the daemon refused the apply for its own reason', async () => {
    // Arrange — a refusal that is not about the password and not about the proposal being dead. The change
    // survives, and the reason is rendered whole.
    const surface = await staged({
      apply: () => {
        throw refusal('fleet_proposal_unauthorized', 'a confirmation was required and none was supplied');
      },
      proposal: () => proposal(),
    });
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('none was supplied');
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    await surface.unmount();
  });

  it('stops offering a proposal the daemon no longer holds', async () => {
    const surface = await staged({
      apply: () => {
        throw refusal('fleet_proposal_stale', 'the fleet configuration changed on this host after this was previewed');
      },
      proposal: () => proposal(),
    });
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('changed on this host');
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    await surface.unmount();
  });

  it('retires a proposal the daemon says is gone, even when the apply refused for another reason', async () => {
    // Arrange — the two facts come apart: the apply was refused for a confirmation, and in the same moment
    // the host moved. Reading only the refusal would leave an enabled Apply bound to a dead id.
    const surface = await staged({
      apply: () => {
        throw refusal('fleet_proposal_unauthorized', 'a confirmation was required and none was supplied');
      },
      proposal: () => {
        throw refusal('fleet_proposal_expired', 'this proposal expired; review the change again');
      },
    });

    // Act
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — the ACTIONABLE refusal stays on screen, and the dead change stops being offered. The
    // re-read's own refusal is deliberately NOT rendered: a second alert about it would bury the first.
    expect(surface.container.textContent).toContain('none was supplied');
    expect(surface.container.textContent).not.toContain('review the change again');
    expect(absent(surface.container, '[data-fleet-proposal-id]')).toBe(true);
    await surface.unmount();
  });

  it('keeps the proposal when the re-read merely refused, rather than saying it is gone', async () => {
    const surface = await staged({
      apply: () => {
        throw refusal('fleet_apply_refused', 'the apply lock is held by another change');
      },
      proposal: () => {
        throw refusal('fleet_asset_refused', 'the asset tree is not readable right now');
      },
    });
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.container.textContent).toContain('apply lock is held');
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    await surface.unmount();
  });

  it('reports a 403 raced at apply time truthfully', async () => {
    const surface = await staged({
      apply: () => {
        throw refusal('forbidden', 'a paired device may inspect the fleet but may not apply it', 403);
      },
      proposal: () => proposal(),
    });
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(pick(surface.container, '[data-fleet-refusal="forbidden"]').textContent).toContain('may not apply');
    await surface.unmount();
  });

  it('re-reads what this caller may do when a refusal says the grant state moved under the screen', async () => {
    // Arrange — the grant state changes between the permissions read and the click: it said `open`, the
    // guard now says `locked`. RED before the re-read: the panel showed a refusal it offered no way out
    // of — exactly the dead end the owner complained about, arriving by a different route.
    let reads = 0;
    const surface = await staged({
      permissions: () => {
        reads += 1;
        return reads === 1 ? permissions() : lockedPermissions();
      },
      apply: () => {
        throw refusal('grant_locked', 'changing the agent fleet needs the operator password for this machine', 403);
      },
      proposal: () => proposal(),
    });
    // It really did start with no field, so the one below is the re-read's doing.
    expect(absent(surface.container, '[data-fleet-operator-password]')).toBe(true);

    // Act
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — the refusal is worded as the FLEET refusal it is (the guard refused the request; nobody
    // typed anything wrong), and the panel now offers the unlock that resolves it.
    expect(pick(surface.container, '[data-fleet-refusal]').textContent).toContain('needs the operator password');
    expect(absent(surface.container, '[data-fleet-operator-password-failure]')).toBe(true);
    expect(pick(surface.container, '[data-fleet-operator-password]')).toBeDefined();
    expect(pick(surface.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'locked',
    );

    // And the way out works from there: one password, one mint, one apply.
    await type(password(surface.container), 'correct horse battery');
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(surface.daemon.calls.find(call => call.path === '/v1/grants/unlock')?.body).toEqual({
      password: 'correct horse battery',
    });
    await surface.unmount();
  });

  it('leaves the authority unreadable rather than stale when the re-read itself fails', async () => {
    // Arrange — the first permissions read lands, the apply refuses, and the re-read fails too. Keeping the
    // old `open` answer would claim an authority nothing now supports.
    let reads = 0;
    const surface = await staged({
      permissions: () => {
        reads += 1;
        if (reads === 1) return permissions();
        throw refusal('forbidden', 'no', 403);
      },
      apply: () => {
        throw refusal('fleet_apply_refused', 'the apply lock is held by another change');
      },
      proposal: () => proposal(),
    });

    // Act
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert
    expect(pick(surface.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'unreadable',
    );
    expect(surface.container.textContent).toContain('apply lock is held');
    await surface.unmount();
  });

  it('moves focus to a stable control when the staged change is discarded', async () => {
    const surface = await staged({});
    // Focus is on the review panel, which Discard is about to unmount.
    expect(document.activeElement).toBe(pick(surface.container, '[data-fleet-side="proposed"]').parentElement);
    await click(button(surface.container, 'Discard'));
    await interact(() => undefined);
    // Not <body>. Here the layer form is still open, so the header control is not rendered and the
    // surface itself takes focus -- a keyboard reader stays inside the panel they were working in.
    expect(document.activeElement).toBe(pick(surface.container, '[data-fleet-configuration]'));
    expect(document.activeElement).not.toBe(document.body);
    await surface.unmount();
  });

  it('moves focus to a stable control when a draft is discarded', async () => {
    const surface = await open({});
    await click(button(surface.container, 'Edit layer'));
    await click(button(surface.container, 'Discard draft'));
    await interact(() => undefined);
    expect(document.activeElement).toBe(pick(surface.container, '[data-fleet-start-create]'));
    await surface.unmount();
  });

  it('carries focus into the create panel that replaced the button, and keeps it there while it loads', async () => {
    const surface = await open({});
    const trigger = pick(surface.container, '[data-fleet-start-create]');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // F2: the header offers "Add account" only while nothing is being composed, so the click unmounts the
    // element focus is sitting on. RED before this: focus fell to <body> and stayed there — including
    // after the listing settled, because every control in the form is disabled until it does.
    await click(trigger);
    const panel = pick(surface.container, '[aria-label="New account"]');
    // Compared as a boolean and by name, not with `toBe` on the elements: a mismatch there makes bun
    // diff two whole DOM trees, which turns one red assertion into minutes of output.
    expect(document.activeElement === panel).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('New account');

    await interact(() => undefined);
    expect(document.activeElement === panel).toBe(true);
    // And it does not fight the person once they are typing in it.
    const name = field(surface.container, '-account-name');
    name.focus();
    await type(name, 'atelier');
    expect(document.activeElement === name).toBe(true);
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
  it('drops every draft, proposal, result and held unlock when the daemon changes', async () => {
    // Arrange — the laptop is `locked`, so this test can mint a real unlock against it and then prove the
    // token does not survive the switch. A credential crossing a machine boundary is the failure this
    // repository keys everything by daemon to prevent.
    const laptopDaemon = fakeDaemon({
      propose: () => proposal(),
      permissions: () => lockedPermissions(),
      apply: () => ({
        outcome: 'committed',
        result: { accountCount: 1, operationCount: 4, manifestPath: '/m', prunedWrappers: [], sharedHistory: [] },
      }),
    });
    const workstationDaemon = fakeDaemon({
      accounts: () =>
        manifest([account({ id: accountId(8), wrapper: 'claude-workstation', displayName: 'Workstation' })]),
      permissions: () => lockedPermissions(),
      propose: () => proposal(),
    });
    const clientFor = async (connection: typeof laptop) =>
      connection.daemonId === laptop.daemonId ? laptopDaemon.client : workstationDaemon.client;

    const mounted = await mount(
      <FleetConfigurationSurface connection={laptop} createClient={clientFor} now={() => NOW} />,
    );
    await interact(() => undefined);
    await click(button(mounted.container, 'Edit layer'));
    await type(field(mounted.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(mounted.container, 'Preview this change'));
    // Unlock and apply against the LAPTOP, so a live token is genuinely held.
    await type(
      must(mounted.container.querySelector<HTMLInputElement>('[data-fleet-operator-password]'), 'the password field'),
      'correct horse battery',
    );
    await click(pick(mounted.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(laptopDaemon.paths().filter(path => path === '/v1/grants/unlock')).toHaveLength(1);

    // Act
    await mounted.render(
      <FleetConfigurationSurface connection={workstation} createClient={clientFor} now={() => NOW} />,
    );
    await interact(() => undefined);

    // Assert — a fresh session in every respect.
    expect(pick(mounted.container, '[data-fleet-configuration]').getAttribute('data-fleet-daemon-id')).toBe(
      'daemon/workstation',
    );
    expect(mounted.container.textContent).toContain('claude-workstation');
    expect(mounted.container.textContent).not.toContain('claude-studio');
    expect(absent(mounted.container, '[data-fleet-proposal-id]')).toBe(true);
    expect(absent(mounted.container, '[data-fleet-layer-form]')).toBe(true);
    expect(absent(mounted.container, '[data-fleet-outcome]')).toBe(true);
    expect(workstationDaemon.paths().some(path => path.endsWith('/apply'))).toBe(false);

    // And the laptop's unlock did NOT come with it: the workstation is asked for the password again, and
    // when it is given one it mints its OWN token rather than presenting the other machine's.
    await click(button(mounted.container, 'Edit layer'));
    await interact(() => undefined);
    await type(field(mounted.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(mounted.container, 'Preview this change'));
    await type(
      must(mounted.container.querySelector<HTMLInputElement>('[data-fleet-operator-password]'), 'the password field'),
      'correct horse battery',
    );
    await click(pick(mounted.container, '[data-fleet-apply]'));
    await interact(() => undefined);
    expect(workstationDaemon.paths().filter(path => path === '/v1/grants/unlock')).toHaveLength(1);
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

describe('a carrier-set-only connection change', () => {
  it('is a new connection: same id, address and token, different carrier set', async () => {
    const direct = fakeDaemon({ accounts: () => manifest([account({ wrapper: 'claude-direct' })]) });
    const relayed = fakeDaemon({
      accounts: () => manifest([account({ id: accountId(9), wrapper: 'claude-relayed' })]),
    });
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let opened = 0;
    const clientFor = async (): Promise<FleetClient> => {
      opened += 1;
      if (opened === 1) {
        await held;
        return direct.client;
      }
      return relayed.client;
    };

    // Everything a credential-shaped key would compare is IDENTICAL; only the published carrier SET
    // moved — the same direct address, now with a rendezvous behind it. The bytes can physically go
    // somewhere else, so an answer that arrived over the old set is not this one's.
    const viaRelay = daemonConnection({
      daemonId: 'daemon/laptop',
      baseUrl: 'https://laptop.example.test',
      deviceToken: 'token-laptop',
      carriers: [
        { kind: 'direct', daemonUrl: 'https://laptop.example.test' },
        { kind: 'relay', relayUrl: 'https://relay.example.test', operator: 'hosted' },
      ],
    });

    const mounted = await mount(<FleetConfigurationSurface connection={laptop} createClient={clientFor} />);
    await mounted.render(<FleetConfigurationSurface connection={viaRelay} createClient={clientFor} />);
    await interact(() => release?.());
    await interact(() => undefined);

    expect(opened).toBe(2);
    expect(mounted.container.textContent).toContain('claude-relayed');
    expect(mounted.container.textContent).not.toContain('claude-direct');
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

describe('four cockpits in one document', () => {
  it('keeps every label relationship and live region its own', async () => {
    // The harness `states` frame renders one surface per host state in a single page. Module-global ids
    // there left three sections labelled by the first daemon's heading and put four `role="status"`
    // regions in one document, so the frame could not be trusted as accessibility evidence.
    const daemons = [fakeDaemon({}), fakeDaemon({}), fakeDaemon({}), fakeDaemon({})];
    const mounted = await mount(
      <>
        {daemons.map((daemon, index) => (
          <FleetConfigurationSurface key={String(index)} connection={laptop} createClient={async () => daemon.client} />
        ))}
      </>,
    );
    await interact(() => undefined);

    expect(mounted.container.querySelectorAll('[data-fleet-configuration]')).toHaveLength(4);
    const ids = [...mounted.container.querySelectorAll('[id]')].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const labelled of mounted.container.querySelectorAll('[aria-labelledby]')) {
      const target = labelled.getAttribute('aria-labelledby') ?? '';
      // Resolves to exactly one node, and that node is inside the SAME surface.
      expect(mounted.container.querySelectorAll(`[id="${target}"]`)).toHaveLength(1);
      expect(labelled.querySelector(`[id="${target}"]`)).not.toBeNull();
    }
    // Four surfaces, four regions — one each, none shared.
    expect(mounted.container.querySelectorAll('[data-fleet-announcement]')).toHaveLength(4);
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
