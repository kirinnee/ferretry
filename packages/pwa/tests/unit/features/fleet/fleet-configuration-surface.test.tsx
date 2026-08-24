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
import type { LocalNetworkAccess } from '../../../../src/lib/local-network-access.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import {
  absent,
  absentCodex,
  account,
  accountId,
  area,
  button,
  card,
  cardChosen,
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
  next,
  permissions,
  pick,
  proposal,
  scaffoldProposal,
  stepperStep,
  type,
  unlockField,
  unlockView,
  unlockWith,
  walkTo,
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

const open = async (script: Script, connection = laptop, readLocalNetwork?: () => Promise<LocalNetworkAccess>) => {
  const daemon = fakeDaemon(script);
  const mounted = await mount(
    <FleetConfigurationSurface
      connection={connection}
      createClient={async () => daemon.client}
      now={() => NOW}
      {...(readLocalNetwork === undefined ? {} : { readLocalNetwork })}
    />,
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

/**
 * A HOST THAT HAS NEVER HAD A FLEET, answering exactly as a real `fyd` does.
 *
 * Both sentences and both codes are copied from a live 3.0.0 boot on a throwaway `FY_HOME` with no
 * proposals in existence. They arrive as HTTP 409 — `respond()` maps every `FleetRefusal` to that one
 * status — so a browser that read the status would render the first screen of every new install as a
 * conflict. The panel branches on the CODE, and the state it reaches is a first run.
 */
describe('a host that has never been configured', () => {
  const first = async () =>
    await open({
      config: () => {
        throw refusal(
          'fleet_config_missing',
          'no fleet config at /tmp/fy-home/fleet/config.yaml; write the declared config before applying the fleet',
        );
      },
      accounts: () => {
        throw refusal(
          'fleet_not_applied',
          'no published fleet manifest at /tmp/fy-home/fleet/manifest.json; apply the fleet first',
        );
      },
      propose: () => scaffoldProposal(),
    });

  it('is a first run rather than a failure, with the daemon’s own sentences kept', async () => {
    const surface = await first();
    expect(pick(surface.container, '[data-fleet-state]').getAttribute('data-fleet-state')).toBe('uninitialized');
    // NOT an error: no alert, no refusal, and the two words in the header say where the host stands.
    expect(absent(surface.container, '[role="alert"]')).toBe(true);
    expect(absent(surface.container, '[data-fleet-refusal]')).toBe(true);
    expect(pick(surface.container, '[data-fleet-state-badge]').getAttribute('data-fleet-state-badge')).toBe(
      'uninitialized',
    );
    expect(surface.container.textContent).not.toContain('refused');
    // The daemon's sentences are better copy than anything a browser would invent, so they stay whole —
    // including the exact path and the exact remedy.
    expect(surface.container.textContent).toContain('write the declared config before applying the fleet');
    expect(surface.container.textContent).toContain('/tmp/fy-home/fleet/config.yaml');
    // And the one thing to do about it is offered.
    expect(button(surface.container, 'Prepare this host')).toBeDefined();
    await surface.unmount();
  });

  it('offers preparing the host as ONE action, with the list it will write', async () => {
    const surface = await first();
    await click(pick(surface.container, '[data-fleet-start-initialize]'));
    expect(absent(surface.container, '[data-fleet-first-run]')).toBe(false);
    expect(pick(surface.container, '[data-fleet-apply]').textContent).toContain('Create these files');
    expect(surface.container.textContent).not.toContain('Staged change');
    await surface.unmount();
  });
});

/**
 * THE OWNER'S SCREENSHOT, as a test. The daemon could not be reached and the panel offered a password
 * field, an attempt-limit warning and Confirm-and-Apply — three controls that could not possibly work,
 * in front of a limiter nothing could ask a question of.
 *
 * The failure is spelled the way a browser spells it: a plain `Error`, no status, no code. That is what
 * `Failed to fetch` arrives as, and it is why the panel must not word it as a refusal.
 */
describe('a daemon this browser could not reach', () => {
  const dead = 'could not reach fyd at http://127.0.0.1:9999 (Failed to fetch)';
  const loopback = daemonConnection({
    daemonId: 'daemon/home',
    baseUrl: 'http://127.0.0.1:9999',
    deviceToken: 'token-home',
  });

  const openUnreachable = async (
    connection = laptop,
    pageScheme = 'http:',
    readLocalNetwork?: () => Promise<LocalNetworkAccess>,
  ) => {
    const mounted = await mount(
      <FleetConfigurationSurface
        connection={connection}
        createClient={async () => {
          throw new Error(dead);
        }}
        now={() => NOW}
        pageScheme={pageScheme}
        {...(readLocalNetwork === undefined ? {} : { readLocalNetwork })}
      />,
    );
    live.push(mounted);
    await interact(() => undefined);
    // The permission is asked AFTER the failure, so its answer lands a flush later than the state does.
    await interact(() => undefined);
    return mounted;
  };

  it('says what it knows, names the address, and offers no control at all', async () => {
    const surface = await openUnreachable();
    const state = pick(surface.container, '[data-fleet-state]');
    expect(state.getAttribute('data-fleet-state')).toBe('unreachable');
    expect(pick(surface.container, '[data-fleet-unreachable]').textContent).toContain('could not reach this daemon');
    // The transport's own sentence, whole: it is the only thing here that names the exact URL tried.
    expect(state.textContent).toContain(dead);
    // NOT "start the daemon". The owner's daemon was serving when they read this.
    expect(surface.container.textContent?.toLowerCase()).not.toContain('start the daemon');
    expect(state.textContent).toContain('fy daemon status');
    expect(state.textContent).toContain('/healthz');
    // Nothing on this screen is a control, because nothing a click could do would help.
    expect(surface.container.querySelectorAll('button')).toHaveLength(0);
    await surface.unmount();
  });

  it('names the mixed request for an https page reaching an http daemon, and not otherwise', async () => {
    const mixed = await openUnreachable(loopback, 'https:');
    expect(pick(mixed.container, '[data-fleet-unreachable]').textContent).toContain('Safari');
    await mixed.unmount();

    const plain = await openUnreachable(loopback, 'http:');
    expect(pick(plain.container, '[data-fleet-unreachable]').textContent).not.toContain('Safari');
    await plain.unmount();
  });

  /**
   * THE ONE QUESTION THAT TELLS THE TWO CAUSES APART, asked of the browser on the failure path.
   *
   * `'prompt'` is the blocked state as Chrome 150 actually reports it — measured while the fetch was
   * refused and zero requests reached the server — so the panel says the browser is blocking and gives
   * the remedy in the wording Chrome itself uses, instead of listing two possibilities.
   */
  it('says the browser is blocking, with the remedy, when this site is not allowed the local network', async () => {
    const asked: number[] = [];
    const blocked = await openUnreachable(loopback, 'https:', () => {
      asked.push(1);
      return Promise.resolve('prompt');
    });
    const notice = pick(blocked.container, '[data-fleet-unreachable]');
    expect(asked).toHaveLength(1);
    expect(notice.textContent).toContain('blocking this page from your local network');
    expect(notice.textContent).toContain('access other devices on your local network');
    // The claim that cost an afternoon — nowhere on this screen, including the transport's own line,
    // which no longer says it either.
    expect(blocked.container.textContent).not.toContain('unavailable');
    expect(blocked.container.textContent?.toLowerCase()).not.toContain('start the daemon');
    // No verified navigation exists, so none is written down.
    expect(blocked.container.textContent).not.toContain('chrome://');
    // The transport's own line is still there, whole: it is what names the exact address tried.
    expect(pick(blocked.container, '[data-fleet-state]').textContent).toContain(dead);
    await blocked.unmount();
  });

  it('keeps the honest wording when the browser says this site IS allowed', async () => {
    const granted = await openUnreachable(loopback, 'https:', () => Promise.resolve('granted'));
    const notice = pick(granted.container, '[data-fleet-unreachable]');
    expect(notice.textContent).toContain('could not reach this daemon');
    expect(notice.textContent).toContain('IS allowed to access other devices on your local network');
    expect(notice.textContent).toContain('NOT evidence that the daemon is stopped');
    await granted.unmount();
  });

  /**
   * A DIAGNOSTIC MAY NOT BECOME A FAILURE MODE. A browser with no such permission rejects the query, and
   * the panel must fall back to naming both possibilities rather than lose the notice altogether.
   */
  it('falls back to both possibilities when the permission query throws', async () => {
    const unknown = await openUnreachable(loopback, 'https:', () =>
      Promise.reject(new TypeError('local-network-access is not a valid permission name')),
    );
    const notice = pick(unknown.container, '[data-fleet-unreachable]');
    expect(notice.textContent).toContain('could not reach this daemon');
    expect(notice.textContent).toContain('Has this site been allowed');
    expect(notice.textContent).toContain('Safari');
    await unknown.unmount();
  });

  it('never asks the browser anything while the daemon is answering', async () => {
    const asked: number[] = [];
    const working = await open({}, laptop, () => {
      asked.push(1);
      return Promise.resolve('prompt');
    });
    expect(working.container.textContent).toContain('claude-studio');
    expect(asked).toHaveLength(0);
    await working.unmount();
  });

  /**
   * The exact shape in the screenshot: a change staged while the host answered, then an apply whose
   * request never arrives. The proposal survives, so the review is still on screen — and everything on
   * it that needs a reachable daemon must be gone rather than merely disabled.
   */
  it('takes the password field and the apply off a staged change it can no longer send', async () => {
    const surface = await open({
      permissions: () => lockedPermissions(),
      propose: () => proposal(),
      apply: () => {
        throw new Error(dead);
      },
      unlock: () => {
        throw new Error(dead);
      },
    });
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    await type(field(surface.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(surface.container, 'Preview this change'));
    // While the daemon answered, the action raised the prompt. That part is #362 and stays.
    await click(pick(surface.container, '[data-fleet-apply]'));
    expect(absent(surface.container, '[role="dialog"]')).toBe(false);

    await unlockWith(surface.container, 'hunter2');
    await interact(() => undefined);

    // The prompt is gone with the authority question it was asking: nothing can be proved to a daemon
    // that is not answering, so there is nothing left to type into.
    expect(absent(surface.container, '[role="dialog"]')).toBe(true);
    expect(absent(surface.container, 'input')).toBe(true);
    expect(absent(surface.container, '[data-fleet-apply]')).toBe(true);
    expect(surface.container.textContent).not.toContain(UNLOCK_LIMIT_NOTE);
    expect(pick(surface.container, '[data-fleet-apply-unreachable]').textContent).toContain('cannot be applied');
    // The change is still held and this browser's own act still works.
    expect(absent(surface.container, '[data-fleet-side="proposed"]')).toBe(false);
    await click(button(surface.container, 'Discard'));
    expect(absent(surface.container, '[data-fleet-side="proposed"]')).toBe(true);
    await surface.unmount();
  });
});

describe('creating an account', () => {
  /**
   * Opens the stepper and walks it to the recap, which is the only place a change can be previewed.
   *
   * ONE thing is typed. Everything else on the way — the harness, both model fields, the document name
   * and the imported text — is what the host already told the daemon, which is the whole point of the
   * sequence: a step whose answer is known shows the answer and asks nothing.
   */
  const draftIn = async (surface: Awaited<ReturnType<typeof open>>): Promise<void> => {
    await click(pick(surface.container, '[data-fleet-start-create]'));
    // A new account writes asset text too, so the stepper waits for the asset listing before it is usable.
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'review');
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

    expect(cardChosen(surface.container, 'harness', 'codex')).toBe(true);
    expect(pick(surface.container, '[data-fleet-harness-detection="detected"]').textContent).toContain(
      'not evidence that this host can launch it',
    );

    // And NOTHING was prefilled from an absence of evidence. The model step offers what the fleet's own
    // published account serves — real, declared models — and nothing is selected.
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'models');
    expect(absent(surface.container, '[data-fleet-prefill="models"]')).toBe(true);
    expect(chooser(surface.container, '-default-model').value).toBe('');
    await surface.unmount();
  });

  it('opens the stepper already filled in from what this host has', async () => {
    // Arrange — the whole point. RED before this: the person typed the harness, both model fields, the
    // asset path and the entire instructions document by hand, from a daemon that knew all four.
    const surface = await open({});

    // Act
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);

    // Assert — the harness step is answered, and says on what evidence.
    expect(stepperStep(surface.container)).toBe('harness');
    expect(cardChosen(surface.container, 'harness', 'claude')).toBe(true);
    expect(pick(surface.container, '[data-fleet-harness-detection="detected"]').textContent).toContain(
      '/usr/local/bin/claude',
    );

    // Act — the ONE thing left to type.
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');

    // Assert — the wrapper the daemon will derive, shown rather than asked for.
    expect(pick(surface.container, '[data-fleet-derived-wrapper]').textContent).toBe('claude-atelier');

    // Assert — the models the host named are already chosen, with their provenance.
    await walkTo(surface.container, 'models');
    expect(cardChosen(surface.container, 'models', 'claude-opus-5')).toBe(true);
    expect(cardChosen(surface.container, 'models', 'claude-sonnet-5')).toBe(true);
    expect(chooser(surface.container, '-default-model').value).toBe('claude-opus-5');
    expect(pick(surface.container, '[data-fleet-prefill="models"]').textContent).toContain(
      '/home/pilot/.claude/settings.json',
    );

    // Assert — the document is this host's own, under a name derived from the account and the lane.
    await walkTo(surface.container, 'instructions');
    expect(cardChosen(surface.container, 'instructions-source', 'import')).toBe(true);
    expect(area(surface.container, '-text').value).toBe('# House rules\n');
    expect(field(surface.container, '-middle').value).toBe('atelier');
    expect(pick(surface.container, '[data-fleet-instructions-name-note]').textContent).toContain(
      'instructions/CLAUDE-atelier.md',
    );
    expect(pick(surface.container, '[data-fleet-prefill="instructionsText"]').textContent).toContain(
      '/home/pilot/.claude/CLAUDE.md',
    );
    await surface.unmount();
  });

  it('asks one question per step, and refuses to move on before this step is answered', async () => {
    // The rule the whole sequence rests on: Next is blocked by something on THIS screen, never by a
    // field three steps away. RED before the stepper: one screen, ten fields, and a submit control
    // disabled by whichever of them was empty.
    const surface = await open({});
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);

    // Act — the harness step has a preselected answer, so it advances.
    await next(surface.container);

    // Assert — the account step does not, because it has no name yet, and it says so HERE.
    expect(stepperStep(surface.container)).toBe('identity');
    expect(button(surface.container, 'Next').hasAttribute('disabled')).toBe(true);
    expect(pick(surface.container, '[data-fleet-problems]').textContent).toContain('name the provider account');

    // Act
    await type(field(surface.container, '-name'), 'atelier');

    // Assert
    expect(button(surface.container, 'Next').hasAttribute('disabled')).toBe(false);
    await next(surface.container);
    expect(stepperStep(surface.container)).toBe('models');
    await surface.unmount();
  });

  it('keeps every entry when a person goes back, and lets them jump back to a step they answered', async () => {
    // Going back must be free, or nobody uses it and the sequence becomes a one-way form with extra
    // clicks. Every step reads and writes the ONE draft the surface holds, which is what makes it free.
    const surface = await open({});
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await type(field(surface.container, '-display-name'), 'Atelier Claude');
    await walkTo(surface.container, 'instructions');
    await type(field(surface.container, '-middle'), 'house');

    // Act — back, twice.
    await click(button(surface.container, 'Back'));
    await click(button(surface.container, 'Back'));

    // Assert — the account step still holds both entries.
    expect(stepperStep(surface.container)).toBe('identity');
    expect(field(surface.container, '-name').value).toBe('atelier');
    expect(field(surface.container, '-display-name').value).toBe('Atelier Claude');

    // Act — the progress indicator jumps back to an answered step, and forward again.
    await walkTo(surface.container, 'instructions');
    expect(field(surface.container, '-middle').value).toBe('house');
    await click(pick(surface.container, '[data-fleet-step-jump="harness"]'));

    // Assert
    expect(stepperStep(surface.container)).toBe('harness');
    await walkTo(surface.container, 'instructions');
    expect(field(surface.container, '-middle').value).toBe('house');
    await surface.unmount();
  });

  it('asks how the account runs, and derives the lane and the wrapper from the answer', async () => {
    // `lane` and `mode` are two fields expressing one thing on an ordinary fleet, and `lane` is a word
    // nobody outside the configuration schema has. One control, and the lane follows.
    const surface = await open({ config: () => ({ variants: { default: {}, auto: {} }, agents: [] }) });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');

    // Assert — the fleet declares an `auto` lane and the draft opens on `auto`, so that is the lane.
    expect(cardChosen(surface.container, 'mode', 'auto')).toBe(true);
    expect(pick(surface.container, '[data-fleet-derived-wrapper]').textContent).toBe('claude-auto-atelier');

    // Act
    await click(card(surface.container, 'mode', 'interactive'));

    // Assert — no lane control was ever shown, and the wrapper moved with the answer.
    expect(pick(surface.container, '[data-fleet-derived-wrapper]').textContent).toBe('claude-atelier');
    expect(absent(surface.container, '[data-fleet-other-lanes]')).toBe(true);
    await surface.unmount();
  });

  it('offers a lane control only when this fleet declares one no answer would derive', async () => {
    // A surface that cannot express what the configuration can is the reason somebody edits YAML by
    // hand. A `review` lane is not derivable from "interactive or auto", so the escape appears.
    const surface = await open({ config: () => ({ variants: { default: {}, review: {} }, agents: [] }) });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');

    expect(pick(surface.container, '[data-fleet-other-lanes]')).toBeDefined();
    // Per ACCOUNT: with two of them in play a single lane control would have no answer to "which one".
    await choose(chooser(surface.container, '-lane-auto'), 'review');
    expect(pick(surface.container, '[data-fleet-derived-wrapper]').textContent).toBe('claude-review-atelier');
    await surface.unmount();
  });

  it('creates one account per ticked mode from a single pass, and says both names before the recap', async () => {
    // The owner's words: ticking both creates TWO accounts from one pass, instead of running the flow
    // twice. Both wrapper names are shown on the step that asks, not discovered at the end.
    const surface = await open({ config: () => ({ variants: { default: {}, auto: {} }, agents: [] }) });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');

    // Act — the draft opens on "auto"; ticking "interactive" as well is the second account.
    await click(card(surface.container, 'mode', 'interactive'));

    // Assert — two wrappers and two homes, named rather than counted.
    const wrappers = [...surface.container.querySelectorAll('[data-fleet-derived-wrapper]')].map(
      node => node.textContent,
    );
    expect(wrappers).toEqual(['claude-atelier', 'claude-auto-atelier']);
    expect(cardChosen(surface.container, 'mode', 'auto')).toBe(true);
    expect(cardChosen(surface.container, 'mode', 'interactive')).toBe(true);
    await surface.unmount();
  });

  it('sends ONE proposal carrying both lanes, not two proposals', async () => {
    // Two proposals would mean two reviews and — for a caller this host's grants govern — two
    // operator-password confirmations for one decision a person made once.
    const surface = await open({
      propose: () => proposal(),
      config: () => ({ variants: { default: {}, auto: {} }, agents: [] }),
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await click(card(surface.container, 'mode', 'interactive'));
    await walkTo(surface.container, 'review');
    await click(button(surface.container, 'Preview this change'));

    // Assert
    const proposals = surface.daemon.calls.filter(call => call.path.endsWith('/proposals'));
    expect(proposals).toHaveLength(1);
    const sent = must(proposals[0], 'the one proposal').body as { mutation: { lanes: unknown } };
    expect(sent.mutation.lanes).toEqual([
      { variant: 'default', mode: 'interactive' },
      { variant: 'auto', mode: 'auto' },
    ]);
    await surface.unmount();
  });

  it('accepts a model this host has never heard of, and marks it unverified', async () => {
    // "What if it is a custom model?" A person running something we do not know about must not be
    // blocked — and an identifier nothing on this host names must not be presented as if it were checked.
    const surface = await open({});
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'models');

    // Act
    await type(field(surface.container, '-custom-model'), 'my-local-llm');
    expect(pick(surface.container, '[data-fleet-custom-model-note]').textContent).toContain('marked unverified');
    await click(pick(surface.container, '[data-fleet-add-model]'));

    // Assert — it is selected, it is offered as a card like any other, and it says what it is.
    expect(cardChosen(surface.container, 'models', 'my-local-llm')).toBe(true);
    expect(pick(surface.container, '[data-fleet-unverified]').textContent).toContain('my-local-llm');
    expect(
      pick(surface.container, '[data-fleet-check-group="models"] [data-fleet-check="my-local-llm"]').textContent,
    ).toContain('unverified');
    // A detected one carries no such marker: the difference is the whole point of the word.
    expect(
      pick(surface.container, '[data-fleet-check-group="models"] [data-fleet-check="claude-opus-5"]').textContent,
    ).not.toContain('unverified');

    // And the same value cannot be added twice, which would produce two identical-looking rows.
    await type(field(surface.container, '-custom-model'), 'my-local-llm');
    expect(pick(surface.container, '[data-fleet-custom-model-note]').textContent).toContain('already listed');
    expect(pick(surface.container, '[data-fleet-add-model]').hasAttribute('disabled')).toBe(true);
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

    // Assert
    expect(pick(surface.container, '[data-fleet-harness-detection="none-installed"]').textContent).toContain(
      'Neither claude nor codex is on this host’s PATH',
    );

    // Act — and it does not block: the sequence still reaches the recap.
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'review');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });

  it('reads a store document the account is pointed at, rather than writing over it', async () => {
    // Arrange — the fleet has a document more than one account can read. Pointing at it must load it:
    // until the text is here, staging would replace somebody's house rules with an empty string.
    const surface = await open({
      assets: () => ({ files: [{ path: 'instructions/house-rules.md', bytes: 12, readable: true }], complete: true }),
      asset: path => ({ path, content: '# Shared rules\n', bytes: 15 }),
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'instructions');

    // Act — "use one already in the store", which lands on the one that is there.
    await click(card(surface.container, 'instructions-source', 'existing'));
    await interact(() => undefined);

    // Assert — the document's own text is here, and the consequence of sharing it was said at the point
    // of choice rather than after the fact.
    expect(area(surface.container, '-text').value).toBe('# Shared rules\n');
    expect(surface.container.textContent).toContain('Editing it changes every account linked to it, on the next apply');
    expect(surface.container.textContent).not.toContain('has not loaded the document already at that path');
    expect(surface.daemon.paths()).toContain('/v1/fleet/assets/instructions%2Fhouse-rules.md');
    await walkTo(surface.container, 'review');
    expect(button(surface.container, 'Preview this change').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });

  it('keeps a store document that could not be read blocking, in the daemon own words', async () => {
    // Arrange — a refused read must not leave an empty box that looks like the document's contents.
    const surface = await open({
      assets: () => ({ files: [{ path: 'instructions/house-rules.md', bytes: 12, readable: true }], complete: true }),
      asset: () => {
        throw refusal('fleet_asset_refused', 'the asset is not a regular file');
      },
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'instructions');

    // Act
    await click(card(surface.container, 'instructions-source', 'existing'));
    await interact(() => undefined);

    // Assert — the blocker lands on THIS step, because this step's field is what names the path.
    expect(surface.container.textContent).toContain('the asset is not a regular file');
    expect(button(surface.container, 'Next').hasAttribute('disabled')).toBe(true);

    // Act — going back to this account's own new document clears it: nothing is overwritten any more.
    await click(card(surface.container, 'instructions-source', 'import'));

    // Assert
    expect(field(surface.container, '-middle').value).toBe('atelier');
    expect(button(surface.container, 'Next').hasAttribute('disabled')).toBe(false);
    await surface.unmount();
  });

  it('refuses a document name that collides with one the store already has, and names it', async () => {
    // RED before the stepper: the create form let a person type any path, so `instructions/shared.md`
    // staged a new lane's text over a shared document. Now the name is refused where it is typed, and
    // the sentence points at the one control that resolves it.
    const surface = await open({
      assets: () => ({ files: [{ path: 'instructions/CLAUDE-shared.md', bytes: 9, readable: true }], complete: true }),
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'instructions');

    // Act
    await type(field(surface.container, '-middle'), 'shared');

    // Assert
    const note = pick(surface.container, '[data-fleet-instructions-name-note]');
    expect(note.textContent).toContain('instructions/CLAUDE-shared.md');
    expect(note.textContent).toContain('is already in the store');
    expect(note.textContent).toContain('Use an existing one');

    // A name that is not there yet is the ordinary case: a new account writing its own instructions.
    await type(field(surface.container, '-middle'), 'atelier');
    expect(pick(surface.container, '[data-fleet-instructions-name-note]').textContent).toContain(
      'Added to the store as instructions/CLAUDE-atelier.md',
    );
    await surface.unmount();
  });

  it('fixes the CLAUDE- and AGENTS- prefix rather than asking a person to type it', async () => {
    // The owner asked for the prefix fixed and the middle theirs. Which prefix follows from the harness,
    // so a store somebody can read is a property of the scheme rather than of everyone's discipline.
    const surface = await open({});
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'instructions');
    expect(pick(surface.container, '[data-fleet-instructions-prefix]').textContent).toBe('CLAUDE-');

    // Act — the other harness names its document the other way, and nobody chose that either.
    await click(pick(surface.container, '[data-fleet-step-jump="harness"]'));
    await click(card(surface.container, 'harness', 'codex'));
    await walkTo(surface.container, 'instructions');

    // Assert
    expect(pick(surface.container, '[data-fleet-instructions-prefix]').textContent).toBe('AGENTS-');
    expect(pick(surface.container, '[data-fleet-instructions-name-note]').textContent).toContain(
      'instructions/AGENTS-atelier.md',
    );
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
      lanes: [{ variant: 'default', mode: 'auto' }],
      models: ['claude-opus-5', 'claude-sonnet-5'],
      defaultModel: 'claude-opus-5',
      layer: { memory: 'instructions/CLAUDE-atelier.md' },
    });
    expect(sent.assetEdits).toEqual([{ path: 'instructions/CLAUDE-atelier.md', content: '# House rules\n' }]);
    // No account id is ever sent: the daemon mints identity.
    expect(Object.keys(sent.mutation)).not.toContain('id');
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    expect(surface.container.textContent).toContain('01');
    await surface.unmount();
  });

  it('recaps every answer before asking the daemon for a plan', async () => {
    // The recap is not the review — the daemon's preview is, and it is unchanged. This is the last look
    // at the answers, so a wrong turn six steps back is visible before a round trip rather than after.
    const surface = await open({ propose: () => proposal() });
    await draftIn(surface);
    const recap = pick(surface.container, '[data-fleet-recap]').textContent ?? '';
    expect(recap).toContain('claude-atelier');
    expect(recap).toContain('claude-opus-5');
    expect(recap).toContain('instructions/CLAUDE-atelier.md');
    expect(recap).toContain('the fleet’s, unchanged');
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

  it('offers the skills store per item, with who already links each one, and says what is not possible yet', async () => {
    const surface = await open({
      config: () =>
        config({
          default: { id: account().id, wrapper: 'claude-studio', layer: { skills: 'skills/studio' } },
        }),
      assets: () => ({
        files: [
          { path: 'skills/studio/review.md', bytes: 12, readable: true },
          { path: 'skills/research/read.md', bytes: 12, readable: true },
        ],
        complete: true,
      }),
    });
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'skills');

    // Assert — a declared directory carries its linkers; one that is only in the tree is offered as an
    // item nothing links yet, which is exactly the item a new account most wants.
    expect(
      pick(surface.container, '[data-fleet-check-group="skills"] [data-fleet-check="skills/studio"]').textContent,
    ).toContain('claude-studio');
    expect(
      pick(surface.container, '[data-fleet-check-group="skills"] [data-fleet-check="skills/research"]').textContent,
    ).toContain('linked by nothing yet');
    // The gap is stated where it bites, and it is careful about WHOSE gap it is: #373 made the fleet
    // able to give an account several items, so a sentence blaming the fleet would now be false.
    const limit = pick(surface.container, '[data-fleet-skills-limit]').textContent ?? '';
    expect(limit).toContain('One store item at a time, on this screen');
    expect(limit).toContain('not a limit of the fleet');

    // Act
    await click(card(surface.container, 'skills', 'skills/research'));

    // Assert
    expect(cardChosen(surface.container, 'skills', 'skills/research')).toBe(true);
    await walkTo(surface.container, 'review');
    expect(pick(surface.container, '[data-fleet-recap]').textContent).toContain('skills/research');
    await surface.unmount();
  });

  it('asks whether to change settings at all, rather than showing a layer', async () => {
    // `layer` is a real mechanism and the wrong thing to put in front of a person. Two answers, and the
    // stack stays underneath both of them.
    const surface = await open({});
    await click(pick(surface.container, '[data-fleet-start-create]'));
    await interact(() => undefined);
    await walkTo(surface.container, 'identity');
    await type(field(surface.container, '-name'), 'atelier');
    await walkTo(surface.container, 'settings');

    // Assert — the default answer changes nothing, and there is no JSON box to be frightened by.
    expect(cardChosen(surface.container, 'settings', 'fleet')).toBe(true);
    expect(surface.container.querySelector('[id$="-settings"]')).toBeNull();
    // Scoped to the sequence: the roster behind it still offers "Edit layer" for an account that exists,
    // and that control is not what the owner objected to.
    expect(pick(surface.container, '[data-fleet-account-stepper]').textContent).not.toContain('layer');

    // Act
    await click(card(surface.container, 'settings', 'own'));

    // Assert — the box appears, seeded with something that parses.
    expect(area(surface.container, '-settings').value).toBe('{}');
    await type(area(surface.container, '-settings'), '{ not json');
    expect(pick(surface.container, '[data-fleet-problems]').textContent).toContain('settings must be valid JSON');
    expect(button(surface.container, 'Next').hasAttribute('disabled')).toBe(true);
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

  /**
   * Takes the action, then answers the prompt it raises.
   *
   * TWO STEPS, because that is now the shape: the panel carries no password field, and the modal arrives
   * at the moment authority is needed rather than sitting inside the staged-change card.
   */
  const applyWith = async (surface: Awaited<ReturnType<typeof staged>>, secret: string): Promise<void> => {
    await click(pick(surface.container, '[data-fleet-apply]'));
    await unlockWith(surface.container, secret);
    await interact(() => undefined);
  };

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
    expect(absent(surface.container, 'input')).toBe(true);
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
    await applyWith(surface, 'correct horse battery');

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
    // The limiter is stated ONCE, where the password is typed — not beside every control the unlock
    // then covers. A note at each control is what made a `sudo` gate read as per-action authorisation.
    expect(surface.container.textContent).not.toContain(UNLOCK_LIMIT_NOTE);
    // ONE field on the whole panel, so the human cannot be asked twice.
    expect(surface.container.querySelector('input')).toBeNull();

    // Act — typed once, clicked once.
    await applyWith(surface, 'correct horse battery');

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
    expect(absent(surface.container, 'input')).toBe(true);
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
    await applyWith(surface, 'correct horse battery');

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
    await applyWith(surface, 'correct horse battery');
    expect(surface.daemon.paths().filter(path => path === '/v1/grants/unlock')).toHaveLength(1);

    // Act — a SECOND change, staged and applied with the same screen.
    await click(button(surface.container, 'Edit layer'));
    await interact(() => undefined);
    await type(field(surface.container, '-instructions-path'), 'instructions/studio.md');
    await click(button(surface.container, 'Preview this change'));
    await applyWith(surface, 'correct horse battery');

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
    await applyWith(surface, 'wrong horse battery');

    // Assert — no apply was attempted, the daemon's own sentence is on screen with its number, and the
    // change is still staged with a field to retype into.
    expect(surface.daemon.paths().some(path => path.endsWith('/apply'))).toBe(false);
    expect(pick(surface.container, '[data-grant-unlock-failure]').textContent).toContain('4 attempts remaining');
    expect(pick(surface.container, '[data-fleet-proposal-id]')).toBeDefined();
    // The prompt STAYS UP with the reason inside it, so the retype happens where the failure is read.
    expect(pick(surface.container, '[role="dialog"]')).toBeDefined();
    expect(unlockField(surface.container).value).toBe('');
    await surface.unmount();
  });

  it('says a daemon that stopped checking has stopped, rather than inviting more guesses', async () => {
    const surface = await staged({
      permissions: () => lockedPermissions(),
      unlock: () => {
        throw refusal('grant_rate_limited', 'too many wrong operator passwords; try again in 15 minutes', 429);
      },
    });
    await applyWith(surface, 'wrong horse battery');
    expect(pick(surface.container, '[data-grant-unlock-failure]').getAttribute('data-grant-unlock-failure')).toBe(
      'final',
    );
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
    expect(absent(surface.container, 'input')).toBe(true);
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
    expect(absent(surface.container, 'input')).toBe(true);

    // Act
    await click(pick(surface.container, '[data-fleet-apply]'));
    await interact(() => undefined);

    // Assert — the refusal is worded as the FLEET refusal it is (the guard refused the request; nobody
    // typed anything wrong), and the panel now offers the unlock that resolves it.
    expect(pick(surface.container, '[data-fleet-refusal]').textContent).toContain('needs the operator password');
    expect(absent(surface.container, '[data-grant-unlock-failure]')).toBe(true);
    expect(pick(surface.container, '[data-fleet-authority-mode]').getAttribute('data-fleet-authority-mode')).toBe(
      'locked',
    );

    // And the way out works from there: one password, one mint, one apply.
    await applyWith(surface, 'correct horse battery');
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
    await walkTo(surface.container, 'identity');
    const name = field(surface.container, '-name');
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
    // ONE ACTION AND A LIST. Not the review panel: no expiry, no revision, no staged-change framing —
    // and the paths it will write, because that is the disclosure rather than the ceremony.
    expect(absent(surface.container, '[data-fleet-first-run]')).toBe(false);
    expect(absent(surface.container, '[data-fleet-side="proposed"]')).toBe(true);
    const staged = surface.container.textContent ?? '';
    expect(staged).toContain('Prepare this host');
    expect(staged).toContain('never replaces a file');
    expect(staged).toContain('/home/pilot/.ferretry/fleet/bin');
    expect(staged).not.toContain('Staged change');
    expect(staged).not.toContain('Expires');
    expect(staged).not.toContain('Config revision');
    // The live region says what is true of a first run rather than announcing a review.
    expect(pick(surface.container, '[data-fleet-announcement]').textContent).toContain('ready to be prepared');
    expect(pick(surface.container, '[data-fleet-apply]').textContent).toContain('Create these files');

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
    await click(pick(mounted.container, '[data-fleet-apply]'));
    await unlockWith(mounted.container, 'correct horse battery');
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
    await click(pick(mounted.container, '[data-fleet-apply]'));
    await unlockWith(mounted.container, 'correct horse battery');
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
