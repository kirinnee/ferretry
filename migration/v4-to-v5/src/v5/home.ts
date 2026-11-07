/**
 * The v5 home marker, written LAST. Until it exists, v5's `decideHome` refuses the folder ("not empty, no
 * home.json"), so a conversion that stopped half way can never be started on by accident.
 */
import { HOME_FORMAT, HomeJsonSchema } from '@ferretry/kernel/contract';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeHomeJson(home: string, at: Date, createdBy: string): Promise<void> {
  const document = HomeJsonSchema.parse({ format: HOME_FORMAT, createdBy, createdAt: at.toISOString() });
  await writeFile(join(home, 'home.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
