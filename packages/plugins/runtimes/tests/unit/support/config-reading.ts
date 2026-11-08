/**
 * The catalogue's view of a machine's configuration, as a unit test needs it: a model, the revision it
 * was read at, and the configuration-file writes that move it to another model.
 *
 * The config-files evaluator and its edit renderer are the kernel's (GAP(kernel), `adapters/ports.ts`), so
 * this stand-in holds the model in two files: `machine.yaml` (the machine's settings) and `model.yaml` (the
 * rest). Both are JSON, which is valid YAML, so a test reads what a change wrote with `JSON.parse`.
 */
import { type AccountModel, parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { AccountDocumentReading } from '../../../daemon/lib/service/catalog-service.ts';
import type { FleetDocumentWrite } from '../../../daemon/lib/provisioning.ts';

/** Where a test machine's configuration directory is. */
const TEST_CONFIG_DIRECTORY = '/state/config';

/** The two files `model` is held in, each as the text a change would write. */
function filesOf(model: AccountModel): { readonly 'machine.yaml': string; readonly 'model.yaml': string } {
  const { machine, ...rest } = model;
  return {
    'machine.yaml': `${JSON.stringify({ machine }, null, 2)}\n`,
    'model.yaml': `${JSON.stringify(rest, null, 2)}\n`,
  };
}

/** A reading of `model`, its writes composed against the files it would be held in. */
export function configReading(
  model: AccountModel,
  revision: string,
  format: AccountDocumentReading['format'] = 'present',
): AccountDocumentReading {
  const before = filesOf(model);
  return {
    format,
    model,
    revision,
    documents: (next: AccountModel): readonly FleetDocumentWrite[] =>
      Object.entries(filesOf(next))
        .filter(([path, content]) => before[path as keyof typeof before] !== content)
        .map(([path, content]) => ({
          path: `${TEST_CONFIG_DIRECTORY}/${path}`,
          content,
          mode: 0o600,
          expect: `etag:${path}`,
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
  const held = (file: string): Record<string, unknown> => {
    const document = documents.find(candidate => candidate.path === `${TEST_CONFIG_DIRECTORY}/${file}`);
    return document === undefined ? {} : (JSON.parse(document.content) as Record<string, unknown>);
  };
  return parseAccountModel({ version: 1, ...held('model.yaml'), ...held('machine.yaml') });
}
