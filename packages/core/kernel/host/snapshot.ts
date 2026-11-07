import type { PluginId } from '../contract/ids.ts';
import type { PostBuildSnapshot, Word } from '../contract/snapshot.ts';
import type { Manifest } from '../manifest/types.ts';

/** A data plugin as the loader accepted it (§3.1): data kinds only, no halves. */
export interface DataPluginManifest {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly words?: readonly Word[];
  readonly instructions?: readonly { readonly id: string; readonly text: string }[];
  readonly onboarding?: readonly { readonly id: string; readonly title: string; readonly order: number }[];
}

/**
 * The post-build snapshot (§7.6 step 5): instructions, words, nav, doctor checks and onboarding steps, read from the
 * started manifests. Frozen; readers take it from the kernel's `snapshot` port, so it adds no start-order edge.
 * `instructionText` reads a plugin's `instructions/<file>.md` (the generated registry carries the text).
 */
export function buildSnapshot(
  started: readonly Manifest[],
  data: readonly DataPluginManifest[],
  instructionText: (plugin: string, path: string) => string | undefined,
): PostBuildSnapshot {
  const id = (value: string): PluginId => value as PluginId;
  const snapshot: PostBuildSnapshot = {
    instructions: [
      ...started.flatMap(manifest =>
        (manifest.instructions ?? []).flatMap(entry => {
          const text = instructionText(manifest.id, entry.text);
          return text === undefined ? [] : [{ plugin: id(manifest.id), id: entry.id, text, when: entry.when ?? {} }];
        }),
      ),
      ...data.flatMap(plugin =>
        (plugin.instructions ?? []).map(entry => ({ plugin: id(plugin.id), id: entry.id, text: entry.text, when: {} })),
      ),
    ],
    words: [
      ...started.flatMap(manifest => (manifest.words ?? []).map(word => ({ ...word, plugin: id(manifest.id) }))),
      ...data.flatMap(plugin => (plugin.words ?? []).map(word => ({ ...word, plugin: id(plugin.id) }))),
    ].sort((a, b) => a.word.localeCompare(b.word)),
    nav: started
      .flatMap(manifest =>
        (manifest.ui?.screens ?? []).flatMap(screen =>
          screen.nav === undefined
            ? []
            : [
                {
                  plugin: id(manifest.id),
                  screen: screen.id,
                  label: screen.nav.label,
                  ...(screen.nav.icon === undefined ? {} : { icon: screen.nav.icon }),
                  order: screen.nav.order,
                },
              ],
        ),
      )
      .sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin)),
    doctor: started.flatMap(manifest => (manifest.doctor ?? []).map(check => ({ plugin: id(manifest.id), id: check }))),
    onboarding: [
      ...started.flatMap(manifest => (manifest.onboarding ?? []).map(step => ({ plugin: id(manifest.id), ...step }))),
      ...data.flatMap(plugin => (plugin.onboarding ?? []).map(step => ({ plugin: id(plugin.id), ...step }))),
    ].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
  };
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}
