/**
 * Every configuration file kind a plugin of this build declares — read from the generated registry, so a kind added
 * tomorrow is swept by the bound tests without anyone listing it — and the texts each is swept with: ONE hostile text
 * per kind built from its own schema ({@link schemaTexts}), and the shapes review round 7 measured on the real
 * `mcp/<name>.yaml` schema. A test that took any value (`z.unknown()`) could not produce a schema issue at all.
 */
import type { Manifest } from '../../../manifest/index.ts';
import kernelManifest from '../../../plugin.ts';
import type { ConfigDeclaration } from '../../../host/config/claims.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { agentMayName } from '../../../host/config/agent-reach.ts';
import { filled, schemaTexts } from './schema-texts.ts';

/** One declared kind: who declares it, the def, and the path a file of it is swept at. */
export interface DeclaredKind extends ConfigDeclaration {
  /** Relative to `config/`: the file, or `<folder>/sweep.yaml` for a folder of named files. */
  readonly path: string;
  /** The name of the swept file inside a folder; absent for a single file. */
  readonly name?: string;
  /** Whether an agent may name this path (`config_read` / `config_validate` / `config_write`). */
  readonly agentMayName: boolean;
}

/** Every kind declared in this build, the kernel's own included. */
export function declaredKinds(): readonly DeclaredKind[] {
  const manifests: readonly Manifest[] = [
    kernelManifest,
    ...daemonImplementations.map(implementation => implementation.manifest),
  ];
  return manifests.flatMap(manifest =>
    ((manifest.data?.config ?? []) as readonly ConfigDeclaration['def'][]).map(declared => {
      const path = declared.shape === 'file' ? declared.file : `${declared.collection}/sweep.yaml`;
      return {
        plugin: manifest.id,
        def: declared,
        path,
        ...(declared.shape === 'file' ? {} : { name: 'sweep' }),
        agentMayName: agentMayName(path) && declared.personOnly !== true,
      };
    }),
  );
}

/**
 * The one text each kind is swept with at the cap: its first own mapping or list (else the top of the file) filled with
 * objects of wrong fields — the shape the full sweep found slowest — so every entry is a schema issue to locate.
 */
export function sweepTextOf(kind: DeclaredKind, cap: number): readonly [label: string, text: string] {
  const texts = schemaTexts(kind.def.schema, cap, 1);
  const wrongObjects = texts.filter(([label]) => /objects with wrong fields$/u.test(label));
  const own = wrongObjects.find(([label]) => !label.startsWith('the top:'));
  const chosen = own ?? wrongObjects[0] ?? texts[0];
  if (chosen === undefined) throw new Error(`no hostile text for ${kind.path}`);
  return chosen;
}

/**
 * Review round 7's shapes on the real `mcp/<name>.yaml`: an `env` of many wrong-typed values (one schema issue each,
 * every one located: seconds before the locate walk and the cap), of many bad names, and an `args` that is a YAML 1.1
 * `!!omap` of many keys (resolved by the library inside the parse, quadratically, before any guard here could run).
 */
export function mcpReviewShapes(cap: number): readonly (readonly [label: string, text: string])[] {
  return [
    ['env of many wrong-typed values', filled(cap, 'command: x\nenv:\n', index => ` K${index.toString(36)}: []\n`)],
    ['env of many bad names', filled(cap, 'command: x\nenv:\n', index => ` "k ${index.toString(36)}!": x\n`)],
    [
      'args as a flow !!omap of many keys',
      `${filled(cap - 1, 'command: x\nargs: !!omap [', index => `${index.toString(36)}:,`)}]`,
    ],
    [
      'args as a block !!omap of many keys',
      filled(cap, 'command: x\nargs: !!omap\n', i => `  - ${i.toString(36)}: 1\n`),
    ],
  ];
}
