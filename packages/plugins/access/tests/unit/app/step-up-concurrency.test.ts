import { expect, test } from 'bun:test';
import { daemonConnection } from '../../../app/shell-grants.ts';
import { StepUpGate } from '../../../app/lib/step-up-gate.ts';
const machine = (name: string) =>
  daemonConnection({ daemonId: name, baseUrl: `https://${name}.example`, deviceId: 'synthetic-device' });
const first = machine('first');
const second = machine('second');
function setup() {
  const pending: { resolve: () => void; reject: (reason: unknown) => void }[] = [];
  const gate = new StepUpGate({
    ceremony: () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
    describe: () => 'Confirmation refused.',
  });
  return { gate, pending };
}
test('E-396 inline unlock preserves the other machine prompt including its failure', async () => {
  const { gate, pending } = setup();
  void gate.require(second);
  const failed = gate.confirm();
  pending[0]!.reject(new Error('synthetic failure'));
  await failed;
  const shown = gate.snapshot();
  const inline = gate.confirmInline(first);
  pending[1]!.resolve();
  await inline;
  expect(gate.snapshot()).toBe(shown);
});
test('E-397 inline and modal presses share one ceremony per machine', async () => {
  const { gate, pending } = setup();
  const waiting = gate.require(first);
  const modal = gate.confirm();
  const inline = gate.confirmInline(first);
  const again = gate.confirmInline(first);
  expect(pending).toHaveLength(1);
  pending[0]!.resolve();
  await Promise.all([modal, inline, again]);
  expect(await waiting).toBe(true);
});
test('E-397 inline first and modal share refusals without unlocking waiting requests', async () => {
  const { gate, pending } = setup();
  let settled = false;
  void gate.require(first).then(() => {
    settled = true;
  });
  const inline = gate.confirmInline(first);
  const modal = gate.confirm();
  expect(pending).toHaveLength(1);
  pending[0]!.reject(new Error('synthetic failure'));
  await modal;
  expect(await inline).toBe('Confirmation refused.');
  expect(settled).toBe(false);
  expect(gate.snapshot()?.failure).toBe('Confirmation refused.');
  const retry = gate.confirm();
  expect(pending).toHaveLength(2);
  pending[1]!.resolve();
  await retry;
});

test('E-397 inline success clears a previous cancel even when no requests currently wait', async () => {
  const gate = new StepUpGate({ ceremony: async () => {}, describe: () => '' });
  gate.focus(first.daemonId);
  const cancelled = gate.require(first);
  gate.dismiss();
  expect(await cancelled).toBe(false);
  await gate.confirmInline(first);
  void gate.require(first, 'read', 'background');
  expect(gate.snapshot()?.daemon.daemonId).toBe(first.daemonId);
});
