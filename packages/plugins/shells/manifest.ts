import { definePlugin, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  SHELLS_AUDIT,
  SHELLS_CACHE,
  SHELLS_CONFIG,
  SHELLS_LOCKS,
  SHELLS_READ_MODELS,
  SHELLS_WORDS,
  ShellBuilt,
  ShellsChanged,
  ShellsPort,
} from './contract/index.ts';
import { audit, cap } from '@ferretry/core-gate/contract';
import { LaunchParts } from '@ferretry/core-ferrets/contract';

/**
 * Shells (§2.3, §4.9): each ferret gets its own nix shell. NEW in 5.0, so there is no route table of today's to copy;
 * the descriptors follow the closest existing acts: reads are `fleet.use` like the component catalogue, and anything
 * that writes a source or runs a build is a person's `fleet.configure` act with the passkey step-up a governed device
 * needs (the owner's yes at install, and again when a resolved narHash changes: design §3.2). At run time it needs a
 * `runners` provider to enter the shell (no build edge; without one it says why a ferret cannot start).
 */
export default definePlugin({
  id: 'shells',
  title: 'Shells',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['item', 'command', 'view'],
  words: SHELLS_WORDS,

  provides: { shells: ShellsPort },

  actions: {
    routes: [
      route('GET /v1/shells', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'names, sources and build state only' },
      }),
      route('GET /v1/shells/nix', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'whether nix is present and its version' },
      }),
      route('GET /v1/shells/:name', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'one shell, its lock and build state' },
      }),
      route('POST /v1/shells/preview', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'writes nothing: resolves a source to show the owner what they would say yes to' },
        guard: { none: 'a source and its resolved hash' },
      }),
      route('POST /v1/shells', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(SHELLS_AUDIT.add),
        guard: { none: 'a source and its resolved hash' },
      }),
      route('POST /v1/shells/:name/relock', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(SHELLS_AUDIT.relock),
        guard: { none: 'a source and its resolved hash' },
      }),
      route('POST /v1/shells/:name/build', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(SHELLS_AUDIT.build),
        guard: { none: 'a hash and whether the build was cached' },
      }),
      route('DELETE /v1/shells/:name', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(SHELLS_AUDIT.remove),
        guard: { none: 'the shell name' },
      }),
    ],
    cli: [
      verb('shell ls', { summary: 'the shells on this machine, locked and built or not' }),
      verb('shell show', { summary: 'one shell, its locked source and narHash' }),
      verb('shell add', { summary: 'add a shell: resolve it, show what it resolved to, and pin it on your yes' }),
      verb('shell relock', { summary: 'resolve a shell again; a different narHash needs your yes again' }),
      verb('shell build', { summary: 'build a shell now and cache it by narHash' }),
      verb('shell rm', { summary: 'remove a shell' }),
      verb('shell nix', { summary: 'whether nix is on this machine, and what ferrets use without it' }),
    ],
  },

  ui: {
    settings: [settingsTab('shells', { label: 'Shells', order: 70 })],
  },

  data: {
    state: [SHELLS_LOCKS, SHELLS_CACHE],
    config: [SHELLS_CONFIG],
    readModels: SHELLS_READ_MODELS,
    publishes: [ShellsChanged, ShellBuilt],
  },

  hooks: {
    // The shell a ferret starts in (runtime, or the project's own flake), contributed to its launch.
    takes: [{ hook: LaunchParts, order: 40 }],
  },

  // "Without nix on the machine, Shells says so in onboarding and ferrets use the machine's tools" (§4.9).
  onboarding: [{ id: 'nix', title: 'Shells', order: 80 }],
  doctor: ['shells-nix'],

  // nix fetches flake inputs itself, so no host is reachable through `kernel.fetch`; the build runs under `nix`.
  permissions: { roots: [], network: [], spawn: ['nix'], secrets: [] },
});
