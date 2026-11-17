import { composeFeatures } from '@ferretry/kernel/manifest';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import type { ConversationApi } from '../../contract/index.ts';
import type {
  ComposedConversation,
  ConversationContext,
  ConversationFeature,
  ConversationHooks,
  ConversationSubscribers,
  FeatureContribution,
} from './types.ts';

/** Adds `section` to `into`; a key two features both serve is a wiring fault, named with both (as the kernel kit does). */
function merge<T>(
  label: string,
  kind: string,
  into: Record<string, T>,
  owners: Map<string, string>,
  feature: string,
  section: Readonly<Record<string, T>> | undefined,
): void {
  for (const [key, value] of Object.entries(section ?? {})) {
    const slot = `${kind} ${key}`;
    const held = owners.get(slot);
    if (held !== undefined) throw new Error(`${label}: the features ${held} and ${feature} both serve ${slot}`);
    owners.set(slot, feature);
    into[key] = value;
  }
}

/**
 * Registers every Conversation feature against one context, through the kernel kit's `composeFeatures` (routes, sockets
 * and port members, with its fault on a key served twice), and merges the sections the kit does not carry: tools, hooks,
 * subscribers, what to scrub or leave verbatim, and what a stop does. Registration order is the features' file-name order;
 * stops run in that order, and a hook thunk runs after every feature has registered.
 */
export function composeConversation(
  features: readonly ConversationFeature[],
  context: ConversationContext,
): ComposedConversation {
  const label = 'conversation';
  const extras: { readonly id: string; readonly contribution: FeatureContribution }[] = [];
  const kit = composeFeatures<ConversationContext, ConversationApi>(
    label,
    features.map(feature => ({
      id: feature.id,
      register: (f: ConversationContext) => {
        const contribution = feature.register(f);
        if (contribution !== undefined) extras.push({ id: feature.id, contribution });
        return contribution;
      },
    })),
    context,
  );

  const owners = new Map<string, string>();
  const tools: Record<string, ToolHandler> = {};
  const subscribers: Record<string, ConversationSubscribers[keyof ConversationSubscribers]> = {};
  const hooks: Record<string, ConversationHooks[keyof ConversationHooks]> = {};
  const scrubs = new Set<string>();
  const verbatim: Record<string, readonly string[]> = {};
  const stops: (() => void)[] = [];
  for (const { id, contribution } of extras) {
    merge(label, 'tool', tools, owners, id, contribution.tools);
    merge(label, 'subscriber', subscribers, owners, id, contribution.subscribers);
    // Hooks are made once every feature has registered, so one may read what another built.
    merge(label, 'hook', hooks, owners, id, contribution.hooks?.());
    for (const key of contribution.scrubsItsOwnBody ?? []) scrubs.add(key);
    merge(label, 'verbatim fields of', verbatim, owners, id, contribution.verbatimFields);
    if (contribution.stop !== undefined) stops.push(contribution.stop);
  }

  return {
    routes: kit.routes,
    sockets: kit.sockets,
    port: kit.port,
    tools,
    hooks: hooks as ConversationHooks,
    subscribers: subscribers as ConversationSubscribers,
    scrubsItsOwnBody: scrubs,
    verbatimFields: verbatim,
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}
