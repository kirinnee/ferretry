/**
 * What carrier a member's join is counted on follows the carrier the SESSION opened on (G118): a join that came through
 * the tunnel is a `tunnel` join (its own, never the network's rate-limit key), and one on the network is `direct`.
 */
import { expect, test } from 'bun:test';
import type { CarrierKey } from '@ferretry/kernel/contract';
import { memberMode } from '../../../daemon/adapters/member-mode.ts';
import type { MemberJoinCarrier } from '../../../daemon/lib/catalog-members/member-session.ts';

test('G118 a member join through the tunnel is counted as a tunnel join, one on the network as direct', async () => {
  const seen: MemberJoinCarrier[] = [];
  const mode = memberMode({
    members: {} as never,
    passkeys: {} as never,
    live: {} as never,
    join: {
      options: async (_attempt: unknown, carrier: MemberJoinCarrier) => {
        seen.push(carrier);
        return { ok: false };
      },
    } as never,
  }).mode;
  const redeem = mode.redeem;
  if (redeem === undefined) throw new Error('the member mode redeems');
  const body = { act: 'join-options', code: 'fy_share_x', memberKey: 'k', origin: 'https://app.example' };
  const attempt = (carrier: string, peer: string) => ({
    proof: { mode: 'member', body },
    prove: async () => true,
    carrier: carrier as CarrierKey,
    peer,
  });

  await redeem(attempt('tunnel', '203.0.113.9') as never);
  await redeem(attempt('direct', '198.51.100.9') as never);
  await redeem(attempt('relay', 'relay') as never);

  expect(seen).toEqual([{ kind: 'tunnel' }, { kind: 'direct', rateLimitKey: '198.51.100.9' }, { kind: 'relay' }]);
});
