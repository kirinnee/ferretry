import { SessionModes } from '@ferretry/kernel/contract';
import { definePlugin, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import { AsksChanged, AsksPort } from '@ferretry/core-asks/contract';
import { Credentials, GatePort, StepUp } from '@ferretry/core-gate/contract';
import { ConnectionsPort } from '@ferretry/plugin-connections/contract';
import {
  ACCESS_WORDS,
  AccessPort,
  PairingWindowPort,
  AskBuzzesFile,
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

  // Asks: the ask buzz (a card's ask, a buzzed notice) is Access's, so the owner's phone hears it with Agenda off.
  needs: { gate: GatePort, asks: AsksPort },
  uses: { connections: ConnectionsPort },
  provides: { access: AccessPort, pairingWindow: PairingWindowPort },

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
      // The daemon makes `fy pair --open`'s redirect page, so it is pinned before the write returns (docs/pairing.md).
      route('POST /v1/pair/redirect', {
        minimum: 'admin-token',
        // Pinned to the host by the carrier it arrived on: the admin bearer over a relay, a tunnel or WebRTC is refused.
        privilegedOnly: true,
        caller: 'person',
        noStore: true,
        audit: SKIP_UNRECORDED,
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
      verb('pair', {
        summary: 'pair a phone or another device with this machine',
        args: [],
        options: [
          { flag: '--large', help: 'draw the QR at full size, for a camera that will not focus on the compact one' },
          { flag: '--no-wait', help: 'print the code and exit instead of staying to report the scan' },
          {
            flag: '--limited',
            help: 'give the new device read-and-chat only, instead of full access behind its unlock',
          },
          {
            flag: '--open',
            help: "open the pairing link in this host's browser — for when the daemon and the browser are the same machine",
          },
        ],
      }),
      verb('device ls', {
        default: true,
        summary: 'list the devices that may reach this machine',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead of the human report' }],
      }),
      verb('device grant', {
        summary: 'change what one device may do',
        args: [
          { name: 'device', help: 'a device id, or a device name when exactly one device has that name' },
          {
            name: 'capability',
            help: 'the capability: fleet, terminal, browser, filesystem, warden, pairing, secrets, sharing or voice',
          },
        ],
        options: [
          { flag: '--use', help: 'let this device exercise the capability' },
          { flag: '--no-use', help: 'stop this device exercising the capability' },
          { flag: '--configure', help: "let this device change the capability's host settings" },
          { flag: '--no-configure', help: "stop this device changing the capability's host settings" },
        ],
      }),
      verb('device revoke', {
        summary: "take one device's access away",
        args: [{ name: 'device', help: 'a device id, or a device name when exactly one device has that name' }],
        options: [{ flag: '-y, --yes', help: 'skip the typed confirmation; required when not on a terminal' }],
      }),
      verb('passkey', { summary: "this machine's passkeys", args: [] }),
      verb('passkey window', {
        summary: 'open a short window in which a device may add a passkey',
        args: [
          {
            name: 'device',
            help: 'the device that may add a passkey: its id, or its name when exactly one device has that name',
          },
        ],
      }),
    ],
  },

  ui: {
    // Daemon-less on purpose: the page a pairing link opens on a device that has no daemon yet (first contact is direct).
    // `chrome: 'none'`: drawn alone like the first run it is reached from (no drawer, bars or side column); the page carries its own Back.
    screens: [screen('pair', { path: '/pair', daemonless: true, chrome: 'none' })],
    settings: [
      settingsTab('devices', { icon: 'smartphone', group: 'devices-access', label: 'Devices', order: 20 }),
      // v4's order: Devices, then the limits that explain a refused control, then passkeys, then the log.
      settingsTab('grants', { icon: 'shield-check', group: 'devices-access', label: 'What devices may do', order: 21 }),
      settingsTab('security', { icon: 'lock', group: 'devices-access', label: 'Security', order: 22 }),
      settingsTab('audit', { icon: 'scroll-text', group: 'devices-access', label: 'Audit log', order: 23 }),
    ],
    panels: [
      panel('daemon.status', { id: 'new-devices', order: 5 }),
      panel('daemon.status', { id: 'unlock', order: 10 }),
      panel('daemon.status', { id: 'notifications-off', order: 20 }),
      // The same line under the Agenda header (`agenda.banner`, which Agenda offers): the page people open to be told.
      panel('agenda.banner', { id: 'agenda-notifications-off', order: 10 }),
      panel('device.settings', { id: 'notifications', order: 30 }),
      // The first-run step that offers this device a passkey (side client; skips when it holds one): `onboarding` below.
      panel('onboarding.step', { id: 'onboarding-passkey', order: 2 }),
      // The picture on Onboarding's last page ("You're set up"): the cheering ferret, in the `onboarding.end` slot it offers.
      panel('onboarding.end', { id: 'end-mascot', order: 1 }),
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
      /** The asks whose buzz went out, one line each: what keeps an ask from buzzing the phone twice. */
      AskBuzzesFile,
    ],
    readModels: ['devices'],
    publishes: [DevicesChanged],
    subscribes: [AsksChanged],
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

  // r10 O6b: the roomier passkey offer, as a client step of the setup flow (O1's contract).
  onboarding: [{ id: 'passkey', title: 'Passkey', order: 2, side: 'client', stepHost: true }],

  permissions: { network: [...PUSH_SERVICE_HOSTS, '*.push.apple.com', '*.notify.windows.com'] },
});
