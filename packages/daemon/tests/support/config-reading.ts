/**
 * The catalogue's view of a machine's configuration, as a unit test needs it: a model, the revision it
 * was read at, and the configuration-file writes that move it to another model.
 *
 * The writes are the fleet library's own `fleetFileEdits` against the files the model would be held
 * in, each on disk with the etag `etag:<path>` — so what a test sees a change write is what the real
 * reading in `adapters/fleet/account-model-files.ts` would hand the provisioner.
 */
import {
  type AccountModel,
  accountModelFiles,
  assembleAccountModel,
  type ConfigFileOnDisk,
  checkConfigFile,
  type FleetDocumentWrite,
  fleetFileEdits,
  type RuntimeRename,
  renderConfigFile,
} from '@ferretry/fleet';
import { runtimeFileMoves } from '../../src/adapters/fleet/account-model-files.ts';
import type { AccountDocumentReading } from '../../src/lib/fleet/catalog-service.ts';

/** Where a test machine's configuration directory is. */
const TEST_CONFIG_DIRECTORY = '/state/config';

/** The files `model` would be held in, each as written fresh, with a stand-in etag. */
function configFilesOnDisk(model: AccountModel): ReadonlyMap<string, ConfigFileOnDisk> {
  const onDisk = new Map<string, ConfigFileOnDisk>();
  for (const [path, { address, value }] of accountModelFiles(model)) {
    const text = renderConfigFile(path, address, value, undefined);
    if (text !== undefined) onDisk.set(path, { text, etag: `etag:${path}` });
  }
  return onDisk;
}

/** A reading of `model`, its writes composed against the files it would be held in. */
export function configReading(
  model: AccountModel,
  revision: string,
  format: AccountDocumentReading['format'] = 'version-2',
): AccountDocumentReading {
  const onDisk = configFilesOnDisk(model);
  return {
    format,
    model,
    revision,
    documents: (next: AccountModel, rename?: RuntimeRename): readonly FleetDocumentWrite[] =>
      fleetFileEdits(model, next, onDisk, runtimeFileMoves(rename)).map(edit => ({
        path: `${TEST_CONFIG_DIRECTORY}/${edit.path}`,
        content: edit.content ?? '',
        mode: 0o600,
        expect: edit.expect,
        ...(edit.content === undefined ? { remove: true as const } : {}),
      })),
  };
}

/** Every configuration file a set of writes carries, each under its path, joined: what a test greps for a value. */
export function configTextOf(documents: readonly FleetDocumentWrite[]): string {
  return documents
    .filter(document => document.path.startsWith(`${TEST_CONFIG_DIRECTORY}/`) && document.remove !== true)
    .map(document => `# ${document.path}\n${document.content}`)
    .join('\n');
}

/** The model a set of configuration-file writes holds, as the daemon would read it back. */
export function modelOfWrites(documents: readonly FleetDocumentWrite[]): AccountModel {
  const files = documents.flatMap(document => {
    if (!document.path.startsWith(`${TEST_CONFIG_DIRECTORY}/`) || document.remove === true) return [];
    const checked = checkConfigFile(document.path.slice(TEST_CONFIG_DIRECTORY.length + 1), document.content);
    if (!checked.ok) throw new Error(`${document.path} does not check: ${JSON.stringify(checked.issues)}`);
    return [{ address: checked.address, value: checked.value }];
  });
  return assembleAccountModel(files);
}
