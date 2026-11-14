/**
 * `banned-globals` (§7.7, spine §4 rule 5): a subsystem reaches the clock, the file system, the environment, the
 * network or processes around the kernel ports. Refused outside the kernel's own host and test host: `Date.now`,
 * `new Date()` with no argument, `setTimeout`/`setInterval`/`setImmediate`, `fetch`, `process.env`,
 * `process.platform`, `Bun.spawn`/`Bun.spawnSync`/`Bun.file`/`Bun.write`, `homedir`, and imports of `fs` and
 * `child_process`. Tests are exempt (they drive the test host's ports).
 *
 * A browser APP half (`<plugin>/app/**`) runs in the browser, not under the kernel (DECISIONS-2 #4): it has no clock
 * port, so `setTimeout`, `setInterval`, `Date.now` and `new Date()` are allowed there (`setImmediate` is not a browser API). It is still refused `fetch`, `process`, `Bun`,
 * `fs` and `child_process`: it reaches its daemon only through the one client it is handed.
 */
import { relative, sep } from 'node:path';
import { type AstNode, type Check, type Finding, memberPath, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { areaOf } from '../gen/lib/imports.ts';
import type { WorkspacePackage } from '../gen/lib/workspace.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';

const BANNED_MEMBERS = new Map<string, string>([
  ['Date.now', 'use kernel.clock.now()'],
  ['process.env', 'declare config, or take it from a kernel port'],
  ['process.platform', 'take it from a kernel port'],
  ['Bun.spawn', 'use kernel.spawn'],
  ['Bun.spawnSync', 'use kernel.spawn'],
  ['Bun.file', 'use kernel.state or a root handle'],
  ['Bun.write', 'use kernel.state or a root handle'],
  ['os.homedir', 'use a declared root'],
]);
/** What a browser app half may use: the page's own clock and timers (DECISIONS-2 #4). */
const BROWSER_ALLOWED = new Set(['Date.now', 'new Date()', 'setTimeout', 'setInterval']);
const BANNED_CALLS = new Map<string, string>([
  ['setTimeout', 'use kernel.clock.after'],
  ['setInterval', 'use kernel.clock.every or a job'],
  ['setImmediate', 'use kernel.clock'],
  ['fetch', 'use kernel.fetch'],
  ['homedir', 'use a declared root'],
]);
const BANNED_MODULES = new Map<string, string>([
  ['fs', 'use kernel.state or a root handle'],
  ['fs/promises', 'use kernel.state or a root handle'],
  ['child_process', 'use kernel.spawn'],
]);

function bareModule(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

/** Findings for one file. Pure over its source; the planted-violation tests call it directly. */
export function bannedIn(file: string, where = file, browser = false): Finding[] {
  const check = 'banned-globals';
  const findings: Finding[] = [];
  const parsed = parseFile(file);
  const add = (node: AstNode, what: string, fix: string): void => {
    findings.push({ check, where: `${where}:${parsed.line(node.start)}`, message: `${what}: ${fix}` });
  };
  walk(parsed.program, (node, parents) => {
    const parent = parents[parents.length - 1];
    if (
      parents.some(
        p =>
          p.type.startsWith('TS') &&
          p.type !== 'TSAsExpression' &&
          p.type !== 'TSNonNullExpression' &&
          p.type !== 'TSSatisfiesExpression',
      )
    )
      return;
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      const source = (node.source as { value?: string } | null)?.value;
      if (source === undefined) return;
      const fix = BANNED_MODULES.get(bareModule(source));
      if (fix !== undefined && node.importKind !== 'type' && node.exportKind !== 'type')
        add(node, `imports ${source}`, fix);
      if (bareModule(source) === 'os')
        for (const spec of (node.specifiers as readonly AstNode[] | undefined) ?? [])
          if ((spec.imported as { name?: string } | undefined)?.name === 'homedir')
            add(spec, 'imports homedir', 'use a declared root');
      return;
    }
    if (node.type === 'MemberExpression') {
      const path = memberPath(node);
      if (path === undefined) return;
      const key = path.slice(0, 2).join('.');
      const fix = BANNED_MEMBERS.get(key);
      // Report the outermost two-segment chain once, not each prefix.
      if (fix !== undefined && path.length === 2 && !(browser && BROWSER_ALLOWED.has(key))) add(node, key, fix);
      return;
    }
    if (node.type === 'NewExpression') {
      const callee = node.callee as AstNode;
      if (callee.type === 'Identifier' && callee.name === 'Date' && (node.arguments as readonly unknown[]).length === 0)
        if (!browser) add(node, 'new Date()', 'use kernel.clock.now()');
      return;
    }
    if (node.type === 'Identifier') {
      const fix = BANNED_CALLS.get(node.name as string);
      if (fix === undefined || parent === undefined || (browser && BROWSER_ALLOWED.has(node.name as string))) return;
      const asProperty =
        (parent.type === 'MemberExpression' && parent.property === node && parent.computed !== true) ||
        ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
          parent.key === node &&
          parent.computed !== true);
      const declared =
        (parent.type === 'VariableDeclarator' && parent.id === node) ||
        (parent.type === 'FunctionDeclaration' && parent.id === node) ||
        parent.type === 'ImportSpecifier';
      if (!asProperty && !declared) add(node, node.name as string, fix);
    }
  });
  return findings;
}

/**
 * Code that runs OUTSIDE the kernel, so it has no kernel ports to reach the world through (lead decision 17). Each
 * entry is a package-relative folder or file, matched by prefix, with its reason; an entry ending in `.ts`/`.tsx` names ONE file and matches it exactly; nothing else is exempt.
 */
export const OUTSIDE_THE_KERNEL: readonly { readonly pkg: string; readonly folder: string; readonly reason: string }[] =
  [
    { pkg: 'connections', folder: 'worker/', reason: 'the standalone Cloudflare relay Worker, deployed on its own' },
    { pkg: 'catalogs', folder: 'worker/', reason: 'the standalone Cloudflare catalog Worker, deployed on its own' },
    {
      pkg: 'logins',
      folder: 'scripts/publish-model-catalog.ts',
      reason: 'a build-time script the app build runs to write dist/catalog; it never runs inside a daemon',
    },
    {
      pkg: 'logins',
      folder: 'scripts/built-ins.ts',
      reason:
        'a developer-run generator that writes daemon/lib/built-ins.json from the shipped YAML (and its --check); it never runs inside a daemon',
    },
    {
      pkg: 'connections',
      folder: 'daemon/adapters/webrtc/node-datachannel-engine.ts',
      reason: 'the WebRTC native engine (node-datachannel), loaded below the carrier rather than through a port',
    },
    {
      pkg: 'browsers',
      folder: 'daemon/worker/adapters/',
      reason: 'the agent-browser worker, its own process (lead decision, port-browsers r1)',
    },
    {
      pkg: 'browsers',
      folder: 'daemon/worker/main.ts',
      reason: 'the agent-browser worker entry, run as its own Node process (lead decision, port-browsers r1)',
    },
    {
      pkg: 'browsers',
      folder: 'daemon/proxy/firewall/marker-reader.ts',
      reason:
        'reads the root-owned loopback firewall marker under /etc, a host file outside every declared root (lead ruling, banned-globals r1)',
    },
    {
      pkg: 'browsers',
      folder: 'daemon/tools/adapters/staged-files.ts',
      reason:
        'opens staged copies O_NOFOLLOW|O_EXCL (O_TRUNC when overwrite is set) and streams a bounded binary copy, which no root handle does; it also places the daemon upload copies and sweeps the upload directory with a recursive rm (lead ruling, banned-globals r1)',
    },
    {
      pkg: 'browsers',
      folder: 'daemon/worker/control/adapters/profile-store.ts',
      reason:
        'Chrome takes a real --user-data-dir: real profile directories, SingletonLock readlink, O_EXCL lease files (lead ruling, banned-globals r1)',
    },
    {
      pkg: 'browsers',
      folder: 'daemon/worker/control/adapters/login-runtime.ts',
      reason:
        'real directories and files that Xvfb, x11vnc and Chrome read by path: the Xauthority cookie and the VNC password file; it also probes the Chrome executable candidates with existsSync (lead ruling, banned-globals r1)',
    },
    {
      pkg: 'browsers',
      folder: 'daemon/adapters/host.ts',
      reason:
        'host facts: the named environment variables only, platform and architecture, the program search path, path existence (existsSync, for Chrome and worker discovery), this executable (realpathSync of execPath) and its worker (lead ruling, banned-globals r1)',
    },
    {
      pkg: 'access',
      folder: 'cli/adapters/pair/browser-opener.ts',
      reason:
        'fy itself opens a browser on the person desktop from their terminal, and writes the pairing redirect page (a live credential, wx 0600) into the state home and removes it with a recursive rm (lead ruling banned-globals r1)',
    },
    {
      pkg: 'access',
      folder: 'cli/adapters/pairing-redirect-sweep.ts',
      reason:
        'fy itself sweeps its own pairing redirect files, a live credential, in the home it runs in (lead ruling)',
    },
    {
      pkg: 'access',
      folder: 'cli/adapters/host.ts',
      reason:
        'fy at the person terminal: its state home (FY_HOME, the home directory) and the prompt it reads (lead ruling)',
    },
    {
      pkg: 'accounts',
      folder: 'cli/adapters/terminal.ts',
      reason: 'fy at the person terminal: the hidden-read prompt and the pane session variables (lead ruling)',
    },
    {
      pkg: 'terminals',
      folder: 'cli/adapters/attach/tmux-attacher.ts',
      reason: 'fy itself attaches the person terminal to tmux (lead ruling)',
    },
    {
      pkg: 'terminals',
      folder: 'daemon/adapters/host/fs.ts',
      reason:
        'the single host-fs seam for owner-named executables, output files, working-directory checks (stat of any cwd path) and login shells outside FY_HOME, and the /proc and /sys reads; it also reaches this process pid and uid, process.kill (signals), the CPU and memory counts, userInfo and process.platform; its one environment read is SHELL (lead ruling, DECISIONS-2 #21)',
    },
  ];

/** A `.ts`/`.tsx` entry is one file, matched exactly; any other entry is a folder, matched by prefix. */
function matchesExemption(rel: string, entry: string): boolean {
  return /\.tsx?$/u.test(entry) ? rel === entry : rel.startsWith(entry);
}

export function bannedScope(pkg: WorkspacePackage, file: string): boolean {
  if (pkg.kind !== 'core' && pkg.kind !== 'plugin') return false;
  const rel = relative(pkg.dir, file).split(sep).join('/');
  if (OUTSIDE_THE_KERNEL.some(exempt => exempt.pkg === pkg.id && matchesExemption(rel, exempt.folder))) return false;
  const area = areaOf(pkg, file);
  return area !== 'tests' && area !== 'kernel-host' && area !== 'kernel-testing' && area !== 'generated';
}

export const check: Check = {
  name: 'banned-globals',
  summary: 'subsystems reach the world only through kernel ports',
  async run(ctx) {
    const ws = loadWorkspace(ctx.root);
    const findings: Finding[] = [];
    for (const pkg of ws.packages) {
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      for (const file of sourceFiles(pkg))
        if (bannedScope(pkg, file))
          findings.push(...bannedIn(file, relative(ws.root, file).split(sep).join('/'), areaOf(pkg, file) === 'app'));
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
