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
import { daemonSettingsPath } from '../../lib/pages/routes.ts';

export type SettingId =
  | 'text-size'
  | 'density'
  | 'theme'
  | 'chat-width'
  | 'show-details'
  | 'motion'
  | 'composer-markdown'
  | 'composer-enter-key'
  | 'composer-suggestions'
  | 'dictation'
  | 'notifications';

export type SettingsSectionId = 'appearance' | 'behaviour' | 'machines';

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
      'Comfortable (about 75 characters a line) is the default. On a wide screen choose Wide (900px) or Full (the whole pane); at 768px and below all three look the same.',
    keywords: [
      'chat',
      'conversation',
      'width',
      'measure',
      'readable',
      'comfortable',
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
      'Markdown, Notion-style (the default) shapes the line as you type — headings, lists that continue on Enter, checklists, quotes, code — with the markers kept faintly visible, or choose a plain text box. Either way you send exactly the markdown you typed. Optional Vim-style modal keys live here too.',
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
    keywords: ['enter', 'return', 'send', 'send key', 'newline', 'new line', 'shift enter', 'composer', 'keyboard', 'phone'],
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
    label: 'Dictation',
    description:
      'Speak into an editable message draft. Dictation never sends a message for you. Includes enhancement: a dictionary and context that fix misheard names and jargon.',
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
      'System notification when a session needs attention — waiting at the prompt, asking a question, failed, or finished. Off by default; turning it on asks the browser for permission.',
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
    ],
  },
  {
    id: 'show-details',
    label: 'Show details',
    description:
      'Whether the conversation opens its folded bookkeeping — reasoning, token usage, turn and daemon lines — or keeps it behind “Show details”. Hidden by default.',
    keywords: ['details', 'system', 'reasoning', 'tokens', 'usage', 'notices', 'conversation', 'transcript', 'verbose'],
  },
  {
    id: 'motion',
    label: 'Motion',
    description: 'Follow this device’s reduced-motion setting, or always keep spinners and transitions still here.',
    keywords: ['motion', 'animation', 'reduced', 'reduce', 'spinner', 'accessibility', 'vestibular'],
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
    description: 'Text, colour, density, and conversation layout on this browser.',
    settingIds: ['text-size', 'theme', 'motion', 'density', 'chat-width', 'show-details'],
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    description: 'How composing, dictation, and notifications behave on this browser.',
    settingIds: ['composer-markdown', 'composer-enter-key', 'composer-suggestions', 'dictation', 'notifications'],
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
