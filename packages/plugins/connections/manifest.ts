import { Carriers, DoctorChecks, type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { definePlugin, panel, route, settingsTab, socket, verb } from '@ferretry/kernel/manifest';
import {
  AUDIT,
  CarriersChanged,
  CONFIGURE,
  CONNECTIONS_WORDS,
  ConnectionsConfigSchema,
  ConnectionsPort,
  connectionsLoosens,
  GUARD_NONE,
  HOSTED_RELAY_DIRECTORY_ORIGIN,
  SKIP_READ,
  SKIP_SEALED,
  SKIP_UNRECORDED,
} from './contract/index.ts';

/**
 * Connections (§2.3): carries the app's sealed messages to a daemon from anywhere — direct, relay, tunnel, WebRTC.
 *
 * Routes copied from today's `runtime/mounts/{carriers,direct-carrier,tunnel,webrtc}.ts`. The direct carrier's
 * socket answers before any credential (`minimum: 'none'`): what crosses it is a sealed session the kernel opens
 * and proves; the carrier itself can never mark a call local (§4.8).
 */
export default definePlugin({
  id: 'connections',
  title: 'Connections',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['carrier', 'view', 'command'],
  words: CONNECTIONS_WORDS,

  provides: { connections: ConnectionsPort },

  actions: {
    routes: [
      route('GET /v1/carriers', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/tunnel', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('PUT /v1/tunnel', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.pairing,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/webrtc/offer', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
    ],
    sockets: [
      socket('GET /v1/rendezvous/:daemonId/client', {
        minimum: 'none',
        caller: 'any',
        audit: SKIP_SEALED,
        guard: GUARD_NONE,
      }),
    ],
    cli: [
      verb('tunnel status', { summary: "show whether this machine's Cloudflare tunnel is on, and where it is" }),
      verb('tunnel on', { summary: 'turn the tunnel on for this machine' }),
      verb('tunnel off', { summary: 'turn the tunnel off and release it' }),
    ],
  },

  ui: {
    settings: [settingsTab('connection', { label: 'Connection', order: 15 })],
    panels: [panel('daemon.status', { id: 'carrier', order: 20 })],
  },

  data: {
    state: [
      defineState({ name: 'tunnel', path: 'tunnel.json', store: 'json', format: 1 }),
      /** A cache of the hosted relay's runtime advertisement: rebuilt when unreadable, never trusted for long. */
      defineState({
        name: 'advertisement',
        path: 'advertisement.json',
        store: 'json',
        format: 1,
        onDamaged: { narrower: 'read as no advertisement: direct only, said out loud' },
      }),
    ],
    config: [
      defineConfig({
        file: 'connections.yaml',
        schema: ConnectionsConfigSchema,
        axis: 'configure',
        loosens: connectionsLoosens,
      }) as ConfigDef, // the leaf types `config` as ConfigDef<unknown>; `loosens` is contravariant
    ],
    readModels: ['carriers', 'tunnel'],
    publishes: [CarriersChanged],
  },

  hooks: {
    takes: [
      { hook: DoctorChecks },
      { hook: Carriers, key: 'direct' },
      { hook: Carriers, key: 'relay' },
      { hook: Carriers, key: 'tunnel' },
      { hook: Carriers, key: 'webrtc' },
    ],
  },

  permissions: {
    network: [new URL(HOSTED_RELAY_DIRECTORY_ORIGIN).host, { resolver: 'relay' }, 'stun.cloudflare.com'],
    spawn: ['cloudflared'],
  },
});
