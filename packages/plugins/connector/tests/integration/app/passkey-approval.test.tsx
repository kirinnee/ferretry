/**
 * APPROVING WITH A PASSKEY, FROM THE REAL TAB: the real Settings › Claude connector view over the REAL owner routes
 * (`daemon/routes/owner.ts`) and the real authority, for a GOVERNED device (a phone: never the owner at the machine).
 *
 * The client here does what the shell's client does and nothing else: it sends the call, and when the daemon answers
 * `403 grant_step_up_required` it asks the passkey (here, an authenticator that proves the named act) and resends ONCE.
 * Nothing in the tab knows a passkey exists; the act the daemon names (`approve-connector`) is the only thing proved.
 * A real daemon cannot show this over plain HTTP, because an HTTP caller at 127.0.0.1 is the owner and ungoverned
 * (`real-daemon-app.test.ts` is the other half).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Mounted } from '@ferretry/app/testing';
import { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import type { ApiResponse, CallContext } from '@ferretry/kernel/contract';
import { ConnectorSettings } from '../../../app/views/connector-settings.tsx';
import { ownerRoutes } from '../../../daemon/routes/owner.ts';
import { owner, signIn, world } from '../../support/world.ts';
import { click, mountSettled, text } from '../../unit/app/support.tsx';

const ON = { enabled: true, publicUrl: 'https://mcp.example.com', port: 7490 };

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** A paired phone's client over the real routes, with a passkey that proves only the act it is asked for. */
function phone(w: ReturnType<typeof world>) {
  const handlers = ownerRoutes(w.service) as unknown as Record<string, (call: CallContext) => Promise<ApiResponse>>;
  const proofs: string[] = [];
  const prompts: string[] = [];
  const calls: string[] = [];
  const send = async (route: string, params: Record<string, string> | undefined, body: unknown) =>
    await handlers[route]?.(owner({ params, body, governed: true, actor: 'device:dev_phone', proofs }));
  return {
    prompts,
    calls,
    proofs,
    client: {
      call: async <Answer = unknown>(
        route: string,
        init?: { readonly params?: Readonly<Record<string, string>>; readonly body?: unknown },
      ): Promise<Answer> => {
        calls.push(route);
        let answer = await send(route, init?.params ? { ...init.params } : undefined, init?.body);
        const needed =
          answer?.status === 403
            ? (JSON.parse(answer.body) as { code?: string; demand?: { act?: string } })
            : undefined;
        if (needed?.code === STEP_UP_REQUIRED_CODE && needed.demand?.act !== undefined) {
          prompts.push(needed.demand.act);
          proofs.push(needed.demand.act);
          answer = await send(route, init?.params ? { ...init.params } : undefined, init?.body);
        }
        if (answer === undefined || answer.status >= 400) {
          const refused = JSON.parse(answer?.body ?? '{}') as { error?: string; code?: string };
          throw Object.assign(new Error(refused.error ?? 'refused'), {
            status: answer?.status ?? 500,
            code: refused.code ?? 'refused',
          });
        }
        return JSON.parse(answer.body) as Answer;
      },
    },
  };
}

describe('Settings › Claude connector, approving from a phone', () => {
  test('Approve asks the passkey for `approve-connector` once, then the app is connected; Revoke ends it', async () => {
    const w = world(ON);
    await w.service.start();
    await signIn(w, 'E2E Claude');
    const { client, prompts, calls, proofs } = phone(w);
    mounted = await mountSettled(<ConnectorSettings client={client} focus={null} pollMs={600_000} />);
    const root = mounted.container;
    const [pending] = await w.service.authority.pending();
    expect(text(root, `[data-connector-pending="${pending?.id}"] [data-connector-match-code]`)).toBe(
      pending?.matchCode ?? 'missing',
    );

    await click(root, `[data-connector-approve="${pending?.id}"]`);
    expect(prompts, 'one passkey prompt, for the act the daemon named').toEqual([STEP_UP_ACTS.approveConnector]);
    expect(calls.filter(route => route.endsWith('/approve')).length, 'the same call, sent again once').toBe(1);
    expect(proofs, 'the proof was spent: one confirmation, one sign-in').toEqual([]);
    expect(root.querySelector('[data-connector-pending]')).toBeNull();
    const grant = root.querySelector('[data-connector-grant]');
    expect(grant?.textContent).toContain('E2E Claude');
    expect(grant?.textContent).toContain('Approved by a paired device');
    expect(w.events).toContainEqual(
      expect.objectContaining({ kind: 'connector.grant.approved', actor: 'device:dev_phone' }),
    );

    // Revoking only takes away: no passkey is asked.
    await click(root, '[data-connector-revoke]');
    await click(document.body, '[data-connector-revoke-confirm]');
    expect(prompts).toEqual([STEP_UP_ACTS.approveConnector]);
    expect(text(root, '[data-connector-revoked-label]')).toContain('Revoked');
    expect(root.querySelector('[data-connector-revoke]')).toBeNull();
  });

  test('Deny asks no passkey and removes the card', async () => {
    const w = world(ON);
    await w.service.start();
    await signIn(w);
    const { client, prompts } = phone(w);
    mounted = await mountSettled(<ConnectorSettings client={client} focus={null} pollMs={600_000} />);
    await click(mounted.container, '[data-connector-deny]');
    expect(prompts).toEqual([]);
    expect(mounted.container.querySelector('[data-connector-pending]')).toBeNull();
    expect(await w.service.authority.pending()).toEqual([]);
  });

  test('a passkey that was not confirmed approves nothing, and the tab says so in words', async () => {
    const w = world(ON);
    await w.service.start();
    await signIn(w);
    const { client } = phone(w);
    // A prompt the person cancels: the shell's client hands back the daemon's own refusal.
    const cancelled = {
      call: async <Answer = unknown>(route: string, init?: Parameters<typeof client.call>[1]): Promise<Answer> => {
        if (route.endsWith('/approve'))
          throw Object.assign(new Error('needs a passkey'), { status: 403, code: STEP_UP_REQUIRED_CODE });
        return await client.call<Answer>(route, init);
      },
    };
    mounted = await mountSettled(<ConnectorSettings client={cancelled} focus={null} pollMs={600_000} />);
    await click(mounted.container, '[data-connector-approve]');
    expect(text(mounted.container, '[data-connector-failure]')).toContain('the passkey wasn’t confirmed');
    expect(await w.service.authority.pending()).toHaveLength(1);
    expect(w.events.some(event => event.kind === 'connector.grant.approved')).toBe(false);
  });
});
