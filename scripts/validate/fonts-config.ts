/**
 * Usage: `bun scripts/validate/fonts-config.ts <fontconfig file>`
 *
 * Fails when a Fontconfig file is not hermetic: the browser tiers measure text, so the font set Chrome sees must be the
 * flake's DejaVu and nothing the host happens to carry (a font in ~/.nix-profile, an XDG data dir, /usr/share/fonts, or
 * whatever /etc/fonts/conf.d pulls in). Run by `pinned-toolchain.sh` on the shell's `FONTCONFIG_FILE`. Two checks:
 *   1. static: no `<include>` at all, and every `<dir>` is a plain absolute /nix/store path (no `~`, no `prefix="xdg"`,
 *      no host path), at least one of them DejaVu;
 *   2. dynamic (when `fc-list` is on PATH): every font file fontconfig resolves under that file is in /nix/store, so a
 *      directory the static check cannot see still fails.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const file = process.argv[2] ?? '';
let text = '';
try {
  text = readFileSync(file, 'utf8');
} catch {
  fail(`usage: fonts-config.ts <readable fontconfig file> (got '${file}')`);
}

if (/<include/i.test(text))
  fail(
    `${file} has an <include>: it pulls in a file outside the pinned set (the host's /etc/fonts/conf.d, ~/.config/fontconfig), so the font set is not hermetic`,
  );

const dirs = text.match(/<dir[^>]*>[^<]*<\/dir>/gi) ?? [];
if (dirs.length === 0) fail(`${file} names no <dir>: Chrome would have no font to draw with`);
for (const entry of dirs)
  if (!/^<dir>\/nix\/store\/[^<\s]+<\/dir>$/.test(entry))
    fail(`${file} has a font directory that is not a plain /nix/store path: ${entry}`);
if (!dirs.some(entry => /^<dir>\/nix\/store\/.*dejavu/.test(entry)))
  fail(`${file} names no DejaVu font directory, so Chrome would have no font to draw with`);

const listed = spawnSync('fc-list', ['--format', '%{file}\\n'], {
  encoding: 'utf8',
  env: { ...process.env, FONTCONFIG_FILE: file },
});
// No `fc-list` on PATH (a shell that does not carry it): the static check above is all there is to run.
if (listed.error === undefined) {
  const resolved = listed.stdout.split('\n').filter(line => line !== '');
  if (resolved.length === 0) fail(`fontconfig resolves no font under ${file}`);
  const outside = resolved.filter(path => !path.startsWith('/nix/store/'));
  if (outside.length > 0)
    fail(`fontconfig resolves fonts outside /nix/store under ${file}: ${outside.slice(0, 3).join(' ')}`);
}
