/**
 * Registers ACCESS's fake answers on the Settings shell scene (`settings-shell-scene.tsx`), so Settings › Devices / What devices may
 * do / Security / Audit log are drawn by the REAL access and gate plugins in the real App, its real nav and its real panel width.
 * Every answer is fixed fake data (a fake machine, fake devices, a fake pairing code), never a real home, login or code.
 *
 *   /d/ws/settings/access/<devices|grants|security|audit>?theme=<style>-<mode>&state=<default|empty|refused|long>
 *
 * The test's generated entry calls this BEFORE it imports the shell scene, which reads the registration once.
 */
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { json } from '../../unit/client/fixtures.ts';
import {
  audit,
  grantsView,
  minted,
  pairedView,
  passkeys,
  security,
  stateOf,
  THIS_DEVICE,
} from './access-settings-data.ts';

const answer = (request: TransportRequest): TransportAnswer | undefined => {
  const path = request.path.split('?')[0];
  if (path === '/v1/grants') return json(grantsView);
  if (path === '/v1/pair/devices') return json(pairedView);
  if (path === '/v1/pair/code') return json(minted);
  if (path === '/v1/passkeys') return json(passkeys);
  if (path === '/v1/security') return json(security);
  if (path === '/v1/audit') {
    if (stateOf(window.location.search) === 'refused')
      return json({ error: { code: 'not-granted', message: 'pairing is off for devices' } }, 403);
    return json(audit);
  }
  return undefined;
};

export const registerAccessSettings = (): void => {
  (globalThis as { __FY_SCENE__?: unknown }).__FY_SCENE__ = { real: ['gate', 'access'], answer, deviceId: THIS_DEVICE };
};
