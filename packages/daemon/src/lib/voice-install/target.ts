import type { VoiceRuntimeTarget } from '@ferretry/protocol';

/**
 * Which published runtime this machine takes, from the platform and CPU the process reports. A pure
 * function over two strings: the adapter that reads `process` is one line, and every pair — including the
 * ones with no prebuild — is a test row.
 */
export function voiceRuntimeTargetFor(
  platform: string,
  arch: string,
): VoiceRuntimeTarget | { readonly unsupported: string } {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  return {
    unsupported: `the speech engine has no prebuilt runtime for ${platform} on ${arch}; it runs on Linux (x64, arm64) and macOS (Apple Silicon)`,
  };
}
