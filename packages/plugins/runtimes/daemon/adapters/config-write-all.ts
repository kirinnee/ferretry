/**
 * The apply pipeline's {@link RuntimeConfigWriter} over the kernel's `ConfigPort.writeAll`: a change's Runtimes
 * documents (`runtimes.yaml`, `runtimes/`, `profiles/`, `model-sets/`) land ALL OR NONE, each against the etag it was
 * composed against, judged by the same Gate judge as any config write (a loosening, or an added `${secret:NAME}`, holds
 * the WHOLE set; nothing is written and the sentence says so).
 *
 * A document that is not Runtimes' own (`logins/<id>.yaml` is Logins', `warden.yaml` Warden's, the harness settings the
 * harness plugins') is NOT written here and not dropped silently: the change is refused in a sentence naming it, because
 * a change that spans owners is not one set (#52 Q3; each owner writes its own file when its own act says so).
 *
 * No document's text is ever put in a sentence: the refusals name a file and an issue, never a value.
 */
import type { ConfigCollectionDef, ConfigFileDef, ConfigPort, ConfigWriteAllDocument } from '@ferretry/kernel/contract';
import { MODEL_SET_ITEMS, PROFILE_ITEMS, RUNTIME_ITEMS, RUNTIMES_CONFIG } from '../../contract/index.ts';
import { type FleetDocumentWrite } from '../lib/provisioning.ts';
import { ConfigWriteConflict, ConfigWriteInvalid, type RuntimeConfigWriter } from '../lib/service/ports.ts';

interface OwnTarget {
  readonly def: ConfigFileDef<any> | ConfigCollectionDef<any>;
  readonly name?: string;
}

const COLLECTIONS: readonly (readonly [string, ConfigCollectionDef<any>])[] = [
  ['runtimes', RUNTIME_ITEMS as unknown as ConfigCollectionDef<any>],
  ['profiles', PROFILE_ITEMS as unknown as ConfigCollectionDef<any>],
  ['model-sets', MODEL_SET_ITEMS as unknown as ConfigCollectionDef<any>],
];

/** Which of Runtimes' own declared files a path under `config/` is, or `undefined` for anything else. */
function ownConfigTarget(relative: string): OwnTarget | undefined {
  if (relative === 'runtimes.yaml') return { def: RUNTIMES_CONFIG as unknown as ConfigFileDef<any> };
  for (const [folder, def] of COLLECTIONS) {
    const match = new RegExp(`^${folder}/([^/]+)\\.yaml$`, 'u').exec(relative);
    if (match?.[1] !== undefined) return { def, name: match[1] };
  }
  return undefined;
}

/** `path` below `configDirectory`, or `undefined` for a path outside it. */
function underConfig(configDirectory: string, path: string): string | undefined {
  const prefix = `${configDirectory.replace(/\/+$/u, '')}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

export function writeAllConfigWriter(
  config: Pick<ConfigPort, 'writeAll'>,
  configDirectory: string,
): RuntimeConfigWriter {
  return {
    write: async documents => {
      if (documents.length === 0) return;
      const set: ConfigWriteAllDocument[] = [];
      const foreign: string[] = [];
      for (const document of documents) {
        const relative = underConfig(configDirectory, document.path);
        const target = relative === undefined ? undefined : ownConfigTarget(relative);
        if (relative === undefined || target === undefined) {
          foreign.push(relative ?? document.path);
          continue;
        }
        set.push(toDocument(document, target));
      }
      if (foreign.length > 0) {
        throw new ConfigWriteInvalid(
          `this change also edits ${foreign.join(', ')}, which another part of Ferretry owns and writes itself; nothing was changed`,
        );
      }
      const outcome = await config.writeAll(set);
      switch (outcome.kind) {
        case 'written':
          return;
        case 'held':
          throw new ConfigWriteInvalid(outcome.sentence);
        case 'conflict':
          throw new ConfigWriteConflict(outcome.path);
        case 'refused':
          throw new ConfigWriteInvalid(
            `${outcome.document?.path ?? 'the change'} was refused (${outcome.reason}): ${outcome.issues
              .map(issue => issue.message)
              .join('; ')}`,
          );
      }
    },
  };
}

function toDocument(document: FleetDocumentWrite, target: OwnTarget): ConfigWriteAllDocument {
  return {
    def: target.def,
    ...(target.name === undefined ? {} : { name: target.name }),
    edit: document.remove === true ? { remove: true } : document.content,
    ...(document.expect === undefined ? {} : { ifMatch: document.expect }),
  };
}
