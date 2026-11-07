import { readFile } from 'node:fs/promises';
import type { StoredCredentialResolution } from '../../daemon/lib/credentials/credentials.ts';
import type { CredentialStoreInspection } from '../../daemon/lib/shared/store-inspection.ts';

/**
 * A test-owned store reader: whether the file a harness writes its own login to holds anything. The daemon half cannot
 * open a harness store (it is opaque state), so the integration tier supplies this where the old tier used the platform
 * store; it reads a temporary HOME the test wrote, never a real one.
 */
export async function fileStoreInspection(resolution: StoredCredentialResolution): Promise<CredentialStoreInspection> {
  const file = resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile;
  const location = `the file ${file}`;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const usable = typeof parsed.claudeAiOauth === 'object' || typeof parsed.tokens === 'object';
    return {
      reading: usable ? { state: 'valid' } : { state: 'unreadable', reason: 'it holds no login' },
      checked: [{ location, found: 'present' }],
    };
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT';
    return {
      reading: missing ? { state: 'missing' } : { state: 'unreadable', reason: 'it could not be read' },
      checked: [
        { location, found: missing ? 'nothing' : 'unreadable', ...(missing ? {} : { why: 'it could not be read' }) },
      ],
    };
  }
}
