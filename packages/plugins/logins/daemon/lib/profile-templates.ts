/**
 * The environment logins' variable templates, as Runtimes reads them (`LoginsApi.environmentTemplates`).
 *
 * Pure: it takes the login files in effect and keeps, for each environment login, ONLY the fields that say what the login
 * gives a harness: its variables as templates (plain values and `${secret:NAME}` references as written), its preset, its
 * cloud credential reference and its Codex provider. Nothing else of the file travels: not its budget, not its label, not
 * its text. A login that is not an environment login has no template.
 *
 * Plain values travel ONLY from a login file that passes its check. A login whose file is not `valid` (broken, with its last
 * good version in effect, or a loosening edit held for the owner) or one of whose variables holds something that looks like a
 * raw secret is WITHHELD: its name and the NAMES of its variables, never a value, so a value that should not be read is not
 * reachable through this method whatever state the file is in.
 */
import { type EnvironmentLoginTemplate, EnvironmentLoginTemplateSchema, type LoginFile } from '../../contract/index.ts';
import { looksLikeRawSecret, looksSecret } from '../../contract/secret-shape.ts';
import { secretReferencesIn } from '@ferretry/core-vault/contract';

type FileState = 'absent' | 'valid' | 'invalid' | 'held';

/** Every variable of a login across its halves, by name. */
function variablesOf(file: LoginFile): Readonly<Record<string, string>> {
  return { ...file.env, ...file.claude?.env, ...file.codex?.env };
}

/** Whether a variable holds a value that is neither plain text nor a reference: it looks like a raw secret. */
const rawSecretIn = (name: string, value: string): boolean =>
  secretReferencesIn(value).length === 0 && (looksSecret(name, value) || looksLikeRawSecret(name, value));

export function environmentTemplates(
  files: ReadonlyMap<string, LoginFile>,
  stateOf: (id: string) => FileState,
): readonly EnvironmentLoginTemplate[] {
  const templates: EnvironmentLoginTemplate[] = [];
  for (const [id, file] of [...files].toSorted(([left], [right]) => left.localeCompare(right))) {
    if (file.store !== 'environment') continue;
    const variables = variablesOf(file);
    const clean =
      stateOf(id) === 'valid' && !Object.entries(variables).some(([name, value]) => rawSecretIn(name, value));
    templates.push(
      EnvironmentLoginTemplateSchema.parse(
        clean
          ? {
              kind: 'templates',
              id,
              harness: file.harness,
              ...(file.env === undefined ? {} : { env: file.env }),
              ...(file.preset === undefined ? {} : { preset: file.preset }),
              ...(file.cloudCredential === undefined ? {} : { cloudCredential: file.cloudCredential }),
              ...(file.codexProvider === undefined ? {} : { codexProvider: file.codexProvider }),
              ...(file.claude === undefined ? {} : { claude: file.claude }),
              ...(file.codex === undefined ? {} : { codex: file.codex }),
            }
          : { kind: 'withheld', id, harness: file.harness, variables: Object.keys(variables).toSorted() },
      ),
    );
  }
  return templates;
}
