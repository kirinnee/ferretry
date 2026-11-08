/**
 * The Tailwind config the scene builder hands to PostCSS, with its content globs made absolute.
 *
 * `relative: true` means "relative to the config FILE", but a config handed over as an object has no file, so
 * Tailwind resolves the globs against the working directory. The builder runs in the asking plugin's test folder,
 * where those globs match nothing, and every plugin scene's sheet came out with no utility classes at all.
 */
import { resolve } from 'node:path';
import type { Config } from 'tailwindcss';

export const contentFromPackage = (config: Config, packageRoot: string): Config => {
  const { content } = config;
  const files = Array.isArray(content) ? content : content.files;
  return {
    ...config,
    content: files.map(file => (typeof file === 'string' ? resolve(packageRoot, file) : file)),
  };
};
