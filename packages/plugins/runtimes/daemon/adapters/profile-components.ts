/**
 * Reads the components another plugin owns through the profile component source (`../../contract/component-source.ts`).
 *
 * One kind is made of one or more SOURCES, each a kernel provide hook whose one taker is the owning plugin. Every read is
 * LIVE: this module keeps nothing between calls, so a component the owner removed is gone on the next read.
 *
 * Fail closed, per kind: a kind is `read` only when EVERY one of its sources answered and every document it gave is a
 * valid component. A kind with no source at all, a source nobody provides or one that is off, a source that throws, and a
 * document that is not a component each make the kind `unread`, with a reason
 * of names and rules (never a value), so the caller refuses an apply in a sentence rather than write a partial home.
 */
import type { ProvideHook } from '@ferretry/kernel/contract';
import {
  PROFILE_COMPONENT_KINDS,
  ProfileClaudeHooksSource,
  ProfileClaudeSettingsSource,
  ProfileCodexHooksSource,
  ProfileCodexSettingsSource,
  ProfileMcpSource,
  ProfileSkillsSource,
  type ProfileComponentDocument,
  type ProfileComponentKind,
  type ProfileComponentSource,
} from '../../contract/index.ts';
import type { ComponentReading, KindReading } from '../lib/account/runtimes-model.ts';
import { parseForeignComponent } from '../lib/account/schema.ts';

/** Who provides a source: the plugin that took the hook, or `unavailable` (nobody took it, or it is not running). */
export type ComponentSourceLookup = (
  hook: ProvideHook<string, 'components', ProfileComponentSource>,
) => ProfileComponentSource | 'unavailable';

type SourceHook = ProvideHook<string, 'components', ProfileComponentSource>;

interface SourceDefinition {
  /** The hook the owning plugin takes; absent for Runtimes' own source (`instructions`), which needs no hook. */
  readonly hook?: SourceHook;
  /** The harness every component of the source is for, when the source is one harness's. */
  readonly harness?: 'claude' | 'codex';
}

/** Which sources make up each kind. A kind is read only when every one of its sources answers. */
const SOURCES: Readonly<Record<ProfileComponentKind, readonly SourceDefinition[]>> = {
  // No other plugin owns the `instructions` files, so Runtimes does: its own source, passed in by the caller.
  instructions: [{}],
  mcp: [{ hook: ProfileMcpSource }],
  skills: [{ hook: ProfileSkillsSource }],
  settings: [
    { hook: ProfileClaudeSettingsSource, harness: 'claude' },
    { hook: ProfileCodexSettingsSource, harness: 'codex' },
  ],
  hooks: [
    { hook: ProfileClaudeHooksSource, harness: 'claude' },
    { hook: ProfileCodexHooksSource, harness: 'codex' },
  ],
};

/** Every hook an owner takes to give a component source: what Runtimes listens to for a change (`watchOwners`). */
export const PROFILE_COMPONENT_SOURCE_HOOKS: readonly SourceHook[] = [
  ...new Set(
    Object.values(SOURCES).flatMap(sources =>
      sources.flatMap(source => (source.hook === undefined ? [] : [source.hook])),
    ),
  ),
];

const unread = (reason: string): KindReading => ({ state: 'unread', reason });

/** A component's `harness` in the model's own spelling. */
const harnessOf = (document: ProfileComponentDocument, source: SourceDefinition): ProfileComponentDocument => {
  // A source of one harness decides it; the document's own word never overrides the owner that provided it.
  if (source.harness !== undefined) return { ...document, harness: source.harness };
  const { harness } = document;
  return harness === 'claude-code' ? { ...document, harness: 'claude' } : document;
};

/** What {@link Within} answers when the work did not finish in time. */
const TIMED_OUT = 'timed-out' as const;

/** Bounds a piece of work: its answer, or {@link TIMED_OUT}. The clock that measures the time is the caller's. */
export type Within = <Answer>(work: Promise<Answer>) => Promise<Answer | typeof TIMED_OUT>;

/** How long an owner has to give its components before its kind counts as not read. */
export const PROVIDER_ANSWER_MS = 5_000;

/** {@link Within} measured by a clock's `after`: the work that settles first decides, and the timer never outlives it. */
export function withinMs(after: (delayMs: number, fn: () => void) => () => void, ms: number): Within {
  return work =>
    new Promise((resolve, reject) => {
      const cancel = after(ms, () => {
        resolve(TIMED_OUT);
      });
      work.then(
        answer => {
          cancel();
          resolve(answer);
        },
        (error: unknown) => {
          cancel();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
}

async function readKind(
  kind: ProfileComponentKind,
  lookup: ComponentSourceLookup,
  own: ProfileComponentSource,
  within: Within,
): Promise<KindReading> {
  const sources = SOURCES[kind];
  if (sources.length === 0) return unread('no part of Ferretry provides these components yet');
  const components = new Map<string, unknown>();
  const providers = new Map<string, string>();
  let partial: string | undefined;
  for (const source of sources) {
    try {
      const provider = source.hook === undefined ? own : lookup(source.hook);
      if (provider === 'unavailable') {
        // A kind made of one source per harness (settings, hooks) is still read when ONE harness's part is not running
        // (the owner turned Codex off): what the running part gives is real, and a profile layer naming a component none
        // of them gave is unread, for that reason. A kind with a single owner (mcp, skills) has nothing else to read, so
        // its owner not running leaves it unread.
        if (source.harness !== undefined && sources.length > 1) {
          partial = 'the part of Ferretry that owns them is not running';
          continue;
        }
        return unread('the part of Ferretry that owns them is not running');
      }
      // A provider that never answers is a kind that was not read, never a stuck apply and never an empty answer.
      const answered = await within(
        (async () => {
          const found: (readonly [string, ProfileComponentDocument | undefined])[] = [];
          for (const name of await provider.list()) found.push([name, await provider.read(name)]);
          return found;
        })(),
      );
      if (answered === TIMED_OUT) return unread('the part of Ferretry that owns them did not answer in time');
      for (const [name, document] of answered) {
        // Removed between `list` and `read`: gone.
        if (document === undefined) continue;
        const checked = parseForeignComponent(kind, harnessOf(document, source));
        if (!checked.ok) return unread(`"${name}" is not a valid ${kind} component (${checked.issues.join('; ')})`);
        const other = providers.get(name);
        if (other !== undefined) return unread(`two parts of Ferretry give a ${kind} component named "${name}"`);
        providers.set(name, source.hook?.name ?? 'runtimes');
        components.set(name, checked.component);
      }
    } catch {
      // The reason is a fixed sentence: a provider's own message is its own text, not Ferretry's.
      return unread('the part of Ferretry that owns them did not answer');
    }
  }
  return partial === undefined ? { state: 'read', components } : { state: 'read', components, partial };
}

/** Every kind of component, read now: the owners' through the hooks, and Runtimes' own (`instructions`) directly. */
export async function readProfileComponents(
  lookup: ComponentSourceLookup,
  own: ProfileComponentSource,
  within: Within,
): Promise<ComponentReading> {
  const readings = await Promise.all(
    PROFILE_COMPONENT_KINDS.map(async kind => [kind, await readKind(kind, lookup, own, within)] as const),
  );
  return Object.fromEntries(readings) as ComponentReading;
}
