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
  | 'composer-markdown'
  | 'composer-enter-key'
  | 'dictation'
  | 'notifications';

export type SettingsSectionId = 'appearance' | 'behaviour' | 'daemons';

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
      'Full-bleed is the default. On a wide conversation, choose the available pane, a balanced 900px cap, or a readable 768px column; at 768px and below all three look the same.',
    keywords: [
      'chat',
      'conversation',
      'width',
      'measure',
      'readable',
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
    label: 'Composer Markdown',
    description:
      'Colour Markdown markers in the native message textarea and show a separate live rendered preview with proven, clickable references. Off by default pending a mobile Safari pass.',
    keywords: ['composer', 'markdown', 'preview', 'syntax', 'highlight', 'references', 'links', 'message', 'editor'],
  },
  {
    id: 'composer-enter-key',
    label: 'Enter key',
    description:
      'Choose whether Enter sends or starts a new line in the transcript composer. The other action stays reachable with Shift+Enter on a keyboard or the visible composer controls on touch.',
    keywords: ['enter', 'return', 'send', 'newline', 'new line', 'shift enter', 'composer', 'keyboard'],
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
] as const;

/**
 * Settings is deliberately grouped by the thing a choice changes. Appearance
 * owns presentation, Behaviour owns reader-local interaction, and Daemons owns
 * runtime pairings. Keeping this catalog beside the individual definitions
 * also gives deep links one unambiguous section to open.
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Text, colour, density, and conversation layout on this browser.',
    settingIds: ['text-size', 'theme', 'density', 'chat-width'],
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    description: 'How composing, dictation, and notifications behave on this browser.',
    settingIds: ['composer-markdown', 'composer-enter-key', 'dictation', 'notifications'],
  },
  {
    id: 'daemons',
    label: 'Daemons',
    description: 'Pair, check, switch, name, or remove the machines this browser can reach.',
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
  description: 'Appearance, behaviour, and connected daemons for this browser.',
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
    /**
     * The panel a refused control sends somebody to, reachable by the words they would actually type.
     *
     * "Permission", "password" and "locked" are in the keyword list because that is what a person
     * searches for after meeting a disabled control — not "grant", which is this project's own word
     * for it. A palette that only matched the internal noun would leave the explanation unfindable
     * by everybody who most needs it.
     */
    id: 'grants',
    label: 'What devices may do',
    description:
      'Per-capability limits for callers that are not on the machine, why a control is refused, and the operator password that gates turning one back on. Daemon-wide — opens this daemon’s settings.',
    href: daemon => `${daemonSettingsPath(daemon)}#daemons`,
    keywords: [
      'grant',
      'grants',
      'permission',
      'permissions',
      'capability',
      'capabilities',
      'operator password',
      'password',
      'unlock',
      'locked',
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
    id: 'warden',
    label: 'Warden',
    description:
      'Supervision, current checks, account failover, and policy for this daemon. Daemon-wide — opens this daemon’s settings.',
    href: daemon => `${daemonSettingsPath(daemon)}#daemons`,
    keywords: ['warden', 'failover', 'round robin', 'fallback', 'account', 'quota', 'token', 'wrapper', 'supervision'],
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
