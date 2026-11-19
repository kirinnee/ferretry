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
 * One write door, owned by the owner too (`put`, optional): the setup import hands each imported `mcp`, `skills` or
 * `settings` component to the plugin that OWNS that kind, and the owner writes its own file through the kernel's
 * config service, so its schema check, the refusal of a raw secret and the hold on a loosening still apply. Runtimes never
 * writes another plugin's file. Hooks are never handed over: nothing imports them.
 *
 * Environment logins are not here: Logins is a plugin Runtimes already needs, so a provide hook taken by Logins would put
 * Runtimes before Logins and after it at once. Logins gives the same kind of answer through its own port
 * (`LoginsApi.environmentTemplates`).
 */
import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** One component, as its owner projects it for the account model (plain parsed data in the model's shape). */
export type ProfileComponentDocument = Readonly<Record<string, unknown>>;

/**
 * What an owner answers to one `put`: it wrote the file, or it refused in a sentence (names and rules, never a value).
 * `held` is a write the owner saved but holds until the owner of the machine confirms it (it loosens something).
 * `warnings` are things the owner wrote anyway but a person should hear (an MCP server whose command is not on this
 * machine): names and rules, never a value.
 */
export type ComponentPutResult =
  | { readonly ok: true; readonly held?: true; readonly warnings?: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** One file an imported component brings with it, by its path under the component (`<item>/<rel>` for a skill). */
export interface ComponentPutFile {
  readonly path: string;
  readonly content: string;
}

/** A view of one kind's component documents, read live from the owner's own configuration. */
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
  /**
   * Writes one component as the owner's own file. `documentText` is the component in the account model's shape, as a
   * YAML 1.2 document (JSON-formatted): the same projection `read` answers, so a `read` after a `put` gives it back. A
   * value never travels: an `env` entry is a plain value or a `${secret:NAME}` reference, and a raw secret is the
   * owner's to refuse. Optional: an owner that offers none is refused in a sentence, and the rest of the import still lands.
   * A name that is taken is the owner's to judge (an import never replaces a component it did not make).
   * `files` are the files the component brings (a skill's folders, as `<item>/<rel>`): only a skills component has
   * any, and the owner installs them into its own store with its own bounds. Runtimes does not copy them anywhere.
   */
  put?(name: string, documentText: string, files?: readonly ComponentPutFile[]): Promise<ComponentPutResult>;
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
