// Applies placement-rules.ts to `git ls-files packages/` of the reference worktree.
// usage: bun scripts/rebuild/place.ts <ref-worktree> <out.tsv>
import { RULES } from './placement-rules';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export interface Placed {
  path: string;
  owners: string[];
  rule: number;
  note: string;
}

export function placeAll(ref: string): Placed[] {
  const files = execFileSync('git', ['-C', ref, 'ls-files', 'packages/'], { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\n')
    .filter(Boolean);
  const compiled = RULES.map(([owners, src, note], i) => ({
    owners,
    re: new RegExp('^' + src),
    note: note ?? '',
    id: i + 1,
  }));
  return files.map(path => {
    const rel = path.slice('packages/'.length);
    const hit = compiled.find(r => r.re.test(rel));
    if (!hit) return { path, owners: [], rule: 0, note: '' };
    const dm = /^!drop:([a-z-]+)$/.exec(hit.owners);
    // `drop+<subsystem>`: the whole file is compatibility code that <subsystem>'s port deletes
    if (dm) return { path, owners: ['drop', dm[1]!], rule: hit.id, note: hit.note };
    return { path, owners: hit.owners.split('+'), rule: hit.id, note: hit.note };
  });
}

if (import.meta.main) {
  const [ref, out] = process.argv.slice(2);
  if (!ref || !out) throw new Error('usage: place.ts <ref-worktree> <out.tsv>');
  const placed = placeAll(ref);
  writeFileSync(
    out,
    placed.map(p => `${p.path}\t${p.owners.join('+') || 'UNPLACED'}\t${p.rule}\t${p.note}`).join('\n') + '\n',
  );
  const count = new Map<string, number>();
  for (const p of placed) {
    const k = p.owners[0] ?? 'UNPLACED';
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  console.log(
    [...count]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
  );
  console.log('total', placed.length);
}
