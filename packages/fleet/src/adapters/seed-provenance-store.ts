/**
 * The seed-provenance records, in one JSON document beside the manifest.
 *
 * ## ONE STORE, TWO PROCESSES, AND THAT IS THE REASON IT LIVES HERE
 *
 * A daemon WRITES this document — it is the only thing that runs a first-run seed — and both a daemon
 * and `fy fleet health` READ it. Two implementations of one file format would be two spellings of the
 * same fact, and the first host to disagree would be one whose terminal said an account owned its
 * credential while its browser said the opposite. So this is a fleet adapter rather than a daemon one,
 * and it reaches the filesystem the same way every other fleet adapter does.
 *
 * ## BESIDE THE MANIFEST, NEVER INSIDE IT
 *
 * An apply regenerates the manifest from the configuration, and this must survive one — a person who
 * ran `fleet apply` would otherwise lose every record and, with it, the only disclosure this feature
 * makes. It is not the health head either: that document is disposable derived evidence with a
 * fifteen-minute horizon, and every row in it can be rebuilt for free by a pass that already runs.
 * A provenance record cannot be rebuilt at all.
 *
 * ## AN UNREADABLE DOCUMENT IS NO RECORDS, AND THAT COSTS SOMETHING
 *
 * A torn file, a hand edit or a document from a build with a different shape reads as no records, so
 * every account publishes no provenance and the surfaces say nothing about them. That is the same
 * reading a fleet nobody seeded gets, which is the correct fail direction — the alternative is a
 * health report that refuses to answer the question it was actually asked because a disclosure file
 * is damaged. It is also a real loss: the fact is gone and cannot be recomputed. Declared, not hidden.
 *
 * A WRITE FAILURE PROPAGATES. The caller is the one place that knows a failed provenance write must
 * not fail the boot it rode in on, and a store that silently dropped writes would be indistinguishable
 * from one whose records never change.
 *
 * The document is `0600`: it holds digests rather than material, and a digest is an equality token
 * rather than an oracle, but it is still derived from a credential and nothing else needs to read it.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FleetSeedProvenanceDocumentSchema,
  type FleetSeedProvenanceRecord,
  type FleetSeedProvenanceStore,
  SEED_PROVENANCE_FILE,
  SEED_PROVENANCE_VERSION,
} from '../lib/seed-provenance.ts';

/** Where the document lives, from the fleet directory the layout already owns. */
export function seedProvenancePath(fleetDirectory: string): string {
  return path.join(fleetDirectory, SEED_PROVENANCE_FILE);
}

const FILE_MODE = 0o600;

export class FileSeedProvenanceStore implements FleetSeedProvenanceStore {
  constructor(private readonly file: string) {}

  async read(): Promise<readonly FleetSeedProvenanceRecord[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      // Absent and unreadable are the same answer here — see the module note. They are NOT the same
      // answer about a credential, which is why `classifyCredential` keeps them apart and this does
      // not: there is nothing to protect by distinguishing a missing disclosure file from a damaged
      // one, and both mean the surfaces have nothing to say.
      return [];
    }
    try {
      return FleetSeedProvenanceDocumentSchema.parse(JSON.parse(text)).accounts;
    } catch {
      return [];
    }
  }

  /**
   * Replace the document atomically, so a daemon killed mid-write leaves the previous one.
   *
   * A truncated document reads as no records, which would silently delete every disclosure on the
   * host — the exact fact this file exists to keep. The temporary file is created exclusively and at
   * the final mode, so the record never exists at a wider permission than it ends at.
   */
  async write(records: readonly FleetSeedProvenanceRecord[]): Promise<void> {
    const document = FleetSeedProvenanceDocumentSchema.parse({
      version: SEED_PROVENANCE_VERSION,
      accounts: [...records],
    });
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${String(process.pid)}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: FILE_MODE });
      await rename(temporary, this.file);
      // A rename carries the temporary file's mode, which is already the final one; this only
      // narrows a document that already existed at a wider mode before this build wrote it.
      await chmod(this.file, FILE_MODE);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
