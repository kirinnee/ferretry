import { implementDaemon } from '@ferretry/kernel/manifest';
import { HOSTED_APP_ORIGIN, StepUpStages } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { type AccessHost, AccessRuntime } from './runtime.ts';
import { pairingRedirectBoot } from './adapters/pairing/index.ts';

/**
 * The facts no port gives Access yet (see {@link AccessHost}): the app origins a passkey may answer for, and the
 * Ed25519 check a key rotation's proof needs. The daemon identity and the client's command name come from
 * `ctx.kernel.identity` inside the runtime.
 */
const pendingHost: AccessHost = {
  allowedOrigins: () => [HOSTED_APP_ORIGIN],
  ed25519: {
    verifyEd25519: async (publicKeySpki, signature, message) => {
      try {
        const key = await crypto.subtle.importKey('spki', new Uint8Array(publicKeySpki), { name: 'Ed25519' }, false, [
          'verify',
        ]);
        return await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), new Uint8Array(message));
      } catch {
        return false;
      }
    },
  },
};

/** Access's daemon half (§2.3): pairing, devices, passkeys, unlock, grants per device, push enrolments. */
export default implementDaemon(manifest, {
  build: ctx => {
    const access = new AccessRuntime({
      kernel: ctx.kernel,
      gate: ctx.needs.gate,
      connections: () => ctx.uses.connections.current(),
      host: pendingHost,
      stages: act => {
        const provided = ctx.hooks.provider(StepUpStages, act);
        return provided === 'unavailable' ? undefined : provided;
      },
    });
    const route = (key: string) => access.handler(key);
    return {
      ...pairingRedirectBoot(),
      routes: {
        'POST /v1/pair/code': route('POST /v1/pair/code'),
        'DELETE /v1/pair/code/:pairingId': route('DELETE /v1/pair/code/:pairingId'),
        'GET /v1/pair/code/:pairingId': route('GET /v1/pair/code/:pairingId'),
        'GET /v1/pair/devices': route('GET /v1/pair/devices'),
        'DELETE /v1/pair/devices/:deviceId': route('DELETE /v1/pair/devices/:deviceId'),
        'PATCH /v1/pair/devices/:deviceId/grants': route('PATCH /v1/pair/devices/:deviceId/grants'),
        'GET /v1/pair/identity': route('GET /v1/pair/identity'),
        'GET /v1/passkeys': route('GET /v1/passkeys'),
        'POST /v1/passkeys': route('POST /v1/passkeys'),
        'POST /v1/passkeys/options': route('POST /v1/passkeys/options'),
        'POST /v1/passkeys/registration-window': route('POST /v1/passkeys/registration-window'),
        'GET /v1/push/subscriptions': route('GET /v1/push/subscriptions'),
        'POST /v1/push/subscriptions': route('POST /v1/push/subscriptions'),
        'DELETE /v1/push/subscriptions/:pushId': route('DELETE /v1/push/subscriptions/:pushId'),
        'GET /v1/push/vapid': route('GET /v1/push/vapid'),
        'POST /v1/step-up': route('POST /v1/step-up'),
        'POST /v1/step-up/options': route('POST /v1/step-up/options'),
        'POST /v1/unlock': route('POST /v1/unlock'),
        'POST /v1/unlock/options': route('POST /v1/unlock/options'),
      },
      provides: { access: access.port },
      hooks: {
        'credentials:device': access.credentials,
        'step-up:device': access.witness,
        'session.modes:device': access.deviceMode,
        'session.modes:pair': access.pairMode,
      },
    };
  },
});
