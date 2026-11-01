/**
 * Screenshots of the task-plan card and its neighbours (docs/secure-copy.md "Task plans"), at a 390px phone and a
 * 1440px desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/task-plan-screenshot.tsx [out-dir] [states]   # writes task-plan-<state>-<viewport>-<scheme>.png
 *
 * `states` is a comma list of: mixed, picker, cannot, passkey, machine, approved, stopped, fallback, history, settings.
 * "mixed" is a picker, a code account with no history, a sudo line and a paste, with the sudo line and the
 * code ticked. "picker" is a two-account page line with an account picked and ticked. "cannot" is a line that asked
 * for a code the account can't make, beside the three lines a plan can't cover (not in Accounts, via Google, ssh) and
 * a code account with no history. "passkey" is the passkey sheet, over the card, with the daemon's own summary of
 * the selection. "machine" is a selection staged at the machine with `fy plan approve`. "approved" and "stopped" are
 * a plan the owner allowed, and one that has ended. "fallback" and "history" are the input card for a fill that did not
 * apply and one that did. "settings" is Settings › Secure copy › Task plans.
 *
 * Fake fixtures only: no real account, no daemon, no value. Every width asserts no sideways scroll and the touch floor
 * on every button of the phone.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { TaskPlanSchema } from '@ferretry/protocol';
import { Markdown } from '../../src/components/markdown.tsx';
import { AgendaItemView } from '../../src/features/agenda/agenda-item-view.tsx';
import { InputCard } from '../../src/features/input-request/input-card.tsx';
import { TaskPlanCard } from '../../src/features/secure-copy/task-plan-card.tsx';
import { TaskPlansCard } from '../../src/features/secure-copy/task-plans-surface.tsx';
import { StepUpDialog } from '../../src/features/step-up/step-up-dialog.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { fieldsOf } from '../../src/lib/input-card.ts';
import { StepUpGate } from '../../src/lib/step-up-gate.ts';
import {
  EXPIRES, PLAN_ID, RAISED, SESSION, STAGE, GITHUB_WORK, approvedPlan, cannotLine, mixedPlan,
  pickerLine, planOf, sudoLine, codesLine, GITHUB_HOME,
} from '../../tests/support/task-plan-fixtures.ts';
import { NOW, request as fakeRequest } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view');
const client = { request: async () => { throw new Error('the harness has no daemon'); } } as never;
const quiet = () => undefined;

const place = (domain: string) => ({ kind: 'site', domains: [domain], match: [] });
const person = (signIn: string, id: string, username: string, domain: string, totp: boolean) => ({
  signIn, account: { id, label: id.replace(/_/gu, ' ').toLowerCase() }, username, place: place(domain),
  can: { username: true, password: true, totp }, history: true,
});
const base = (line: number, why: string) => ({ line, uses: 1, why, state: 'waiting', flags: [] });
const clickupLine = (line: number) => ({
  ...base(line, 'Open the sprint board'), kind: 'sign-in', fields: ['username', 'password', 'totp'],
  candidates: [person('si_0000000000000011', 'CLICKUP_WORK', 'kirin@atomi.cloud', 'app.clickup.com', true), person('si_0000000000000012', 'CLICKUP_HOME', 'kirinnee', 'app.clickup.com', false)],
  preselect: { signIn: 'si_0000000000000011', why: 'project' },
});
const notInAccountsLine = (line: number) => ({
  ...base(line, 'Read the billing page'), kind: 'sign-in', fields: ['username', 'password'], candidates: [],
  state: 'unavailable', because: 'not-in-accounts',
});
const viaGoogleLine = (line: number) => ({
  ...base(line, 'Open ClickUp as you'), kind: 'sign-in', fields: ['username', 'password'], candidates: [],
  state: 'unavailable', because: 'via-provider',
});
const sshLine = (line: number) => ({
  ...base(line, 'Log in to the build box'), kind: 'terminal-sign-in', fields: ['password'],
  candidates: [{ signIn: 'si_0000000000000013', account: { id: 'SSH_KIRIN_BOX', label: 'ssh kirin-box' }, username: 'kirin', place: { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'deploy.example.com' }, can: { username: false, password: true, totp: false }, history: true }],
  state: 'unavailable', because: 'tool-not-covered',
});

const planFor = () => {
  switch (view) {
    case 'picker': return planOf({ lines: [clickupLine(0), pickerLine(1)] });
    case 'cannot': return planOf({ lines: [cannotLine(0), notInAccountsLine(1), viaGoogleLine(2), sshLine(3), codesLine(4)] });
    case 'machine': return TaskPlanSchema.parse({ ...mixedPlan(), machineStage: { stage: STAGE, lines: [1, 3], askedAt: '2026-08-05T10:01:00.000Z' } });
    case 'approved': return approvedPlan();
    case 'stopped': return planOf({ state: 'approved', answered: { at: '2026-08-05T10:02:00.000Z', by: { kind: 'device', deviceId: 'phone-1' }, proof: 'passkey' }, lines: [{ ...pickerLine(0), state: 'stopped', because: 'did-not-move-on', approved: { signIn: GITHUB_WORK, totp: false, remaining: 1, lastUsedAt: '2026-08-05T10:40:00.000Z' } }, { ...pickerLine(1), state: 'used-up', approved: { signIn: GITHUB_HOME, totp: false, remaining: 0, lastUsedAt: '2026-08-05T10:41:00.000Z' } }, { ...sudoLine(2), state: 'declined' }] });
    default: return mixedPlan();
  }
};
const plan = planFor();

const MACHINE_SUMMARY = [
  'Line 2: sign in as vercel · deploy@atomi.cloud on vercel.com with its username, password and codes, 1 use',
  'Line 4: paste what vercel prints → vercel in a terminal, 1 use',
];

const ASK = 'Allow ' + (plan.lines.length === 1 ? 'this' : 'these ' + String(plan.lines.length)) + ' for this task, without asking, until 2026-08-05 11:58 UTC?';

const item = {
  id: 'A8', source: 'question', sourceRef: PLAN_ID, sourceSeq: 2, kind: 'permission', taskPlan: { planId: PLAN_ID },
  title: 'Asks to approve its sign-ins and pastes in advance',
  subject: ASK,
  why: ASK,
  context: 'The agent says: it needs to open the pull request and deploy.',
  neededBy: EXPIRES, waitingSince: RAISED, raisedBy: 'daemon', raisedBySession: SESSION,
} as never;

const itemView = (extra: object, shown: never = item) => (
  <div style={{ height: '100vh', display: 'grid' }}>
    <AgendaItemView busy={false} error={null} ferret="Hadi" history={[]} item={shown} now={NOW} onAct={() => undefined}
      onClose={() => undefined} position={{ index: 0, total: 1 }} renderProse={text => <Markdown text={text} />} swipeable={false} {...extra} />
  </div>
);

const card = (
  <TaskPlanCard agentName="Hadi" canUsePasskey phase={{ kind: 'idle' }} plan={plan}
    machineSummary={view === 'machine' ? MACHINE_SUMMARY : undefined}
    onApprove={quiet} onConfirmMachine={quiet} onDenyMachine={quiet} onRevoke={quiet} />
);

const DID_NOT_APPLY = { by: 'plan', plan: PLAN_ID, line: 1, outcome: 'did-not-apply', reason: 'rate' } as const;
const FILLED = { by: 'plan', plan: PLAN_ID, line: 1, outcome: 'filled' } as const;
const inputOf = (preapproval: object) => fakeRequest({ preapproval } as never);
const inputItem = (requestId: string) => ({ ...(item as object), kind: 'input', taskPlan: undefined, input: { requestId },
  title: 'Needs your password', subject: 'A password prompt in your terminal', why: 'A password prompt in your terminal' }) as never;

if (view === 'passkey') {
  const gate = new StepUpGate({ ceremony: () => new Promise<void>(() => undefined), describe: () => 'unknown' });
  (globalThis as { __openGate?: () => void }).__openGate = () => void gate.require(daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' }),
    MACHINE_SUMMARY.join('\\n'), 'explicit', 'approve-task-plan', STAGE);
  (globalThis as { __gate?: StepUpGate }).__gate = gate;
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const body = () => {
  if (view === 'settings')
    return <TaskPlansCard busy={false} error={null} onRevoke={quiet} plans={[approvedPlan(), mixedPlan()]} />;
  if (view === 'fallback' || view === 'history') {
    const input = inputOf(view === 'fallback' ? DID_NOT_APPLY : FILLED);
    return itemView({ inputForm: <InputCard agentName="Hadi" client={client} embedded fields={fieldsOf(input)} now={NOW} onDone={() => undefined} request={input} /> }, inputItem(input.id));
  }
  return itemView({ planForm: card });
};
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]">{body()}</div>
    {view === 'passkey' ? <StepUpDialog gate={(globalThis as unknown as { __gate: StepUpGate }).__gate} machineName={() => 'Studio'} /> : null}
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/task-plan-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'task-plan-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'task-plan-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const ALL_STATES = [
  'mixed',
  'picker',
  'cannot',
  'passkey',
  'machine',
  'approved',
  'stopped',
  'fallback',
  'history',
  'settings',
] as const;
const wanted = process.argv[3]?.split(',');
const STATES = ALL_STATES.filter(state => wanted === undefined || wanted.includes(state));

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = url.pathname.startsWith('/assets/fonts/')
      ? Bun.file(join(packageDir, 'src', url.pathname))
      : Bun.file(join(buildDir, url.pathname));
    return new Response(file);
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, shot: 2_700, touch: true },
  { name: 'desktop', width: 1_440, height: 900, shot: 1_700, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.shot },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
        for (const state of STATES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${state}`);
          const surface =
            state === 'settings'
              ? page.locator('[data-task-plans]')
              : state === 'fallback' || state === 'history'
                ? page.locator('[data-input-plan-miss], [data-input-plan-filled]')
                : state === 'passkey'
                  ? page.locator('[data-step-up-confirm]')
                  : page.locator('[data-task-plan]');
          if (state === 'passkey') {
            await page.locator('[data-task-plan]').first().waitFor({ state: 'visible' });
            await page.locator('[data-task-plan-tick="1"]').check();
            await page.locator('[data-task-plan-code-tick="1"]').check();
            await page.locator('[data-task-plan-tick="3"]').check();
            await page.evaluate(() => (globalThis as { __openGate?: () => void }).__openGate?.());
          }
          await surface.first().waitFor({ state: 'visible' });
          if (state === 'mixed') {
            await page.locator('[data-task-plan-tick="1"]').check();
            await page.locator('[data-task-plan-code-tick="1"]').check();
            await page.locator('[data-task-plan-tick="2"]').check();
            await page.locator('[data-task-plan-tick="3"]').check();
          }
          if (state === 'picker') {
            await page.locator('[data-task-plan-tick="0"]').check();
            await page.locator('[data-task-plan-code-tick="0"]').check();
          }
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            const scope = state === 'passkey' ? page.locator('[data-step-up-dialog]') : surface.first();
            for (const height of await scope
              .locator('button')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
            for (const box of await scope.locator('input[type="checkbox"]').evaluateAll(boxes =>
              boxes.map(each => {
                const own = each.getBoundingClientRect();
                const label = each.closest('label')?.getBoundingClientRect();
                return {
                  width: Math.max(own.width, label?.width ?? 0),
                  height: Math.max(own.height, label?.height ?? 0),
                };
              }),
            ))
              if (box.width < 44 || box.height < 44)
                fail(`${where}: a checkbox target is ${box.width}x${box.height}px, under the 44px floor`);
          }
          const target = join(outDir, `task-plan-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
