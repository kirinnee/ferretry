import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { it } from 'bun:test';
import { withE2eEnvironment } from './fixture';
import { launchProductBrowser } from './support/product-harness.ts';
import { harnessTeardown } from './support/relay-harness.ts';

const signals: string[] = [];
for (const name of ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2'] as const)
  process.on(name, () => signals.push(`${name}@${new Date().toISOString()}`));

async function stat(pid: number): Promise<string> {
  const s = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => 'gone');
  if (s === 'gone') return 'gone';
  const fields = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return `state=${fields[0]} ppid=${fields[1]} pgrp=${fields[2]} sid=${fields[3]}`;
}

it('probe: does starting an agent session touch the caller group or its pipes', async () => {
  const teardown = harnessTeardown();
  try {
  await withE2eEnvironment(async environment => {
    // Chrome FIRST, exactly as a journey has it: launched before the daemon, through the real harness.
    const browser = await launchProductBrowser(teardown);
    await browser.page.goto('data:text/html,<title>probe</title>');
    const chromePid = Number(Bun.spawnSync(['pgrep', '-P', String(process.pid), '-f', 'chrom']).stdout.toString().trim().split('\n')[0]);
    const trapLog = join(environment.paths.root, 'sentinel-signals.log');
    // A sentinel in THIS process group, with a request/response pipe like Playwright's Chrome pipe.
    const sentinel = spawn('/bin/sh', ['-c', `for s in HUP TERM INT PIPE USR1 USR2; do trap "echo $s >> ${trapLog}" $s; done; while IFS= read -r line; do echo "pong $line"; done`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let replies = '';
    sentinel.stdout.setEncoding('utf8');
    sentinel.stdout.on('data', c => (replies += String(c)));
    let sentinelClosed = '';
    sentinel.stdout.on('close', () => (sentinelClosed = `stdout closed @${new Date().toISOString()}`));
    const ping = async (n: number): Promise<boolean> => {
      sentinel.stdin.write(`${n}\n`);
      const until = Date.now() + 3000;
      while (Date.now() < until) { if (replies.includes(`pong ${n}`)) return true; await Bun.sleep(20); }
      return false;
    };
    await mkdir(join(environment.paths.home, '.claude'), { recursive: true });
    await writeFile(join(environment.paths.home, '.claude', 'CLAUDE.md'), '# probe\n');
    const fakeClaude = await environment.installFakeHarness('claude');
    await environment.setFakeHarnessScenario({ version: 1, steps: [{ type: 'say', text: 'hi' }, { type: 'ask', text: '> ', expect: 'never' }] });
    const fyd = join(environment.repositoryRoot, 'dist', 'bin', 'fyd-linux-x64-baseline');
    await environment.startDaemon({ command: [fyd, '--host', '127.0.0.1', '--port', String(environment.ports.api)], readyUrl: environment.httpUrl('/v1/health'), timeoutMs: 15_000, useDaemonPrivateTmux: true, env: { FY_RELAY_DIRECTORY_ORIGIN: 'http://127.0.0.1:9', FY_CLAUDE_BIN: fakeClaude } });
    const token = (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
    const conn = { FY_URL: environment.httpUrl(), FY_TOKEN: token };
    console.log('test process', await stat(process.pid), 'sentinel', await stat(sentinel.pid!));
    console.log('import', (await environment.runFy(['daemon', 'import', 'claude'], conn)).code);
    for (let round = 1; round <= 10; round += 1) {
      const started = await environment.runFy(['start', '--agent', 'claude-default', `probe round ${round}`, '--json'], conn);
      await Bun.sleep(2500);
      const ok = await ping(round);
      const chromeOk = await Promise.race([browser.page.evaluate<string>('document.title').then(t => t === 'probe'), Bun.sleep(5000).then(() => false)]).catch(() => false);
      console.log(`round ${round}: chrome answers=${String(chromeOk)} chrome ${await stat(chromePid)}`);
      console.log(`round ${round}: start=${started.code} ping=${ok} sentinel ${await stat(sentinel.pid!)} closed=${sentinelClosed || 'no'}`);
    }
    const tmuxPids = (Bun.spawnSync(['pgrep', '-f', `${environment.paths.fyHome}/tmux.sock`]).stdout.toString().trim().split('\n').filter(Boolean));
    for (const pid of tmuxPids) console.log('fyd tmux', pid, await stat(Number(pid)));
    // Which of THIS process's pipes and sockets also appear in fyd or anything it started?
    const fdTargets = async (pid: number): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      const dir = `/proc/${pid}/fd`;
      for (const fd of await (await import('node:fs/promises')).readdir(dir).catch(() => [] as string[])) {
        const target = await (await import('node:fs/promises')).readlink(`${dir}/${fd}`).catch(() => '');
        if (/^(pipe|socket):/u.test(target)) out.set(target, fd);
      }
      return out;
    };
    const mine = await fdTargets(process.pid);
    const sentinelPipes = await fdTargets(sentinel.pid!);
    const descendants = (root: number): number[] => {
      const kids = Bun.spawnSync(['pgrep', '-P', String(root)]).stdout.toString().trim().split('\n').filter(Boolean).map(Number);
      return kids.flatMap(kid => [kid, ...descendants(kid)]);
    };
    const daemonPid = Number(Bun.spawnSync(['pgrep', '-f', `fyd-linux-x64-baseline --host 127.0.0.1 --port ${environment.ports.api}`]).stdout.toString().trim().split('\n')[0]);
    const chromeFds = await fdTargets(chromePid);
    for (const [t] of chromeFds) mine.set(t, `chrome:${chromeFds.get(t)}`);
    const suspects = [daemonPid, ...descendants(daemonPid), ...tmuxPids.map(Number).flatMap(p => [p, ...descendants(p)])];
    for (const pid of [...new Set(suspects)].filter(Boolean)) {
      const theirs = await fdTargets(pid);
      const shared = [...theirs.keys()].filter(t => mine.has(t) || sentinelPipes.has(t));
      const comm = (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '?')).trim();
      console.log(`fds ${pid} (${comm}): ${theirs.size} pipe/socket fds, shared with the test process or sentinel: ${shared.length === 0 ? 'none' : shared.map(t => `${t} as fd ${theirs.get(t)} (mine fd ${mine.get(t) ?? '-'}, sentinel fd ${sentinelPipes.get(t) ?? '-'})`).join('; ')}`);
    }
    console.log('signals to test process:', signals.join(', ') || 'none');
    console.log('signals to sentinel:', (await readFile(trapLog, 'utf8').catch(() => '')).trim() || 'none');
    sentinel.kill();
  });
  } finally {
    await teardown.closeAll();
  }
}, 300_000);
