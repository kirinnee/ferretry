/**
 * The Tailwind config a browser scene's stylesheet is built with: the app's own, with its content globs made ABSOLUTE.
 *
 * WHY. `tailwind.config.ts` says `content.relative: true` ("relative to this file"), but Tailwind can honour that only
 * when IT loads the config from a path. Handed the config object (`tailwindcss(tailwindConfig)`), it has no file to be
 * relative to and resolves the globs against `process.cwd()`. Vite runs in `packages/app`, so the app is fine; the scene
 * builder runs in the asking plugin's test folder, where `./src/**` and `../plugins/*` match nothing. Tailwind then
 * warns "No utility classes were detected" and the scene's page has no `.hidden`, `.sr-only`, `.flex` — every
 * geometry assertion over a utility-styled element measures an unstyled one.
 *
 * Anchoring each glob to `packages/app` makes the scan the one Vite does, from whatever directory the builder runs in.
 */
import { isAbsolute, resolve } from 'node:path';
import type { Config } from 'tailwindcss';
import tailwindConfig from '../../../tailwind.config.ts';

/** `packages/app`, the directory `tailwind.config.ts` lives in and its globs are relative to. */
const appRoot = resolve(import.meta.dir, '../../..');

type ContentFile = Extract<Config['content'], { files: unknown }>['files'][number];

const anchor = (file: ContentFile, root: string): ContentFile =>
  typeof file === 'string' ? (isAbsolute(file) ? file : resolve(root, file)) : file;

/** `config` with every relative content glob resolved against `root` (the directory the config file lives in). */
export function anchoredTailwindConfig(config: Config, root: string): Config {
  const { content } = config;
  const files = Array.isArray(content) ? content : content.files;
  return { ...config, content: { files: files.map(file => anchor(file, root)) } };
}

/** The app's Tailwind config, anchored to `packages/app`: what `build-scene.ts` processes the stylesheet with. */
export const sceneTailwindConfig: Config = anchoredTailwindConfig(tailwindConfig, appRoot);
