/** The launcher this host uses to open a URL, or `undefined` where there is none. */
const launcher = (platform: NodeJS.Platform): string | undefined =>
  platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : undefined;

/** Hands a link to this host's browser; resolves to whether a launcher was started. A headless box is not an error. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const command = launcher(platform);
  if (command === undefined || Bun.which(command) === null) return false;
  try {
    Bun.spawn([command, url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
