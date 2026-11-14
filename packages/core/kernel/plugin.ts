import { z } from 'zod';
import {
  Carriers,
  ConfigChanged,
  DoctorChecks,
  defineConfig,
  PluginsChanged,
  policyRef,
  SessionModes,
} from './contract/index.ts';
import { definePlugin, route, settingsTab, socket, tool } from './manifest/index.ts';
import { AgentConfigCallSchemas, AGENT_CONFIG_TOOLS } from './contract/agent-config.ts';

/** `config/plugins.yaml` (§3.6): on or off per plugin. Core is always on whatever it says. */
export const PluginsYamlSchema = z.strictObject({
  plugins: z.record(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), z.enum(['on', 'off'])).default({}),
});
export type PluginsYaml = z.infer<typeof PluginsYamlSchema>;

/**
 * Person-only and passkey-checked (§7.2): turning a plugin ON can widen what ferrets may do (a tool, an item), so it
 * is a loosening edit; turning one off only tightens.
 */
export const PluginsConfig = defineConfig({
  file: 'plugins.yaml',
  schema: PluginsYamlSchema,
  axis: 'configure',
  personOnly: true,
  loosens: (before, after) =>
    Object.entries(after.plugins)
      .filter(([id, state]) => state === 'on' && before?.plugins[id] === 'off')
      .map(([id]) => `turns ${id} on`)
      .concat(
        Object.keys(before?.plugins ?? {})
          .filter(id => before?.plugins[id] === 'off' && after.plugins[id] === undefined)
          .map(id => `turns ${id} on (its off line was removed)`),
      ),
});

/** Gate's vocabulary by name: the kernel carries these refs and never reads them (§7.1). */
const FLEET_USE = { capability: policyRef('capability', 'fleet'), axis: 'use' } as const;
const FLEET_CONFIGURED = policyRef('audit', 'fleet.configured');

/**
 * The Kernel's own declaration (§2.2). Exported as `@ferretry/kernel/plugin` rather than `./manifest`, because
 * `@ferretry/kernel/manifest` is the SDK every other manifest imports. Its routes are served by `host/kernel-half.ts`.
 */
export default definePlugin({
  id: 'kernel',
  title: 'Kernel',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'home', means: 'the folder a daemon keeps everything in', insteadOf: ['state home', 'FY_HOME'] },
    { word: 'data', means: 'what a plugin keeps in its folder', insteadOf: ['store', 'db'] },
    { word: 'job', means: 'background work a plugin runs', insteadOf: ['timer', 'loop'] },
    { word: 'identity', means: "the daemon's own signing key", insteadOf: ['fingerprint'] },
  ],
  actions: {
    routes: [
      // §9.6: the session-layer version, read before anything else (the full-screen skew sentence needs it pre-auth).
      route('GET /v1/health', {
        minimum: 'none',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a version read records nothing' },
        guard: { none: 'the protocol number, the daemon version and the one feature name only' },
      }),
      // Today's liveness answer, kept (parity): `fy daemon status` and supervisors wait on it.
      route('GET /healthz', {
        minimum: 'none',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a liveness read records nothing' },
        guard: { none: 'status, uptime, pid and version only' },
      }),
      // §9.6 review r13 finding 3: Gate's descriptor for the inventory read.
      route('GET /v1/plugins', {
        minimum: 'authenticated',
        caller: 'any',
        unlockExempt: true,
        noStore: true,
        audit: { skip: 'the bootstrap read records nothing' },
        guard: { none: 'plugin ids, on/off and contract hashes only' },
      }),
      // Today's `GET /v1/doctor` (R-0081): the host diagnosis, now the rows every plugin's declared checks give.
      route('GET /v1/doctor', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a diagnosis read records nothing' },
        guard: { none: 'check names and sentences the checks wrote; never a secret' },
      }),
      // R-0246: the agent's tool door. It names no ferret and no plugin: the credential it carries decides who the
      // caller is, and each tool is admitted by its own declaration (`callTool`). Over a privileged local carrier only.
      route('POST /v1/agent/tools', {
        minimum: 'none',
        caller: 'any',
        privilegedOnly: true,
        noStore: true,
        audit: { skip: 'each tool records itself, by its own declaration' },
        guard: { none: 'the answer is the tool’s, already guarded by the tool’s own declaration' },
      }),
      // The configuration files (docs/config-files.md, D2 #3): today's three routes, served here because every plugin's
      // files are the kernel's to read and write. Gate answers per file which capability and axis the act needs.
      // What is in effect and what is wrong, for every declared file (today's `GET /v1/config/status`).
      route('GET /v1/config/status', {
        minimum: 'operator',
        caller: 'any',
        capability: FLEET_USE,
        noStore: true,
        audit: { skip: 'a read of what the configuration files stand at' },
        guard: { none: 'file names, kinds, states and located issues; never a file’s text or a value' },
      }),
      route('GET /v1/config/file', {
        minimum: 'operator',
        caller: 'any',
        capability: FLEET_USE,
        noStore: true,
        audit: { skip: 'a read of one configuration file' },
        guard: {
          none: 'a configuration file names secrets as ${secret:NAME} and never holds a raw value (a raw secret is refused on write)',
        },
      }),
      route('PUT /v1/config/file', {
        minimum: 'operator',
        caller: 'person',
        ferretDoor: 'a ferret writes a config file with config_write, where the owner turned "Ferretry settings" on',
        capability: FLEET_USE,
        noStore: true,
        audit: { record: FLEET_CONFIGURED },
        guard: { none: 'the answer names the path, the etag and what waits for the owner; never the text or a value' },
      }),
      // Removing one declared file (kernel batch #11: the CLI's `rm` verbs over a config collection item). The same
      // descriptor as `PUT`: Gate admits it per file, and a removal that loosens is held for the owner.
      route('DELETE /v1/config/file', {
        minimum: 'operator',
        caller: 'person',
        capability: FLEET_USE,
        noStore: true,
        audit: { record: FLEET_CONFIGURED },
        guard: { none: 'the answer names the path, the etag and what waits for the owner; never the text or a value' },
      }),
      route('POST /v1/config/confirm', {
        minimum: 'operator',
        caller: 'person',
        capability: FLEET_USE,
        noStore: true,
        audit: { record: FLEET_CONFIGURED },
        guard: { none: 'the answer names the path and whether the held edit was confirmed; never a value' },
      }),
      // The agent's config door (today's `POST /v1/agent/config`): authenticated by the session credential alone, over a
      // privileged local carrier, and refused unless the owner turned "Ferretry settings" on. It is an agent's ONLY write
      // door: `PUT /v1/config/file` is a person's. Each call is admitted by the declaration of the tool it names.
      route('POST /v1/agent/config', {
        minimum: 'none',
        caller: 'any',
        privilegedOnly: true,
        noStore: true,
        // The Dispatcher admits this route with no standing (`minimum: 'none'`), so ITS record would name nobody
        // (round-3 review N2b). The handler records instead, as the tool the body names, with the standing that tool
        // was admitted with: today's `fleet.configured`, `action: agent-config`, `by: agent` and the ferret.
        audit: { skip: "recorded by the handler as the tool it names, with that tool's admitted standing" },
        guard: { none: 'file names, etags, located issues and what waits for the owner; never a secret value' },
      }),
      // §1.3.
      route('GET /v1/glossary', {
        minimum: 'authenticated',
        caller: 'any',
        audit: { skip: 'public vocabulary' },
        guard: { none: 'public vocabulary' },
      }),
    ],
    // The agent's config tools (docs/config-files.md), today's names, schemas and words: live for every ferret. Each is a
    // ferret's alone (the session credential names it), refused unless "Ferretry settings" is on, and a write that
    // loosens waits for the owner: the agent can never confirm its own held edit. Each is recorded as today's route was
    // (`fleet.configured`, `action: agent-config`), because today's tools all went through `POST /v1/agent/config`.
    agentTools: [
      tool('config_read', {
        minimum: 'authenticated',
        caller: 'any',
        privilegedOnly: true,
        audit: { record: FLEET_CONFIGURED },
        guard: { none: 'file names, text with ${secret:NAME} references only, etags and located issues' },
        input: AgentConfigCallSchemas.config_read,
        summary: AGENT_CONFIG_TOOLS.config_read,
      }),
      tool('config_validate', {
        minimum: 'authenticated',
        caller: 'any',
        privilegedOnly: true,
        audit: { record: FLEET_CONFIGURED },
        guard: { none: 'located issues; never the offending value' },
        input: AgentConfigCallSchemas.config_validate,
        summary: AGENT_CONFIG_TOOLS.config_validate,
      }),
      tool('config_write', {
        minimum: 'authenticated',
        caller: 'any',
        privilegedOnly: true,
        audit: { record: FLEET_CONFIGURED },
        guard: { none: 'the path, the etag, located issues and what waits for the owner; never a value' },
        input: AgentConfigCallSchemas.config_write,
        summary: AGENT_CONFIG_TOOLS.config_write,
      }),
    ],
    sockets: [
      // The plugin event bus (`PluginClient.subscribe`): one { name, payload } frame per event the caller may see.
      socket('GET /v1/bus', {
        minimum: 'authenticated',
        caller: 'any',
        audit: { skip: 'a live feed of wake-ups records nothing' },
        guard: 'secrets',
      }),
    ],
  },
  /** Never reached by a ferret, through any root: the daemon's signing key (`PrivacyDecl`). */
  privacy: {
    private: ['identity.json'],
  },
  // The settings every daemon has (today's Health and Advanced groups): the host checks, their reachability tab, and the
  // configuration files. After Access (20-23) and the plugins' own tabs, before the daemon-wide ones at 90 and above.
  ui: {
    settings: [
      settingsTab('doctor', { label: 'Doctor', order: 80 }),
      settingsTab('host-checks', { label: 'Host checks', order: 81 }),
      settingsTab('files', { label: 'Files', order: 90 }),
    ],
  },
  data: { publishes: [PluginsChanged, ConfigChanged], config: [PluginsConfig] },
  hooks: {
    offers: [{ hook: Carriers }, { hook: SessionModes }, { hook: DoctorChecks }],
  },
});
