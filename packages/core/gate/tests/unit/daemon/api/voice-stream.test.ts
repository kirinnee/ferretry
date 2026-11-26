import { expect, spyOn, test } from 'bun:test';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { daemonImplementations } from '../../../../../kernel/src/generated/plugins.ts';
import { FakeFerrets } from '../../../../../ferrets/contract/testing/index.ts';
import { FakeVault } from '../../../../../vault/contract/testing/index.ts';
import { fakeConversation } from '../../../../../../plugins/conversation/contract/testing/index.ts';
import { decodeDownlinkUnit, STREAM_CLOSES, VoicePort } from '../../../../../../plugins/voice/contract/index.ts';
import { FULL_DEVICE_GRANTS, DEFAULT_GATE_CONFIG } from '../../../../contract/index.ts';
import { holder } from '../../../../contract/testing/index.ts';
import { world } from '../support.ts';

const cutFleet = { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } };

for (const cut of ['device', 'machine'] as const) {
  test(`E-440 an ACTIVE Voice chat closes and releases its claim within the ${cut} fleet.use generation; Talk to test stays open`, async () => {
    const w = world();
    for (const id of ['phone', 'tester', 'replacement']) w.enrol(id);
    const ferrets = new FakeFerrets();
    ferrets.add({ id: 'fer-1' as FerretId });
    const clock = fixedClock();
    const plugin = daemonImplementations.find(plugin => plugin.manifest.id === 'voice');
    if (plugin === undefined) throw new Error('Voice is missing from the production registry');
    const h = await testHost({
      plugins: [plugin],
      gate: w.gate,
      clock,
      fakes: {
        ferrets,
        vault: new FakeVault(),
        gate: { policy: () => w.policy, audit: async () => undefined },
      },
      uses: { conversation: fakeConversation() },
      fetch: async () => {
        throw new Error('This probe must never call a provider');
      },
    });
    // Only native speech is synthetic: production Voice accept/session/registry and Gate admission run unchanged.
    const engine = h.provided(VoicePort).engine;
    const view = spyOn(engine, 'view').mockResolvedValue({ state: 'ready', machine: 'synthetic' } as never);
    const speech = spyOn(engine, 'detectSpeech').mockResolvedValue([]);
    const start = JSON.stringify({ t: 'start', v: 1, purpose: 'chat', ferretId: 'fer-1' });
    try {
      const chat = await h.socket('/v1/voice/stream', { as: { kind: 'device', holder: 'phone' } });
      const contender = await h.socket('/v1/voice/stream', { as: { kind: 'device', holder: 'replacement' } });
      chat.handler?.fromClient(start);
      await h.settle();
      await clock.advance(200);
      await clock.advance(200);
      contender.handler?.fromClient(start);
      await h.settle();
      expect(contender.closed).toEqual(STREAM_CLOSES.busy);
      const tester = await h.socket('/v1/voice/stream', { as: { kind: 'device', holder: 'tester' } });
      tester.handler?.fromClient(JSON.stringify({ t: 'start', v: 1, purpose: 'test' }));
      const snapshots = () => chat.frames.map(frame => decodeDownlinkUnit(frame as Uint8Array));
      expect(snapshots().at(-1)?.state).toBe('listening');
      expect(chat.closed).toBeUndefined();
      w.gate.policyChanged();
      expect(chat.closed).toBeUndefined();

      // No further microphone frame, turn or timer: ONE provider/policy generation closes the active chat.
      if (cut === 'device') {
        w.devices.narrow(holder('phone'), cutFleet);
        expect(chat.closed).toEqual(STREAM_CLOSES.forbidden);
        w.devices.narrow(holder('tester'), cutFleet);
      } else {
        w.policy = { ...DEFAULT_GATE_CONFIG, grants: cutFleet };
        w.gate.policyChanged();
      }
      expect(chat.closed).toEqual(STREAM_CLOSES.forbidden);
      expect(snapshots().at(-1)?.error?.code).toBe('fleet_not_granted');
      expect(tester.closed).toBeUndefined();
      const frames = chat.frames.length;
      w.gate.policyChanged();
      expect(chat.frames).toHaveLength(frames);
      // The closed stream freed its DEVICE slot even while that device still has only voice.use.
      const phoneTest = await h.socket('/v1/voice/stream', { as: { kind: 'device', holder: 'phone' } });
      expect(phoneTest.response).toBeUndefined();
      phoneTest.handler?.close();
      // Restore fleet.use, then a new stream must be able to claim the SAME ferret the closed chat held.
      w.policy = DEFAULT_GATE_CONFIG;
      w.gate.policyChanged();
      const replacement = await h.socket('/v1/voice/stream', { as: { kind: 'device', holder: 'replacement' } });
      replacement.handler?.fromClient(start);
      await h.settle();
      await clock.advance(200);
      await clock.advance(200);
      expect(replacement.closed).toBeUndefined();
      expect(replacement.frames.map(frame => decodeDownlinkUnit(frame as Uint8Array)).at(-1)?.state).toBe('listening');
    } finally {
      view.mockRestore();
      speech.mockRestore();
      await h.stop();
    }
  });
}
