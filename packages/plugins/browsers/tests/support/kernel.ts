import type { ActRecord } from '@ferretry/kernel/testing';
import { TestMintedIds, testActRunner } from '@ferretry/kernel/testing';
import type { Actor, Clock, KernelPorts, RefusalCode, TargetRef } from '@ferretry/kernel/contract';
import { wallClock } from './wall-clock.ts';

/** Same-width `*` over each secret, the way the Vault's redaction masks a read (S16). */
const mask = (secrets: readonly string[]) => (text: string): string =>
  secrets.reduce((masked, secret) => (secret === '' ? masked : masked.split(secret).join('*'.repeat(secret.length))), text);

/**
 * The three kernel ports the browser tools take (`act`, `redaction`, `clock`), as the test host binds them: the real
 * test act runner (one queue per target, `InputHolds.decide` right before the act, `closeAck` on a write-only op), a
 * stand-in Vault redaction that masks the given secrets, and holds a test can set per target.
 */
export function browserKernel(options: { readonly secrets?: readonly string[]; readonly clock?: Clock; readonly actor?: Actor } = {}) {
  const acts: ActRecord[] = [];
  const held = new Map<string, RefusalCode>();
  const keyOf = (target: TargetRef): string => `${target.kind}\u0000${target.key}`;
  const scope = mask(options.secrets ?? []);
  const kernel: Pick<KernelPorts, 'act' | 'redaction' | 'clock'> = {
    act: testActRunner({
      holds: () => ({
        decide: target => {
          const code = held.get(keyOf(target));
          return code === undefined ? 'allow' : { refused: code };
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
    hold: (target: TargetRef, code: RefusalCode) => held.set(keyOf(target), code),
    release: (target: TargetRef) => held.delete(keyOf(target)),
  };
}
