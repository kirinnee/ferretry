import type { EngineFile } from '../engine/catalog.ts';

/**
 * THE NATIVE ENGINE'S FILES (docs/design/voice-modes.md §2.3, "download the native runtime on Install, like the model").
 * sherpa-onnx's own compiled library, in the official npm platform package `sherpa-onnx-<platform>-<arch>` at the one
 * version `package.json` pins for the WebAssembly engine: three files, the Node addon and the two shared libraries it
 * links beside itself (its run-path is `$ORIGIN` / `@loader_path`, so they must sit in ONE folder). NOTHING OF IT IS IN
 * THE RELEASE: Install fetches the three files of THIS machine's package from the npm CDN, checks each against the size and
 * SHA-256 pinned here (refusing a file that is not exactly it, keeping nothing of it), and keeps them in the engine's own
 * folder under `state/voice/models/`, where removing the engine removes them.
 *
 * The role of each file is its real file name, because the loader finds the libraries by name. The hashes are the files'
 * in the published `sherpa-onnx-*-2.0.3.tgz` (the CDN serves byte-identical copies; the pins were compared). A platform
 * with no row here has no native build we pin, and its engines say so and run on WebAssembly.
 */

/** The version of the npm platform packages: the same one `@ferretry/plugin-voice`'s `sherpa-onnx` dependency pins. */
export const NATIVE_VERSION = '2.0.3';

/** The role (and file name) of the Node addon: the file a worker loads; the other two are what it links. */
export const NATIVE_ADDON_ROLE = 'sherpa-onnx.node';

export interface NativeTarget {
  /** `<platform>-<arch>` as Node spells them, e.g. `linux-x64`. */
  readonly key: string;
  /** The addon first, then its two libraries. */
  readonly files: readonly EngineFile[];
}

const cdn = (target: string, name: string): string =>
  `https://cdn.jsdelivr.net/npm/sherpa-onnx-${target}@${NATIVE_VERSION}/${name}`;

function target(key: string, rows: readonly (readonly [name: string, bytes: number, sha256: string])[]): NativeTarget {
  return {
    key,
    files: rows.map(([name, bytes, sha256]) => ({
      role: name,
      label: name === NATIVE_ADDON_ROLE ? 'Native speech engine' : `Native speech engine library (${name})`,
      url: cdn(key, name),
      bytes,
      sha256,
    })),
  };
}

export const NATIVE_TARGETS: readonly NativeTarget[] = [
  target('linux-x64', [
    ['sherpa-onnx.node', 1_015_768, 'd3fe813a27624721e5f448b8d3b00b687ff339e16b0a7bde026ee21edb4a1c64'],
    ['libsherpa-onnx-c-api.so', 5_797_000, '0d8f09758e9b04a571a6915eae7f29dcd3489f795b1648563ba4c87f35674f39'],
    ['libonnxruntime.so', 27_026_609, '4b3607aebd1784b26b6f9b20e4bd974c7ab8287043e4d095cb7d2cb40b5e566e'],
  ]),
  target('linux-arm64', [
    ['sherpa-onnx.node', 946_808, '8e240766973fe8b5484a5cee2fcfa1bc7245dd12293b50d0d5c0bd79db97afba'],
    ['libsherpa-onnx-c-api.so', 5_236_496, '3bb1de29bc28a9928ba4aec5fe9543e5542861236baa7c877e2e362d97d7145c'],
    ['libonnxruntime.so', 34_606_912, 'cfc800d4438f15e8d9017521326776ca7117d8783cb847ccccc2fc61ac4d540f'],
  ]),
  target('darwin-arm64', [
    ['sherpa-onnx.node', 928_352, 'dbddddaf9dcdb7a36fb076a722eb68ff1fba8117fbfdef6b59467b998fbf4619'],
    ['libsherpa-onnx-c-api.dylib', 4_972_856, '0a7562cab532282d3dda62d36fdb42b3fc472ac842b97a05e5f068d3fa8ee8fd'],
    ['libonnxruntime.dylib', 29_006_384, 'b0613d0ae53199a83b05fa48e169211498e9d40d54beaa372068ebe5ec5b0929'],
  ]),
];

/** The pinned native files of a machine, or `undefined` when there is no native build we pin for it. */
export function nativeTargetFor(platform: string, arch: string): NativeTarget | undefined {
  return NATIVE_TARGETS.find(candidate => candidate.key === `${platform}-${arch}`);
}

/** The most threads an engine takes, however many cores there are: the measured knee (`docs/design/voice-modes.md`). */
export const NATIVE_MAX_THREADS = 4;

/** The threads a native engine decodes with: four, and never more than the cores less one, so the daemon keeps a core. */
export function nativeThreads(cores: number): number {
  return Math.max(1, Math.min(NATIVE_MAX_THREADS, Math.floor(cores) - 1));
}

/** What the native engine needs from the machine: its pinned files (if any) and how many threads it may take. */
export interface NativeParts {
  readonly target: NativeTarget | undefined;
  /** Read at each load, so a change of the machine's limits is taken up without a restart. */
  readonly threads: () => number;
  /** This machine's `<platform>-<arch>`, for the sentence that says why there is no native engine. */
  readonly platform: string;
}
