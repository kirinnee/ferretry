/**
 * The declarative Settings catalog shared by the Settings page and command
 * palette. Keeping labels, descriptions, anchors, and search terms together
 * prevents the two surfaces from drifting apart.
 *
 * Unlike kteam's single-daemon catalog, every generated destination here is
 * bound to the supplied daemon. A browser may pair with several daemons, and a
 * result discovered while searching one must never navigate to another.
 */

import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonMachineSetupPath, daemonSettingsPath } from '../../lib/pages/routes.ts';

export type SettingId =
  | 'text-size'
  | 'density'
  | 'theme'
  | 'chat-width'
  | 'motion'
  | 'open-links-in'
  | 'message-marks'
  | 'composer-markdown'
  | 'composer-enter-key'
  | 'composer-suggestions'
  | 'dictation'
  | 'notifications'
  | 'install-app'
  | 'device-permissions'
  | 'connection-preference'
  | 'clear-cached-data'
  | 'about-device'
  | 'speedup-keys'
  | 'dictation-debug'
  | 'transcription-log'
  | 'sessions-list';

export type SettingsSectionId = 'appearance' | 'behaviour' | 'device' | 'machines';

export interface SettingsSectionDefinition {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly description: string;
  readonly settingIds: readonly SettingId[];
}

export interface SettingDefinition {
  readonly id: SettingId;
  readonly label: string;
  readonly description: string;
  /** Extra words people are likely to type into Cmd/Ctrl+K. */
  readonly keywords: readonly string[];
}

export const SETTINGS_DEFINITIONS: readonly SettingDefinition[] = [
  {
    id: 'text-size',
    label: 'Text size',
    description:
      'Enlarge text across the whole interface. Labels and line boxes reflow, while padding, gaps, and touch-target floors stay fixed. Browser zoom, pinch zoom, and operating-system scaling remain available.',
    keywords: ['font', 'type', 'large', 'larger', 'readability', 'zoom', 'appearance'],
  },
  {
    id: 'density',
    label: 'Density',
    description:
      'Choose how much session detail the dashboard renders. Compact is the phone default; Full is the desktop default.',
    keywords: ['dashboard', 'detail', 'compact', 'minimal', 'full', 'rows', 'layout'],
  },
  {
    id: 'chat-width',
    label: 'Conversation width',
    description:
      'How wide messages and the composer run: Compact (a 720px column) is the default, 1200px leaves room for code and tables, Full uses the whole pane. A narrower pane looks the same in all three.',
    keywords: [
      'chat',
      'conversation',
      'width',
      'measure',
      'readable',
      'comfortable',
      'compact',
      '720',
      '1200',
      'wide',
      'balanced',
      'middle',
      'medium',
      'in-between',
      'full',
      'full pane',
      'full-bleed',
      'bleed',
      'reading',
      'column',
      'layout',
    ],
  },
  {
    id: 'composer-markdown',
    label: 'Editor style',
    description:
      'Markdown, Notion-style (the default) formats as you type — headings at their real size, bold, lists that continue on Enter, checklists, quotes, code — with the markers kept faintly visible; Rich text hides the markers and adds a toolbar; or choose a plain text box. Whichever style, you send markdown. Optional Vim-style modal keys live here too.',
    keywords: [
      'composer',
      'markdown',
      'preview',
      'syntax',
      'highlight',
      'references',
      'links',
      'message',
      'editor',
      'vim',
      'vi',
      'modal',
      'normal mode',
      'insert mode',
      'hjkl',
      'keys',
      'keybindings',
    ],
  },
  {
    id: 'composer-enter-key',
    label: 'Send key',
    description:
      'Choose, separately for a keyboard and for a phone, whether Enter sends or starts a new line. On a keyboard ↵ sends and ⇧↵ starts a line by default; on a phone return starts a line and the ↑ button sends. ⌘/Ctrl+↵ always sends.',
    keywords: [
      'enter',
      'return',
      'send',
      'send key',
      'newline',
      'new line',
      'shift enter',
      'composer',
      'keyboard',
      'phone',
    ],
  },
  {
    id: 'composer-suggestions',
    label: 'Open suggestions with',
    description:
      'Choose which keys open the composer’s reference menu: the @ ladder (@ files, @@ agents, @@@ attention), the direct symbols (@ files, :agent, !attention), or both; and whether $ opens skills. Suggestions only — a reference you write or paste yourself still resolves and links, and the / and % menus always open.',
    keywords: [
      'composer',
      'suggestion',
      'suggestions',
      'autocomplete',
      'complete',
      'completion',
      'menu',
      'popover',
      'typeahead',
      'reference',
      'references',
      'mention',
      'at',
      'sigil',
      'trigger',
      'file',
      'agent',
      'task',
      'attention',
      'skill',
      'quiet',
      'noise',
      'off',
    ],
  },
  {
    id: 'theme',
    label: 'Theme',
    description: 'Choose a colour mode and visual family. Changes apply immediately.',
    keywords: ['appearance', 'colour', 'color', 'mode', 'light', 'dark', 'auto', 'family', 'palette'],
  },
  {
    id: 'dictation',
    label: 'Voice',
    description:
      'Dictation into an editable message draft, never sent for you. Choose how this device turns speech into text — Parakeet on this device (a one-time download) or phone/browser voice — plus clean-up with a dictionary and context that fix misheard names and jargon.',
    keywords: [
      'voice',
      'speech',
      'microphone',
      'mic',
      'stt',
      'transcribe',
      'transcription',
      'talk',
      'push to talk',
      'shortcut',
      'hotkey',
      'alt',
      'audio',
      'parakeet',
      'engine',
      'install',
      'download',
      'offline',
      'privacy',
      'enhance',
      'enhancement',
      'dictionary',
      'vocabulary',
      'glossary',
      'jargon',
      'correction',
      'corrections',
      'words',
      'names',
      'context',
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description:
      'System notification when a session needs you, finishes, or fails — or a new device is paired. Every paired machine sends every event; these switches, quiet hours, and the per-machine list decide what this browser shows. Off by default; turning it on asks the browser for permission.',
    keywords: [
      'notify',
      'notification',
      'alert',
      'push',
      'buzz',
      'awaiting',
      'needs attention',
      'question',
      'background',
      'quiet hours',
      'new device',
    ],
  },
  {
    id: 'device-permissions',
    label: 'Permissions',
    description:
      'Every permission Ferretry can use on this device — camera, microphone, notifications, location, clipboard and storage — with what it is for, whether it is allowed, and how to turn it on. Nothing is asked for until you press its button.',
    keywords: [
      'permission',
      'permissions',
      'camera',
      'microphone',
      'mic',
      'location',
      'gps',
      'geolocation',
      'clipboard',
      'paste',
      'storage',
      'persistent',
      'allow',
      'blocked',
      'denied',
      'privacy',
      'ios',
      'iphone',
      'prompt',
      'qr',
      'scan',
    ],
  },
  {
    id: 'connection-preference',
    label: 'Connection',
    description:
      'How this device reaches each paired machine: Auto (direct, then WebRTC, then a Cloudflare tunnel, then a relay), WebRTC only, Tunnel only or Relay only. Chosen per machine, kept on this device, and never sent to the machine.',
    keywords: [
      'connection',
      'carrier',
      'carriers',
      'relay',
      'tunnel',
      'cloudflare',
      'webrtc',
      'peer to peer',
      'p2p',
      'direct',
      'network',
      'auto',
    ],
  },
  {
    id: 'install-app',
    label: 'Install app',
    description:
      'Add Ferretry to this device as an app — its own icon on the home screen or app list, full screen, without the browser bar.',
    keywords: [
      'install',
      'app',
      'home screen',
      'add to home screen',
      'pwa',
      'standalone',
      'icon',
      'launcher',
      'shortcut',
    ],
  },
  {
    id: 'clear-cached-data',
    label: 'Cached data',
    description:
      'Sessions and recent messages this device keeps so screens open at once. Clearing removes only this device’s copy.',
    keywords: ['cache', 'cached', 'clear', 'offline', 'storage', 'privacy', 'forget', 'data', 'delete'],
  },
  {
    id: 'transcription-log',
    label: 'Transcription log',
    description:
      'Every dictation this device made, kept here only so words are never lost to a mis-tap: search it, copy from it, put one back in the composer. No audio is stored. Never synced, never sent to any machine.',
    keywords: [
      'transcription',
      'transcript',
      'log',
      'history',
      'dictation',
      'voice',
      'dictated',
      'recover',
      'lost',
      'search',
      'copy',
      'insert',
      'device',
      'privacy',
    ],
  },
  {
    id: 'dictation-debug',
    label: 'Dictation debug',
    description:
      'Off by default. When on, this tab keeps the last 10 clean-up calls (the prompt, the provider’s raw reply, the checks) so you can see why a dictation read the way it did. Held in memory only; gone on reload or when switched off.',
    keywords: [
      'debug',
      'dictation',
      'cleanup',
      'clean-up',
      'prompt',
      'groq',
      'cerebras',
      'response',
      'raw',
      'trace',
      'details',
      'voice',
      'developer',
    ],
  },
  {
    id: 'about-device',
    label: 'About this device',
    description:
      'How this screen measures itself — its size, the safe areas around the notch and home indicator, and where the app’s edges landed. For a screenshot when something at the edge of the screen looks out of place.',
    keywords: [
      'viewport',
      'screen',
      'safe area',
      'notch',
      'home indicator',
      'diagnostics',
      'debug',
      'gap',
      'standalone',
      'device',
    ],
  },
  {
    id: 'speedup-keys',
    label: 'Speed-up keys',
    description:
      'A Groq or Cerebras key kept in this browser only, so dictation clean-up calls the provider directly instead of going through a machine. Encrypted here, never synced, never sent to any machine or agent.',
    keywords: [
      'groq',
      'cerebras',
      'api key',
      'key',
      'keys',
      'speed',
      'speed-up',
      'speedups',
      'faster',
      'clean-up',
      'cleanup',
      'dictation',
      'voice',
      'enhancement',
      'browser',
      'device',
    ],
  },
  {
    id: 'sessions-list',
    label: 'Sessions list',
    description:
      'Show the sessions of every paired machine in one list — everything that needs you pinned at the top, then each machine — or only the machine you are on.',
    keywords: [
      'sessions',
      'list',
      'sidebar',
      'machines',
      'all machines',
      'current machine',
      'needs you',
      'combined',
      'mix',
    ],
  },
  {
    id: 'motion',
    label: 'Motion',
    description: 'Follow this device’s reduced-motion setting, or always keep spinners and transitions still here.',
    keywords: ['motion', 'animation', 'reduced', 'reduce', 'spinner', 'accessibility', 'vestibular'],
  },
  {
    id: 'open-links-in',
    label: 'Open links in',
    description: 'Cmd/Ctrl-click always opens a new tab.',
    keywords: [
      'links',
      'link',
      'url',
      'open',
      'browser',
      'safari',
      'new tab',
      'tab',
      'side panel',
      'panel',
      'preview',
      'in-app',
      'external',
    ],
  },
  {
    id: 'message-marks',
    label: 'Message marks',
    description:
      'What the clock, ticks and ! under your messages mean: sending, queued, delivered, answered by the agent, or not delivered.',
    keywords: [
      'ticks',
      'tick',
      'receipt',
      'receipts',
      'read',
      'delivered',
      'sent',
      'queued',
      'failed',
      'legend',
      'check',
    ],
  },
] as const;

/**
 * Settings is deliberately grouped by the thing a choice changes. Appearance
 * owns presentation and Behaviour owns reader-local interaction, both on this
 * browser only; Machines owns each paired machine. Keeping this catalog beside the individual definitions
 * also gives deep links one unambiguous section to open.
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Text, colour, density, and conversation layout on this device.',
    settingIds: ['text-size', 'theme', 'motion', 'density', 'chat-width', 'open-links-in', 'message-marks'],
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    description: 'How the session list, composing, dictation, and notifications behave on this device.',
    settingIds: [
      'sessions-list',
      'composer-markdown',
      'composer-enter-key',
      'composer-suggestions',
      'dictation',
      'notifications',
    ],
  },
  {
    id: 'device',
    label: 'This device',
    description:
      'Ferretry as an app on this device, what it may use (camera, location, notifications), how it connects to each machine, the provider keys only this device holds, and what it keeps here.',
    settingIds: [
      'install-app',
      'device-permissions',
      'connection-preference',
      'speedup-keys',
      'transcription-log',
      'dictation-debug',
      'clear-cached-data',
      'about-device',
    ],
  },
  {
    /**
     * ONE PLACE PER MACHINE. Daemons used to sit beside this as its own section — the pairing on one
     * screen, what runs on the machine on another. Its panels now live on each machine's Machine tab,
     * and the address is `#machines/<machine>/<tab>`.
     */
    id: 'machines',
    label: 'Machines',
    description: 'Each machine’s runtimes, credentials, profiles and components, and its connection and security.',
    settingIds: [],
  },
] as const;

const SETTINGS_SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map(section => [section.id, section]));
const SETTINGS_SECTION_BY_SETTING = new Map(
  SETTINGS_SECTIONS.flatMap(section => section.settingIds.map(id => [id, section.id] as const)),
);

export const settingsSectionDefinition = (id: SettingsSectionId): SettingsSectionDefinition => {
  const definition = SETTINGS_SECTION_BY_ID.get(id);
  if (definition === undefined) throw new Error(`Unknown settings section: ${id}`);
  return definition;
};

export const isSettingsSectionId = (value: string | null | undefined): value is SettingsSectionId =>
  Boolean(value && SETTINGS_SECTION_BY_ID.has(value as SettingsSectionId));

export const settingsSectionForSetting = (id: SettingId): SettingsSectionId => {
  const section = SETTINGS_SECTION_BY_SETTING.get(id);
  if (section === undefined) throw new Error(`Setting ${id} does not belong to a settings section`);
  return section;
};

export const SETTINGS_DESTINATION = {
  id: 'open-settings',
  label: 'Open settings',
  description: 'Appearance and behaviour on this browser, and every paired machine.',
  keywords: ['preferences', 'options', 'appearance', 'behaviour', 'daemon', 'pairing', 'configure'],
} as const;

export interface SettingsLinkDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
  /** Builds a destination for precisely the daemon currently being searched. */
  readonly href: (daemon: DaemonId) => string;
}

export const SETTINGS_LINKS: readonly SettingsLinkDefinition[] = [
  {
    // The words somebody types when they want to change what runs: the account model's own nouns,
    // plus the old ones ("account", "fleet", "login") a person who has used Ferretry before reaches for.
    id: 'machines',
    label: 'Machines',
    description:
      'The runtimes you launch, the logins they use, and the profiles and components they are built from, per machine.',
    href: daemon => `${daemonSettingsPath(daemon)}#machines`,
    keywords: [
      'machine',
      'runtime',
      'runtimes',
      'credential',
      'credentials',
      'login',
      'logins',
      'sign in',
      'profile',
      'profiles',
      'component',
      'components',
      'mcp',
      'skills',
      'instructions',
      'model set',
      'agent permissions',
      'account',
      'accounts',
      'fleet',
    ],
  },
  {
    /**
     * The panel a refused control sends somebody to, reachable by the words they would actually type.
     *
     * "Permission", "passkey" and "confirm" are in the keyword list because that is what a person
     * searches for after meeting a disabled control — not "grant", which is this project's own word
     * for it. A palette that only matched the internal noun would leave the explanation unfindable
     * by everybody who most needs it.
     */
    id: 'grants',
    label: 'What devices may do',
    description:
      'Per-capability limits for paired devices, a browser on the machine included, why a control is refused, and the passkey confirmation a paired device gives before it changes one. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#grants`,
    keywords: [
      'grant',
      'grants',
      'permission',
      'permissions',
      'capability',
      'capabilities',
      'passkey',
      'step-up',
      'confirm',
      'refused',
      'forbidden',
      'read only',
      'security',
      'remote',
      'paired device',
      'allow',
      'restrict',
    ],
  },
  {
    // "Slow", "lag" and "profile" are what somebody types when the app or the machine feels sluggish.
    id: 'performance',
    label: 'Performance',
    description:
      'Record 30 seconds of what this machine and this app spend their time on, then copy or download a report that is safe to share. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#performance`,
    keywords: ['performance', 'slow', 'lag', 'laggy', 'profile', 'diagnostics', 'report', 'cpu', 'requests', 'speed'],
  },
  {
    // "Who paired", "log" and "history" are what somebody types after a new-device notice they did not expect.
    id: 'security-log',
    label: 'Security log',
    description:
      'The security log for this machine: devices paired or removed, refused attempts, permission changes, opened terminals and used secrets. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#security-log`,
    keywords: [
      'security',
      'audit',
      'log',
      'history',
      'activity',
      'events',
      'who paired',
      'new device',
      'paired device',
      'removed',
      'refused',
      'intruder',
    ],
  },
  {
    id: 'warden',
    label: 'Warden',
    description:
      'Supervision, current checks, account failover, and policy for this daemon. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#warden`,
    keywords: ['warden', 'failover', 'round robin', 'fallback', 'account', 'quota', 'token', 'wrapper', 'supervision'],
  },
  {
    // Words for the passkey panel: what a person types after a prompt asks them to "confirm it's you".
    id: 'security',
    label: 'Security',
    description:
      'The passkeys this device holds for this machine, and adding another. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#security`,
    keywords: [
      'passkey',
      'passkeys',
      'confirm',
      'confirmation',
      'biometric',
      'fingerprint',
      'face id',
      'webauthn',
      'step-up',
      'security',
    ],
  },
  {
    /**
     * The panel somebody looks for when the machine is on fire, reachable by the words they would
     * actually type at that moment.
     *
     * "Slow", "hot", "fan", "swap" and "out of memory" are in the list because those are the
     * SYMPTOMS a person searches by — not "cgroup", which is the kernel's word for the mechanism and
     * means nothing to anyone who has not already found this panel. A palette that only matched the
     * implementation noun would leave the control unfindable by exactly the person whose laptop is
     * being eaten by an agent.
     */
    id: 'resource-limits',
    label: 'Resource limits',
    description:
      'CPU and RAM caps for the agents this daemon runs, fleet-wide and per agent, and whether they are enforced. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#resource-limits`,
    keywords: [
      'cpu',
      'ram',
      'memory',
      'resource',
      'resources',
      'limit',
      'limits',
      'cap',
      'caps',
      'quota',
      'throttle',
      'cgroup',
      'cgroups',
      'slice',
      'slow',
      'hot',
      'fan',
      'swap',
      'out of memory',
      'runaway',
      'performance',
    ],
  },
  {
    // The words somebody types when they want the file behind a setting: the file names themselves, and
    // "yaml" and "config", which is what a person who edits files by hand calls them.
    id: 'files',
    label: 'Configuration files',
    description:
      'The YAML files this machine’s settings live in: where they are, what is wrong with them, edits waiting for your confirmation, and editing one as YAML. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#files`,
    keywords: [
      'yaml',
      'config',
      'configuration',
      'files',
      'file',
      'edit as yaml',
      'machine.yaml',
      'warden.yaml',
      'learning.yaml',
      'voice.yaml',
      'logins',
      'profiles',
      'runtimes',
      'components',
      'confirm',
      'waiting',
      'invalid',
    ],
  },
  {
    // The feature's own name, and the words for what it does: delegating, sub-agents, picking a model.
    id: 'pack',
    label: 'Pack mode',
    description:
      'Whether ferrets may start sub-ferrets and pick the model each runs on: the switch, who decides (the agent or Jev), how many may run and how deep, and the models guide. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#pack`,
    keywords: [
      'pack',
      'pack mode',
      'sub-ferret',
      'sub-ferrets',
      'subagent',
      'sub-agent',
      'delegate',
      'delegation',
      'spawn',
      'children',
      'parallel',
      'models guide',
      'model guide',
      'which model',
      'pick model',
      'use case',
      'jev',
      'depth',
      'limit',
      'pack.yaml',
      'models-guide.yaml',
    ],
  },
  {
    // What a person types to go through setup again: the step names, and "onboarding" and "wizard".
    id: 'machine-setup',
    label: 'New machine setup',
    description:
      'Walk through pairing, logins, speed-ups, voice, the Warden, learning and agent controls again; every step can be skipped. On this machine.',
    href: daemon => daemonMachineSetupPath(daemon),
    keywords: ['setup', 'set up', 'onboarding', 'wizard', 'first run', 'new machine', 'getting started', 'skipped'],
  },
  {
    id: 'copy-settings',
    label: 'Copy settings from another machine',
    description:
      'Copy the Warden, learning, voice, agent controls, profiles and runtimes from a machine you are paired with. Secrets come only when you pick them; logins never travel. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#clone`,
    keywords: ['clone', 'copy', 'import', 'another machine', 'migrate', 'transfer', 'same settings'],
  },
  {
    id: 'export-settings',
    label: 'Export settings',
    description:
      'A zip of this machine’s configuration files, without secrets, for a backup or to edit by hand. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#export`,
    keywords: ['export', 'zip', 'backup', 'download', 'yaml', 'config', 'save'],
  },
  {
    // The keys' own names, because that is what somebody with a key in hand types.
    id: 'speedups',
    label: 'Speed-ups',
    description:
      'Optional Jev, Groq and Cerebras keys: cheaper Warden triage and dictation clean-up. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#speedups`,
    keywords: ['speed-ups', 'speedups', 'jev', 'groq', 'cerebras', 'api key', 'key', 'faster', 'cheaper'],
  },
  {
    // The package managers' own names, because "brew" or "nix" is what somebody stuck on an old version types.
    id: 'about',
    label: 'Updates',
    description:
      'This machine’s version beside the app’s, how it was installed, and updating it — one click where it can update itself, the exact steps where it cannot. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#about`,
    keywords: [
      'update',
      'updates',
      'upgrade',
      'version',
      'about',
      'release',
      'changelog',
      'whats new',
      'brew',
      'homebrew',
      'nix',
      'apt',
      'install',
      'auto-update',
    ],
  },
  {
    // The harnesses' and their package managers' own names: "codex", "claude code" or "npm" is what somebody types.
    id: 'agent-clis',
    label: 'Agent CLIs',
    description:
      'The Claude Code and Codex this machine runs, how each was installed, whether Ferretry has verified that version, and updating it. On this machine — opens its Machine tab.',
    href: daemon => `${daemonSettingsPath(daemon)}#agent-clis`,
    keywords: [
      'agent cli',
      'claude',
      'claude code',
      'codex',
      'harness',
      'update claude',
      'update codex',
      'npm',
      'brew',
      'nix',
      'verified',
      'version',
    ],
  },
] as const;

const SETTINGS_BY_ID = new Map(SETTINGS_DEFINITIONS.map(definition => [definition.id, definition]));

export const settingDefinition = (id: SettingId): SettingDefinition => {
  const definition = SETTINGS_BY_ID.get(id);
  if (definition === undefined) throw new Error(`Unknown setting: ${id}`);
  return definition;
};

export const isSettingId = (value: string | null | undefined): value is SettingId =>
  Boolean(value && SETTINGS_BY_ID.has(value as SettingId));

/** Builds a Settings deep link for the daemon whose page owns the section. */
export const settingsHref = (daemon: DaemonId, id?: SettingId | null): string =>
  id === undefined || id === null ? daemonSettingsPath(daemon) : `${daemonSettingsPath(daemon)}#${id}`;

export interface SettingsPaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly settingId: SettingId | null;
  /** Link rows navigate here instead of a Settings section (for example Warden). */
  readonly href?: string;
}

export interface SettingsPaletteContext {
  /** Current browser-local binding, supplied without making this catalog own dictation storage. */
  readonly dictationShortcutLabel?: string;
}

/**
 * The open command is present in the unfiltered palette. Individual controls
 * join only when their catalog text matches, so searching jumps directly to a
 * section without turning every Cmd/Ctrl+K open into a second Settings page.
 */
export const settingsPaletteEntries = (
  daemon: DaemonId,
  query: string,
  context: SettingsPaletteContext = {},
): SettingsPaletteEntry[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return [
      {
        id: SETTINGS_DESTINATION.id,
        label: SETTINGS_DESTINATION.label,
        description: SETTINGS_DESTINATION.description,
        settingId: null,
      },
    ];
  }

  const commandHaystack = [SETTINGS_DESTINATION.label, ...SETTINGS_DESTINATION.keywords].join(' ').toLocaleLowerCase();
  const entries: SettingsPaletteEntry[] = [];
  if (commandHaystack.includes(needle)) {
    entries.push({
      id: SETTINGS_DESTINATION.id,
      label: SETTINGS_DESTINATION.label,
      description: SETTINGS_DESTINATION.description,
      settingId: null,
    });
  }

  for (const definition of SETTINGS_DEFINITIONS) {
    const description =
      definition.id === 'dictation' && context.dictationShortcutLabel
        ? `${definition.description} Push-to-talk shortcut: ${context.dictationShortcutLabel}.`
        : definition.description;
    const haystack = [definition.label, description, ...definition.keywords].join(' ').toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    entries.push({
      id: `setting-${definition.id}`,
      label: definition.label,
      description,
      settingId: definition.id,
    });
  }

  for (const link of SETTINGS_LINKS) {
    const haystack = [link.label, link.description, ...link.keywords].join(' ').toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    entries.push({
      id: `setting-link-${link.id}`,
      label: link.label,
      description: link.description,
      settingId: null,
      href: link.href(daemon),
    });
  }
  return entries;
};
