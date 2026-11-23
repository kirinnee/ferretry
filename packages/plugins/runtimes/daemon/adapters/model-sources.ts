/**
 * The model catalogs a runtime derives its models from (docs/model-catalog.md): read from Logins, which owns them, on every
 * read and kept nowhere. The wire names a preset's variables; a runtime reads only their names, so each is handed back as
 * a key. A Logins that fails to answer leaves runtimes with their model set only (said once per failure, never thrown into
 * a catalogue read).
 */
import type { LoginLaunchStore, LoginsApi } from '@ferretry/plugin-logins/contract';
import { supportedKinds } from '../lib/harness-kind.ts';
import type { ModelCatalogSources, ModelSourcePreset } from '../lib/models/catalog.ts';

/** What Logins answers, as the slice of it a runtime reads. */
export const modelCatalogSourcesOf = (view: Awaited<ReturnType<LoginsApi['modelSources']>>): ModelCatalogSources => ({
  catalogs: view.catalogs,
  presets: view.presets.map(
    (preset): ModelSourcePreset => ({
      id: preset.id,
      ...(preset.catalog === undefined ? {} : { catalog: preset.catalog }),
      halves: Object.fromEntries(
        supportedKinds().flatMap(harness => {
          const names = preset.variables[harness];
          return names === undefined ? [] : [[harness, { env: Object.fromEntries(names.map(name => [name, true])) }]];
        }),
      ),
    }),
  ),
  ...(view.local === undefined ? {} : { local: view.local }),
});

export function loginsModelCatalogs(
  logins: Pick<LoginsApi, 'modelSources'>,
  say: (sentence: string) => void,
): () => Promise<ModelCatalogSources> {
  return async () => {
    try {
      return modelCatalogSourcesOf(await logins.modelSources());
    } catch {
      say('Runtimes could not read the model catalogs from Logins, so runtimes show their model set only.');
      return { catalogs: {}, presets: [] };
    }
  };
}

/**
 * Where Logins keeps each Ferretry-kept login, read live for a publish (`LoginsApi.launchStores`): the stores a runtime's
 * wrapper and home are signed in through. A read that fails REFUSES the publish rather than writing wrappers that start
 * signed out, and its sentence quotes nothing Logins said.
 */
export function loginsLaunchStores(
  logins: Pick<LoginsApi, 'launchStores'>,
): () => Promise<readonly LoginLaunchStore[]> {
  return async () => {
    try {
      return await logins.launchStores();
    } catch {
      throw new Error('Logins could not say where its logins are kept, so the runtimes were not published');
    }
  };
}
