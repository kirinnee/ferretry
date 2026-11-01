/** The launcher this host uses to open a URL, or `undefined` where there is none. */
const launcher = (platform: NodeJS.Platform): string | undefined =>
  platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : undefined;

/** Hands a link to this host's browser; resolves to whether a launcher was started. A headless box is not an error. */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = launcher(platform);
  // Bun reads PATH once at start-up, so both the lookup and the spawn are told which PATH to use.
  if (command === undefined || Bun.which(command, { PATH: env.PATH ?? '' }) === null) return false;
  try {
    Bun.spawn([command, url], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
