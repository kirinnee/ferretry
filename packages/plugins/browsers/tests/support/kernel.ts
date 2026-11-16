import type { ActRecord } from '@ferretry/kernel/testing';
import { TestMintedIds, testActRunner } from '@ferretry/kernel/testing';
import type { Actor, Clock, KernelPorts, Op, RefusalCode, TargetRef } from '@ferretry/kernel/contract';
import { wallClock } from './wall-clock.ts';

/** Same-width `*` over each secret, the way the Vault's redaction masks a read (S16). */
const mask =
  (secrets: readonly string[]) =>
  (text: string): string =>
    secrets.reduce(
      (masked, secret) => (secret === '' ? masked : masked.split(secret).join('*'.repeat(secret.length))),
      text,
    );

/**
 * The three kernel ports the browser tools take (`act`, `redaction`, `clock`), as the test host binds them: the real
 * test act runner (one queue per target, `InputHolds.decide` right before the act, `closeAck` on a write-only op), a
 * stand-in Vault redaction that masks the given secrets, and holds a test can set per target.
 */
export function browserKernel(
  options: { readonly secrets?: readonly string[]; readonly clock?: Clock; readonly actor?: Actor } = {},
) {
  const acts: ActRecord[] = [];
  const held = new Map<string, { readonly code: RefusalCode; readonly ops?: readonly Op[] }>();
  const keyOf = (target: TargetRef): string => `${target.kind}\u0000${target.key}`;
  const scope = mask(options.secrets ?? []);
  const kernel: Pick<KernelPorts, 'act' | 'redaction' | 'clock'> = {
    act: testActRunner({
      holds: () => ({
        decide: (target, op) => {
          const hold = held.get(keyOf(target));
          if (hold === undefined || (hold.ops !== undefined && !hold.ops.includes(op))) return 'allow';
          return { refused: hold.code };
        },
      }),
      actor: () => options.actor ?? 'ferret',
      minted: new TestMintedIds(),
      record: entry => acts.push(entry),
    }),
    redaction: {
      read: async fn => await fn({ text: scope, cells: grid => grid, lines: lines => lines.map(scope) }),
    },
    clock: options.clock ?? wallClock(),
  };
  return {
    kernel,
    acts,
    /** Refuses `ops` (every op when none are named) on `target` until released. */
    hold: (target: TargetRef, code: RefusalCode, ops?: readonly Op[]) =>
      held.set(keyOf(target), ops === undefined ? { code } : { code, ops }),
    release: (target: TargetRef) => held.delete(keyOf(target)),
  };
}
