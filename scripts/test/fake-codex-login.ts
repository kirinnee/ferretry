#!/usr/bin/env bun
/**
 * A stand-in for `codex`, for the full-product E2E journeys' sign-in step. Never a real account.
 *
 * It plays the two remote sign-ins the daemon drives (`packages/daemon/src/lib/fleet-login/`), with
 * the output shapes quoted in `codex-flow.ts` and `codex-link.ts`:
 *
 *   `codex … login --device-auth`  prints a device URL and a one-time code, then waits to be killed;
 *   `codex … login`                prints an `auth.openai.com/oauth/authorize` link whose redirect is
 *                                  `http://localhost:1455/auth/callback`, LISTENS there, and on a
 *                                  callback carrying its own `state` writes `$CODEX_HOME/auth.json`
 *                                  and exits 0 — exactly what a pasted callback address completes.
 *
 * `--version` answers like the real CLI so the setup scan can call it installed. Anything else is a
 * session launch and gets a minimal prompt loop, which no journey on main asserts on.
 *
 * Every invocation is appended to `FY_E2E_FAKE_CODEX_LOG` (when set) so a journey can prove the
 * daemon launched THIS file and not a codex on the host's PATH.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const log = process.env.FY_E2E_FAKE_CODEX_LOG;
if (log !== undefined && log !== '') appendFileSync(log, `${JSON.stringify({ argv, codexHome: process.env.CODEX_HOME ?? null })}\n`);

if (argv[0] === '--version' || argv[0] === '-V') {
  console.log('codex-cli 0.156.1');
  process.exit(0);
}

const loginAt = argv.indexOf('login');
if (loginAt === -1) {
  process.stdout.write('Fake Codex ready\n> ');
  for await (const _chunk of Bun.stdin.stream()) process.stdout.write('working\n> ');
  await Bun.sleep(600_000);
  process.exit(0);
}

const rest = argv.slice(loginAt + 1);
if (rest.includes('--device-auth')) {
  console.log('Follow these steps to sign in with ChatGPT using device code authorization:');
  console.log('');
  console.log('1. Open this link in your browser and sign in to your account');
  console.log('   https://auth.openai.com/codex/device');
  console.log('');
  console.log('2. Enter this one-time code (expires in 15 minutes)');
  console.log('   FYE2-E2E01');
  // Nobody approves a fake device grant; the journey switches to the link, which kills this.
  await Bun.sleep(600_000);
  process.exit(1);
}

const state = `fyE2eState${Math.trunc(Math.random() * 1e9).toString(36)}`;
const port = Number(process.env.FY_E2E_FAKE_CODEX_PORT ?? '1455');
const redirect = encodeURIComponent(`http://localhost:${String(port)}/auth/callback`);
let finish: (code: number) => void = () => undefined;
const finished = new Promise<number>(resolve => {
  finish = resolve;
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: request => {
    const url = new URL(request.url);
    if (url.pathname !== '/auth/callback') return new Response('not found', { status: 404 });
    if (url.searchParams.get('state') !== state || (url.searchParams.get('code') ?? '') === '')
      return new Response('state mismatch', { status: 400 });
    const home = process.env.CODEX_HOME;
    if (home === undefined || home === '') return new Response('no CODEX_HOME', { status: 500 });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'auth.json'),
      `${JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'fake-e2e-access', refresh_token: 'fake-e2e-refresh', id_token: 'fake-e2e-id', account_id: 'fake-e2e' }, last_refresh: new Date().toISOString() }, null, 2)}\n`,
    );
    setTimeout(() => finish(0), 50);
    return new Response('Signed in. You can close this window.');
  },
});
console.log('Starting local login server on http://localhost:' + String(port) + '.');
console.log('If your browser did not open, navigate to this URL to authenticate:');
console.log('');
console.log(
  `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fake_e2e&redirect_uri=${redirect}&scope=openid%20profile%20email%20offline_access&state=${state}`,
);
const code = await finished;
console.log('Successfully logged in');
await server.stop(true);
process.exit(code);
