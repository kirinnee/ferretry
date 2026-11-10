import type { ConfigFileDef } from '@ferretry/kernel/contract';
import type { SelftestProbe } from '@ferretry/kernel/manifest';
import type { ConnectionsConfig } from '../../../contract/wire.ts';
import { describeWebRtcEngine } from '../../lib/webrtc/engine.ts';
import { type NodeDataChannelLoader, NodeDataChannelEngine } from './node-datachannel-engine.ts';

/**
 * THE ONE WEBRTC ENGINE SELFTEST `fyd --check` RUNS (DECISIONS-2 #22; the release smoke judges its `webrtc … engine ready`
 * line). Two loopback peers open a data channel and echo one message: the engine binds 127.0.0.1 only, with no ICE
 * server, so it sends nothing off this machine, binds nothing on the daemon's address and writes no state. It runs
 * ONLY under `fyd --check`, never at boot — a started engine holds native threads, and the carrier starts its own on
 * the first offer. The engine is released the moment the probe ends, so the library's threads go back too.
 *
 * `load` is for a suite that must not start the native library; production passes nothing.
 */
export function webrtcSelftestProbe(load?: NodeDataChannelLoader): SelftestProbe {
  return {
    label: 'webrtc',
    run: async ({ clock }) => {
      const engine = new NodeDataChannelEngine({ clock, ...(load === undefined ? {} : { load }) });
      try {
        return describeWebRtcEngine(await engine.selfTest());
      } finally {
        engine.release();
      }
    },
  };
}

export const webrtcSelftest: SelftestProbe = webrtcSelftestProbe();

/**
 * Whether the engine selftest runs: WebRTC on in `connections.yaml` as in effect (on unless it says `enabled: false`).
 * The kernel reads the file and calls this (`SelftestProbe.enabledBy`); the probe itself never sees the config.
 */
export const webrtcSwitchedOn = (value: unknown): boolean => (value as ConnectionsConfig).webrtc?.enabled !== false;

/** Today's switched-off line, after `webrtc       switched off in <path>`. */
const WEBRTC_OFF_CONSEQUENCE = 'devices reach this daemon directly or through the relay instead';

/** The probe, run only when `file` (Connections' own `connections.yaml` def) has WebRTC on. */
export function switchedWebrtcSelftest(
  file: ConfigFileDef<ConnectionsConfig>,
  probe = webrtcSelftestProbe(),
): SelftestProbe {
  return { ...probe, enabledBy: { def: file, on: webrtcSwitchedOn, consequence: WEBRTC_OFF_CONSEQUENCE } };
}
