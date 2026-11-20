/**
 * Registers the SWEEP scene on the Settings shell scene (`settings-shell-scene.tsx`): EVERY plugin's real settings tab is drawn by
 * its real app half in the real shell, over one fake machine that answers each read with a fixed fake body (no daemon, no
 * network, no real home, login or key; the bodies live in `sweep/answers-*.ts`). A read nobody scripted is answered
 * `404 not-found`, so the page shows its own "could not load" state instead of a made-up shape. Requests are kept on
 * `window.__fyRequests` so the sweep can say which reads a tab made (`FY_SETTINGS_SWEEP_REPORT`).
 *
 *   /d/ws/settings/<plugin>/<tab>?theme=<style>-<mode>
 *
 * The test's generated entry calls this BEFORE it imports the shell scene, which reads the registration once.
 */
import { generated } from '../../../src/generated/surfaces.ts';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { json } from '../../unit/client/fixtures.ts';
import { answer as answerA } from './sweep/answers-a.ts';
import { answer as answerB } from './sweep/answers-b.ts';
import { answer as answerC } from './sweep/answers-c.ts';

const requests: string[] = [];
(globalThis as { __fyRequests?: string[] }).__fyRequests = requests;

const answer = (request: TransportRequest): TransportAnswer | undefined => {
  const path = request.path.split('?')[0] ?? '';
  requests.push(`${request.method} ${request.path}`);
  if (path === '/v1/plugins' || path === '/v1/health' || path === '/v1/grants') return undefined;
  for (const part of [answerA, answerB, answerC]) {
    const answered = part(request);
    if (answered !== undefined) return answered;
  }
  if (request.method === 'GET')
    return json({ error: { code: 'not-found', message: 'not scripted in the sweep scene' } }, 404);
  return undefined;
};

export const registerSettingsSweep = (): void => {
  const real = generated.surfaces
    .filter(entry => (entry.manifest.ui?.settings ?? []).length > 0)
    .map(entry => entry.id);
  (globalThis as { __FY_SCENE__?: unknown }).__FY_SCENE__ = { real: ['gate', ...real], answer };
};
