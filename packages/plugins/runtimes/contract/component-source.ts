/**
 * The profile component source (docs/config-files.md, "components"): how Runtimes reads the component documents a profile
 * layer names when ANOTHER plugin owns them.
 *
 * A profile names components by `kind/name` (`mcp/github`, `skills/review`, `settings/strict`). Runtimes owns the
 * profile; the plugin that owns the kind owns the component files. Runtimes cannot read another plugin's config, and a
 * generic cross-plugin read would let any plugin read documents that name secrets. So Runtimes declares ONE port here, in
 * its own contract, and EACH OWNER provides it from its own configuration (one fact, one owner):
 *
 *  - read-only: `list` the names, `read` one document;
 *  - the owner's own projection, ALREADY PARSED: structured data in the model's shape, never raw file text;
 *  - LIVE: Runtimes asks on every read and keeps nothing between reads (a cache refreshed by a watch showed a removed
 *    item for the length of the reload window);
 *  - a value never travels: an `env` entry is a plain value or a `${secret:NAME}` reference, exactly as the owner's file
 *    holds it.
 *
 * Each source is its own kernel provide hook, offered here and taken by the one plugin that owns that kind (`takers`):
 * the build refuses any other plugin, so a plugin that does not own a kind cannot provide it. A kind with no provider is
 * UNRESOLVED and Runtimes refuses an apply in a sentence rather than write a home without it.
 *
 * Environment logins are not here: Logins is a plugin Runtimes already needs, so a provide hook taken by Logins would put
 * Runtimes before Logins and after it at once. Logins gives the same kind of answer through its own port
 * (`LoginsApi.environmentTemplates`).
 */
import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** One component, as its owner projects it for the account model (plain parsed data in the model's shape). */
export type ProfileComponentDocument = Readonly<Record<string, unknown>>;

/** A read-only view of one kind's component documents, read live from the owner's own configuration. */
export interface ProfileComponentSource {
  /** Every component's name, in name order. */
  list(): Promise<readonly string[]>;
  /** One component, or `undefined` when there is none by that name (it may have just been removed). */
  read(name: string): Promise<ProfileComponentDocument | undefined>;
  /**
   * Fires, with nothing, when one of the owner's component files MOVES in effect (an item added, changed, fixed or
   * removed), and answers how to stop listening. The owner listens to its OWN configuration (`ConfigPort.watch` on its
   * own def), so Runtimes hears a change without reading another plugin's files and without a timer: it is the wake-up
   * that publishes the fleet again (a profile naming a component that did not exist yet now resolves). Optional: an
   * owner that offers none is read at the next change Runtimes does hear.
   */
  watch?(listener: () => void): () => void;
}

/** The kinds whose components another plugin owns (`modelSets` are Runtimes' own). */
export const PROFILE_COMPONENT_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks'] as const;
export type ProfileComponentKind = (typeof PROFILE_COMPONENT_KINDS)[number];

const hookFor = (name: string, owner: string) =>
  defineHook(name, {
    mode: 'provide',
    key: z.literal('components'),
    value: z.custom<ProfileComponentSource>(),
    takers: [owner],
  });

/** `mcp` components: MCP's servers. */
export const ProfileMcpSource = hookFor('runtimes.components.mcp', 'mcp');
/** `skills` components: Skills' selections of skill items. */
export const ProfileSkillsSource = hookFor('runtimes.components.skills', 'skills');
/** `settings` components for Claude Code. */
export const ProfileClaudeSettingsSource = hookFor('runtimes.components.settings.claude', 'claude-code');
/** `settings` components for Codex. */
export const ProfileCodexSettingsSource = hookFor('runtimes.components.settings.codex', 'codex');
/** `hooks` components for Claude Code. */
export const ProfileClaudeHooksSource = hookFor('runtimes.components.hooks.claude', 'claude-code');
/** `hooks` components for Codex (rendered as the runtime's `hooks.json`). */
export const ProfileCodexHooksSource = hookFor('runtimes.components.hooks.codex', 'codex');

/** The key every one of these hooks is taken with. */
export const PROFILE_COMPONENTS_KEY = 'components' as const;
