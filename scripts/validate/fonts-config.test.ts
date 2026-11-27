import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const GATE = join(root, 'scripts/validate/fonts-config.ts');
const REAL = process.env.FONTCONFIG_FILE ?? '';
const HAS_FC = spawnSync('fc-list', ['--version'], { encoding: 'utf8' }).status === 0;
/** Only a pinned Linux shell has the hermetic file and `fc-list`; anywhere else these cases have nothing to measure. */
const pinned = REAL.startsWith('/nix/store/') && HAS_FC;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

/** The font root the pinned file names, read from the file itself. */
const dejavuRoot = (): string => /<dir>(\/nix\/store\/[^<]*dejavu[^<]*)<\/dir>/.exec(readFileText(REAL))?.[1] ?? '';
const readFileText = (path: string): string => spawnSync('cat', [path], { encoding: 'utf8' }).stdout;

const config = (dir: string, body: string): string => {
  const file = join(dir, 'fonts.conf');
  writeFileSync(
    file,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n${body}\n</fontconfig>\n`,
  );
  return file;
};

/** A synthetic home with a font planted where a host would keep one: ~/.nix-profile, the XDG data dir and ~/.fonts. */
const plantedHome = (): { env: Record<string, string>; planted: string[] } => {
  const home = temp('fy-fonts-home-');
  const xdg = join(home, 'xdg-data');
  const planted = [join(home, '.nix-profile/share/fonts'), join(xdg, 'fonts'), join(home, '.fonts')];
  const source = join(dejavuRoot(), 'share/fonts/truetype');
  const sample = readdirSync(source).find(name => name.endsWith('.ttf'));
  for (const dir of planted) {
    mkdirSync(dir, { recursive: true });
    if (sample !== undefined) copyFileSync(join(source, sample), join(dir, 'planted-by-the-host.ttf'));
  }
  return {
    env: {
      HOME: home,
      XDG_DATA_HOME: xdg,
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_CONFIG_HOME: join(home, 'config'),
    },
    planted,
  };
};

const listFonts = (file: string, env: Record<string, string>): string[] => {
  const result = spawnSync('fc-list', ['--format', '%{file}\n'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', FONTCONFIG_FILE: file, ...env },
  });
  expect(result.status).toBe(0);
  return result.stdout.split('\n').filter(line => line !== '');
};

/** A directory holding an `fc-list` that prints the given files, so the gate's own run is not the host's fontconfig. */
const stubFcList = (files: readonly string[]): string => {
  const bin = temp('fy-fc-bin-');
  const stub = join(bin, 'fc-list');
  writeFileSync(stub, `#!/usr/bin/env bash\n${files.map(file => `echo ${file}`).join('\n')}\n`);
  chmodSync(stub, 0o755);
  return bin;
};

const gate = (file: string, extraPath?: string) =>
  spawnSync('bun', [GATE, file], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: extraPath === undefined ? (process.env.PATH ?? '') : `${extraPath}:${process.env.PATH}`,
    },
  });

const STORE_DIR = '<dir>/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dejavu-fonts-2.37</dir>';

describe('the fonts-config gate (static)', () => {
  test('accepts a file that names only a /nix/store DejaVu root', () => {
    const result = gate(config(temp('fy-fonts-'), STORE_DIR), stubFcList(['/nix/store/aaaa-dejavu/a.ttf']));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  // What `pkgs.makeFontsConf` generated before: the host's conf.d, the XDG and home font dirs and the host font dirs.
  test('FAILS the file the shell used to be handed (host include, XDG dir, home dirs, host dirs)', () => {
    const legacy = config(
      temp('fy-fonts-'),
      [
        '<include ignore_missing="yes">/etc/fonts/conf.d</include>',
        '<dir prefix="xdg">fonts</dir>',
        STORE_DIR,
        '<dir>~/.nix-profile/lib/X11/fonts</dir>',
        '<dir>~/.nix-profile/share/fonts</dir>',
        '<dir>/usr/share/fonts</dir>',
      ].join('\n'),
    );
    const result = gate(legacy);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('<include>');
  });

  for (const [name, body, says] of [
    ['an <include> of any file', `${STORE_DIR}\n<include>/nix/store/x-conf/fonts.conf</include>`, '<include>'],
    ['an XDG font dir', `${STORE_DIR}\n<dir prefix="xdg">fonts</dir>`, 'not a plain /nix/store path'],
    ['a home font dir', `${STORE_DIR}\n<dir>~/.nix-profile/share/fonts</dir>`, 'not a plain /nix/store path'],
    ['a host font dir', `${STORE_DIR}\n<dir>/usr/share/fonts</dir>`, 'not a plain /nix/store path'],
    [
      'a font dir that only starts like a store path',
      `${STORE_DIR}\n<dir>/nix/storex/fonts</dir>`,
      'not a plain /nix/store path',
    ],
    ['no DejaVu root', '<dir>/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-other-fonts-1</dir>', 'no DejaVu'],
    ['no font dir at all', '', 'no <dir>'],
  ] as const)
    test(`FAILS on ${name}`, () => {
      const result = gate(config(temp('fy-fonts-'), body));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(says);
    });
});

describe('the fonts-config gate (what fontconfig resolves)', () => {
  test('FAILS when fontconfig lists a font outside /nix/store even though the file looks clean', () => {
    const bin = stubFcList(['/nix/store/aaaa-dejavu/a.ttf', '/home/someone/.fonts/planted.ttf']);
    const result = gate(config(temp('fy-fonts-'), STORE_DIR), bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outside /nix/store');
    expect(result.stderr).toContain('/home/someone/.fonts/planted.ttf');
  });
});

describe.skipIf(!pinned)('the pinned shell font set is hermetic (planted fonts)', () => {
  test('the gate accepts the file this shell hands Chrome', () => {
    const result = spawnSync('bun', [GATE, REAL], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('a font planted in a synthetic home, XDG data dir or ~/.fonts is NOT listed under the pinned file', () => {
    const { env, planted } = plantedHome();
    const listed = listFonts(REAL, env);
    expect(listed.length).toBeGreaterThan(0);
    for (const file of listed) expect(file.startsWith('/nix/store/')).toBe(true);
    for (const dir of planted) expect(listed.some(file => file.startsWith(dir))).toBe(false);
  });

  test('the planted fonts ARE visible to the file the shell used to be handed, and the gate rejects that file', () => {
    const { env, planted } = plantedHome();
    const legacy = config(
      temp('fy-fonts-'),
      `<dir prefix="xdg">fonts</dir>\n<dir>${dejavuRoot()}</dir>\n<dir>~/.nix-profile/share/fonts</dir>\n<dir>~/.fonts</dir>`,
    );
    const listed = listFonts(legacy, env);
    for (const dir of planted) expect(listed.some(file => file.startsWith(dir))).toBe(true);
    expect(gate(legacy).status).toBe(1);
  });
});
