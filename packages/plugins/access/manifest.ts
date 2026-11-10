import { SessionModes } from '@ferretry/kernel/contract';
import { definePlugin, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import { Credentials, GatePort, StepUp } from '@ferretry/core-gate/contract';
import { ConnectionsPort } from '@ferretry/plugin-connections/contract';
import {
  ACCESS_WORDS,
  AccessPort,
  AUDIT,
  DevicesChanged,
  DevicesFile,
  GrantAuditFile,
  PairingRedirectsFile,
  PasskeysFile,
  StepUpStages,
  PushFile,
  PushKeysFile,
  UnlocksFile,
  GUARD_NONE,
  NARROW,
  PUSH_SERVICE_HOSTS,
  SKIP_READ,
  SKIP_UNRECORDED,
  USE,
} from './contract/index.ts';

/**
 * Access (§2.3): lets your other devices in — pairing, devices, passkeys, unlock and what each device may do.
 *
 * Routes are copied from today's tables, descriptor for descriptor: `runtime/mounts/pairing.ts`, `push.ts`, and the
 * passkey, step-up and unlock ceremonies of `step-up.ts` (Access owns "passkeys, the unlock" in §2.3; Gate keeps the
 * step-up plumbing). The daemon-wide grants (`/v1/grants`) are Gate's (§4.13, §9.2) and are not declared here.
 */
export default definePlugin({
  id: 'access',
  title: 'Access',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['session-mode', 'credential-provider', 'view', 'command'],
  words: ACCESS_WORDS,

  needs: { gate: GatePort },
  uses: { connections: ConnectionsPort },
  provides: { access: AccessPort },

  actions: {
    routes: [
      route('POST /v1/pair/code', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.pairing,
        noStore: true,
        audit: { record: AUDIT.pairingCodeMinted },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/pair/code/:pairingId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.pairing,
        noStore: true,
        audit: { record: AUDIT.pairingCodeRevoked },
        guard: GUARD_NONE,
      }),
      route('GET /v1/pair/code/:pairingId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.pairing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/pair/devices', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.pairing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/pair/devices/:deviceId', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.pairing,
        noStore: true,
        audit: { record: AUDIT.deviceRevoked },
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/pair/devices/:deviceId/grants', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.pairing,
        noStore: true,
        audit: { record: AUDIT.grantsChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/pair/identity', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.pairing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/passkeys', {
        minimum: 'operator',
        caller: 'person',
        unlockExempt: true,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/passkeys', {
        minimum: 'operator',
        caller: 'person',
        unlockExempt: true,
        noStore: true,
        audit: { record: AUDIT.passkeyRegistered },
        guard: GUARD_NONE,
      }),
      route('POST /v1/passkeys/options', {
        minimum: 'operator',
        caller: 'person',
        unlockExempt: true,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/passkeys/registration-window', {
        minimum: 'admin-token',
        caller: 'person',
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/push/subscriptions', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/push/subscriptions', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { record: AUDIT.pushChanged },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/push/subscriptions/:pushId', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { record: AUDIT.pushChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/push/vapid', { minimum: 'operator', caller: 'any', audit: SKIP_READ, guard: GUARD_NONE }),
      route('POST /v1/step-up', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { record: AUDIT.stepUpSucceeded },
        guard: GUARD_NONE,
      }),
      route('POST /v1/step-up/options', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/unlock', {
        minimum: 'operator',
        caller: 'person',
        unlockExempt: true,
        noStore: true,
        audit: { record: AUDIT.stepUpSucceeded },
        guard: GUARD_NONE,
      }),
      route('POST /v1/unlock/options', {
        minimum: 'operator',
        caller: 'person',
        unlockExempt: true,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
    ],
    cli: [
      verb('pair', { summary: 'pair a phone or another device with this machine' }),
      verb('device ls', { summary: 'list the devices that may reach this machine' }),
      verb('device grant', { summary: 'change what one device may do' }),
      verb('device revoke', { summary: "take one device's access away" }),
      verb('passkey', { summary: "this machine's passkeys" }),
      verb('passkey window', { summary: 'open a short window in which a device may add a passkey' }),
    ],
  },

  ui: {
    // Daemon-less on purpose: the page a pairing link opens on a device that has no daemon yet (first contact is direct).
    screens: [screen('pair', { path: '/pair', daemonless: true })],
    settings: [
      settingsTab('devices', { label: 'Devices', order: 20 }),
      // v4's order: Devices, then the limits that explain a refused control, then passkeys, then the log.
      settingsTab('grants', { label: 'What devices may do', order: 21 }),
      settingsTab('security', { label: 'Security', order: 22 }),
      settingsTab('audit', { label: 'Audit log', order: 23 }),
    ],
    panels: [
      panel('daemon.status', { id: 'new-devices', order: 5 }),
      panel('daemon.status', { id: 'unlock', order: 10 }),
      panel('daemon.status', { id: 'notifications-off', order: 20 }),
      panel('device.settings', { id: 'notifications', order: 30 }),
    ],
  },

  /** Never reached by a ferret, through any root: passkeys, device records, unlocks, push keys and the live pairing redirect (`PrivacyDecl`). */
  privacy: {
    private: ['passkeys.json', 'push-keys.json', 'devices.json', 'unlocks.json', 'push.json', 'pairing-redirects'],
  },
  data: {
    state: [
      DevicesFile,
      PasskeysFile,
      UnlocksFile,
      PushFile,
      /** The VAPID key pair; the private half never leaves this file. */
      PushKeysFile,
      /** Device-grant and security changes, one line per axis, attributed to the actor (G150). */
      GrantAuditFile,
      PairingRedirectsFile,
    ],
    readModels: ['devices'],
    publishes: [DevicesChanged],
  },

  hooks: {
    takes: [
      { hook: Credentials, key: 'device' },
      { hook: StepUp, key: 'device' },
      { hook: SessionModes, key: 'device' },
      { hook: SessionModes, key: 'pair' },
    ],
    offers: [{ hook: StepUpStages }],
  },

  doctor: ['notifications'],

  permissions: { network: [...PUSH_SERVICE_HOSTS, '*.push.apple.com', '*.notify.windows.com'] },
});
