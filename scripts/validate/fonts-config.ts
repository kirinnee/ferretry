/**
 * Usage: `bun scripts/validate/fonts-config.ts <fontconfig file>`
 *
 * Fails when a Fontconfig file is not hermetic: the browser tiers measure text, so the font set Chrome sees must be the
 * flake's DejaVu and nothing the host happens to carry (a font in ~/.nix-profile, an XDG data dir, /usr/share/fonts, or
 * whatever /etc/fonts/conf.d pulls in). Run by `pinned-toolchain.sh` on the shell's `FONTCONFIG_FILE`. Two checks:
 *   1. static: no `<include>` at all, and every `<dir>` (comments stripped, trimmed, `..` resolved) is an absolute path
 *      under /nix/store (no `~`, no `prefix="xdg"`, no host path, even when the directory is empty), one of them DejaVu;
 *   2. dynamic (when `fc-list` is on PATH): every font file fontconfig resolves under that file is in /nix/store, so a
 *      directory the static check cannot see still fails.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

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

// Read the file as a fontconfig would, not as text: comments carry no meaning, a closing tag may hold spaces, and a
// path means what it RESOLVES to (`/nix/store/../../tmp/x` is /tmp/x), so each <dir> is parsed out, comments are
// stripped, the path is trimmed and normalised, and only then is it required to sit under /nix/store.
const uncommented = text.replace(/<!--[\s\S]*?-->/g, '');
if (/<!\[CDATA\[|<!--/.test(uncommented))
  fail(`${file} has CDATA or an unterminated comment: the font directories cannot be read reliably`);
const opened = uncommented.match(/<\s*dir\b/gi)?.length ?? 0;
const elements = [...uncommented.matchAll(/<\s*dir\b([^>]*)>([\s\S]*?)<\s*\/\s*dir\s*>/gi)];
if (elements.length !== opened) fail(`${file} has a <dir> element that is not a plain <dir>path</dir> pair`);
if (elements.length === 0) fail(`${file} names no <dir>: Chrome would have no font to draw with`);

const STORE = '/nix/store/';
const resolved: string[] = [];
for (const [entry, attributes = '', body = ''] of elements) {
  // An attribute (prefix="xdg", salt, ...) changes where a path points; an entity or nested tag hides it.
  if (attributes.trim() !== '' || /[<&]/.test(body))
    fail(`${file} has a font directory that is not a plain /nix/store path: ${entry}`);
  const target = posix.normalize(body.trim());
  if (!target.startsWith(STORE) || target.length === STORE.length)
    fail(
      `${file} has a font directory that is not a plain /nix/store path (resolves to '${target}', not under /nix/store): ${entry}`,
    );
  resolved.push(target);
}
if (!resolved.some(target => /^\/nix\/store\/[^/]*dejavu/.test(target)))
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
