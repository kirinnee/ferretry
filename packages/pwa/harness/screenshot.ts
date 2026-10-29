/**
 * Build the shell harness, serve it on an ephemeral loopback port, and
 * screenshot it at both viewports.
 *
 * Not part of the shipped bundle, and MOSTLY dev-only: the gallery's job is to make "does the port
 * still look like the original?" a thing a human can answer by opening two PNGs.
 *
 * `--settings-only` IS DIFFERENT — it is a CI gate, and this file therefore has a caller that never
 * looks at a PNG. `scripts/ci/pwa-screenshot-proof.sh` runs that mode in both colour schemes on
 * every push, because the layout failure this harness is best at catching is the one a PNG is worst
 * at showing: `assertNoSidewaysScroll` reads geometry the capture has already clipped away. Before
 * that job existed the whole harness ran only when somebody remembered, which is how an auto margin
 * cancelling flex stretch clipped a surface at 390px with every gate green. Anything that changes
 * what `--settings-only` reaches changes a gate; the counter below is what keeps that honest.
 *
 * It drives the browser through playwright-core with the system Chrome, exactly
 * as the visual integration tests already do, and aborts every request that
 * leaves the loopback origin — a shell harness has no business reaching the
 * network.
 *
 * EVERY ELEMENT CAPTURE GOES THROUGH `captureElement`, and no call here may reach for
 * `locator.screenshot()` again. This page is one document tens of thousands of pixels
 * tall, and a plain element screenshot low in it returns the WRONG CARD'S PIXELS
 * silently — which means the reviews of those cards were never reviews at all. See
 * `gallery-capture.ts` for what was measured and what the replacement guarantees.
 * `page.screenshot()` is a different mechanism and is untouched: it captures the
 * viewport, which is the one thing Chromium has really painted.
 *
 *   bun harness/screenshot.ts            # writes harness/out/*.png
 *   bun harness/screenshot.ts --serve    # leave it running to look at by hand
 *   bun harness/screenshot.ts --files-only   # just the Files/reload/preview frames
 *   bun harness/screenshot.ts --pairing-failures-only   # the two pairing failures that are one sentence
 *   bun harness/screenshot.ts --landing-only # capture the built landing and /get-started/ at both viewports and schemes
 *   bun harness/screenshot.ts --mcp-sign-in-only   # an MCP server's sign-in, its sheet and the callback page
 *   bun harness/screenshot.ts --context-tools-only [--light]   # Info › Context › MCP and Skills, and Components' MCP rows
 *   bun harness/screenshot.ts --pair-from-menu-only [--light]   # Pair a phone from the machine menu
 *   bun harness/screenshot.ts --whats-new-only [--light]   # What's new: the release list, then older versions
 *   bun harness/screenshot.ts --session-context-menu-only [--light]   # right-click menu / long-press sheet on a session row
 *   bun harness/screenshot.ts --about-only [--light]   # Settings › Machine › About and its update states
 *   bun harness/screenshot.ts --agent-clis-only [--light]   # Settings › Machine › Agent CLIs, every install method
 *   bun harness/screenshot.ts --session-layout-only [--light]   # the session page's layout checks, with frames
 *   bun harness/screenshot.ts --settings-only [--light]   # what CI runs
 *   bun harness/screenshot.ts [--settings-only] --viewport mobile|desktop   # one viewport, owing only its share
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright-core';
import { type Browser, chromium, webkit } from 'playwright-core';
import { THEME_FAMILIES } from '../src/lib/theme-preferences.ts';
import { captureElement } from './gallery-capture.ts';
import { assertFixedElementsClear } from './landing-geometry.ts';
import { runSafeAreaGeometry, SAFE_AREA_GEOMETRY_CHECKS } from './safe-area-geometry.ts';
import { runSessionLayoutGeometry, SESSION_LAYOUT_GEOMETRY_CHECKS } from './session-layout-geometry.ts';
import { runSessionsPageGeometry, SESSIONS_PAGE_GEOMETRY_CHECKS } from './sessions-page-geometry.ts';
import { runViewportMatrix } from './viewport-matrix.ts';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

type ViewportName = (typeof VIEWPORTS)[number]['name'];

/**
 * WHICH VIEWPORTS THIS RUN WALKS: both, unless `--viewport mobile|desktop` names one.
 *
 * One viewport is how CI splits the full gallery into two jobs that run side by side, because walking
 * both one after the other made it the longest job CI ran. They are separate JOBS, not two Chromes in one: run at once in one job, three software-rendered Chromes on four cores timed the
 * gallery out in 3 of 7 runs under load (#598). Every tally below is owed PER VIEWPORT, so a one-viewport
 * run owes exactly its viewport's share and both runs together owe what one unsplit run does.
 *
 * A value that is not a viewport is refused rather than read as "both": a typo would otherwise walk
 * twice the frames and owe twice the tally, and pass, which is not the run anybody asked for.
 */
const SELECTED_VIEWPORTS: readonly (typeof VIEWPORTS)[number][] = (() => {
  const at = process.argv.indexOf('--viewport');
  if (at === -1) return VIEWPORTS;
  const wanted = process.argv[at + 1];
  const viewport = VIEWPORTS.find(candidate => candidate.name === wanted);
  if (viewport === undefined) {
    process.stderr.write(
      `❌ --viewport takes one of ${VIEWPORTS.map(candidate => candidate.name).join(', ')}, not ${wanted ?? 'nothing'}\n`,
    );
    process.exit(2);
  }
  return [viewport];
})();

/** Whether this run walks `name`'s viewport. */
const walks = (name: ViewportName): boolean => SELECTED_VIEWPORTS.some(viewport => viewport.name === name);

/** What a per-viewport tally owes over the viewports this run walks: both shares unsplit, one share split. */
const owedOver = (tally: Readonly<Record<ViewportName, number>>): number =>
  SELECTED_VIEWPORTS.reduce((sum, viewport) => sum + tally[viewport.name], 0);

/** The run's viewports, for its closing lines: a split run's log says which share it proved. */
const VIEWPORT_LABEL = SELECTED_VIEWPORTS.map(viewport => viewport.name).join(' + ');

/** A real phone context: a 390px desktop is not the mobile journey this UI serves. */
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
} as const;

/**
 * WHICH COLOUR SCHEME THE CAPTURE RUNS IN, because both themes are a review
 * state and only one of them was ever reachable here.
 *
 * `pre-paint.js` resolves the theme from `prefers-color-scheme` before first
 * paint, so a light capture is a different first frame rather than a class
 * toggle — it has to be emulated at the CONTEXT, exactly as `app-screenshot.ts`
 * already does. The captures keep their existing names: a two-theme review is
 * two runs into two directories, not two filename conventions.
 *
 * `harness/index.html` loads that same `pre-paint.js`, and must. A page that booted dark and was
 * flipped to light by the shell after mount started a colour transition on 3117 elements at once, and
 * a capture that finishes transitions first spent its whole 30s budget on them — the light-only
 * `screenshot: Timeout 30000ms exceeded` on the unlock screen, in about one CI run in nine.
 */
const SCHEME: 'light' | 'dark' = process.argv.includes('--light') ? 'light' : 'dark';

const SETTINGS_ONLY = process.argv.includes('--settings-only');
const TASK_BOARD_ONLY = process.argv.includes('--task-board-only');
const SEARCH_ONLY = process.argv.includes('--search-only');
const ATTENTION_ONLY = process.argv.includes('--attention-only');
const PROJECTS_ONLY = process.argv.includes('--projects-only');
/** Settings › Warden's "What Jev may do alone" rows and the Warden page's Recent actions, nothing else. */
const WARDEN_ONLY = process.argv.includes('--warden-only');
/** Signing in to a remote MCP server: the Components tab's Sign-in section, its sheet, and the callback page. */
const MCP_SIGN_IN_ONLY = process.argv.includes('--mcp-sign-in-only');
/** Info › Context's MCP and Skills sub-tabs (every scope, Check, Sign in, Open), and the Components MCP rows. */
const CONTEXT_TOOLS_ONLY = process.argv.includes('--context-tools-only');
/** "Pair a phone" from the machine menu: the switcher, the sheet and the minted (fake) QR. */
const PAIR_FROM_MENU_ONLY = process.argv.includes('--pair-from-menu-only');
/** "What's new": the in-app release list as a phone sheet and a desktop dialog. */
const WHATS_NEW_ONLY = process.argv.includes('--whats-new-only');
/** The sessions bar's row menu: right-click at the pointer on a desktop, a long-press sheet on a phone. */
const SESSION_CONTEXT_MENU_ONLY = process.argv.includes('--session-context-menu-only');
/** Settings › Machine › About: an update available, the mid-turn choice, and a deb's manual steps. */
const ABOUT_ONLY = process.argv.includes('--about-only');
/** Settings › Machine › Agent CLIs: each install method, the verified/newest buttons and the unverified confirm. */
const AGENT_CLIS_ONLY = process.argv.includes('--agent-clis-only');

/**
 * The Projects hub states, each on a page of its own.
 *
 * A page rather than an element inside the gallery: the hub is taller than a
 * phone, and an element capture inside a scroller clips to the wrong region. Every one of these is a
 * state the shipped component can really be in — `ProjectsHub` takes plain
 * values, so nothing here is posed.
 */
const PROJECTS_FRAMES = ['hub', 'empty', 'loading', 'error', 'refused', 'registered', 'already-registered'] as const;

const FILES_ONLY = process.argv.includes('--files-only');
/** Just the two pairing failures whose sentence is the remedy, at both viewports and in both themes. */
const PAIRING_FAILURES_ONLY = process.argv.includes('--pairing-failures-only');
/** Just the session page's layout geometry (`session-layout-geometry.ts`), capturing its evidence frames. */
const SESSION_LAYOUT_ONLY = process.argv.includes('--session-layout-only');
/** Just the bottom safe-area geometry (`safe-area-geometry.ts`), capturing its evidence frames. */
const SAFE_AREA_ONLY = process.argv.includes('--safe-area-only');
/** Just the Sessions page's sideways-scroll geometry (`sessions-page-geometry.ts`). */
const SESSIONS_PAGE_ONLY = process.argv.includes('--sessions-page-only');
/**
 * The bottom of the app across the device matrix (`viewport-matrix.ts`): iPhones in WebKit when
 * `FY_WEBKIT` names a Playwright WebKit executable, an installed Android app and a desktop in Chromium.
 */
const VIEWPORT_MATRIX_ONLY = process.argv.includes('--viewport-matrix-only');

/**
 * Whether this invocation walks the Settings block at all, which decides which tally it owes.
 *
 * The five narrow modes above `continue` past Settings to reach their own surface, so they legitimately
 * make ZERO sideways-scroll checks — asserting the full tally for them would break every one of these
 * developer entry points the moment the gate was added. `--landing-only` never enters the viewport loop
 * and so is not listed.
 *
 * A mode that skips Settings is held to `=== 0` rather than left unchecked, because the number that
 * must never appear is a PARTIAL one: it would mean the Settings block was entered and then abandoned
 * part-way, which is the failure both tallies exist to catch and the only one an "it's a narrow mode"
 * exemption would hide.
 */
const WALKS_SETTINGS = !(
  SEARCH_ONLY ||
  ATTENTION_ONLY ||
  FILES_ONLY ||
  TASK_BOARD_ONLY ||
  PROJECTS_ONLY ||
  WARDEN_ONLY ||
  PAIRING_FAILURES_ONLY ||
  MCP_SIGN_IN_ONLY ||
  CONTEXT_TOOLS_ONLY ||
  PAIR_FROM_MENU_ONLY ||
  WHATS_NEW_ONLY ||
  SESSION_CONTEXT_MENU_ONLY ||
  ABOUT_ONLY ||
  AGENT_CLIS_ONLY ||
  SESSION_LAYOUT_ONLY ||
  SAFE_AREA_ONLY ||
  SESSIONS_PAGE_ONLY ||
  VIEWPORT_MATRIX_ONLY
);

/**
 * HOW MANY SIDEWAYS-SCROLL CHECKS A RUN THAT WALKS SETTINGS OWES, and the number is the gate.
 *
 * Owed PER VIEWPORT, as measured: ninety-eight on a phone and ninety-five on a desktop, one hundred and
 * ninety-three for a run that walks both. The phone's three more are its MOBILE-ONLY bottom sheets, below.
 * A `--viewport` run owes its own share and nothing else, so the two CI legs cannot both pass while
 * either one skips a frame. Of the extras at each viewport, one is the
 * open per-device capabilities disclosure inside Add a device, one is the unlock screen a locked machine
 * shows, two are the Security settings block's loosening sentence and out-of-bounds sentence, and two
 * are the Files panel and its Edit as YAML sheet showing a refused save's located issues.
 *
 * MACHINES, sixty-four per viewport: its section, four tab switches, five Settings-tab flows (Import
 * again found + names, Clone source, Clone preview with what it runs, Install), the Machines list the switcher opens, eleven Runtimes and
 * Credentials pages, three runtime dialogs (Rename, Remove with ferrets to move, Remove the default runtime), three Remove-a-login dialogs (nobody uses it, two runtimes switched, a runtime removed too) and a login page's Remove, a sign-in picked up where it was left, four Codex sign-in screens (device code, link,
 * its callback port held by another program, finishing), the old pairing a reset left, four Add a login frames (its tiles,
 * its sign-in, the provider tiles and a provider's key),
 * eighteen Profiles and Components pages (a profile page, a delete card, a refused mix, an override chip,
 * the Resolved view, Edit as YAML, a mixed profile, a new profile built by drag and drop — and on a phone its
 * Add picker too, the one frame a desktop has no equivalent of — a component with every badge, a
 * Settings list with scope badges, instructions as Markdown and as source, two edit forms), and seven other-machine states (offline; the first run that opens by
 * itself — tools, the Claude Code question, Codex not signed in, Sign in now in place, nothing set up —
 * and the not-set-up Runtimes card it leaves to). Each of these is also a Machines geometry check, below.
 *
 * The rest, seventeen at both viewports plus the open device-capabilities disclosure, the unlock screen and the Files editor's refused save at both: three Settings sections (Appearance, Behaviour, Daemons), the
 * healthy daemon's Warden and its twelve other panels (Security, the passkey panel, Security log, Files, About & updates and Agent CLIs among them), the unreachable daemon's Warden and Carrier, and the
 * one-daemon route. (The old Fleet and Accounts panels, their eight-step new-account sequence and the
 * Environment panel went with the old account system in U21.) Plus THREE MOBILE-ONLY open bottom
 * sheets, which have no desktop equivalent because a desktop reads a real tablist instead. The asymmetry
 * is the product's, not an omission.
 *
 * Every call site lives in the Settings block, so a `--settings-only` run and a full gallery run owe
 * the same tally — there is no mode reaching Settings in which this number quietly drops.
 *
 * IT IS ASSERTED RATHER THAN REPORTED. A count that is merely printed is a count nobody reads, and
 * the failure being defended against is not a check that goes red — it is a check that stops
 * happening. Deleting a call site, returning early from a panel loop, or moving a frame out of the
 * mode CI runs would each leave every remaining assertion passing, so the only thing that can tell
 * "nothing is wrong" from "nothing was measured" is this number disagreeing.
 *
 * So when a Settings surface is legitimately added or removed, EDIT THIS, and treat the edit as the
 * moment to say in the pull request which frames the gate covers now. That is the churn this design
 * chose over committed golden images: one integer per intentional change, versus a re-baselined
 * directory of PNGs whose diff nobody can review.
 */
const SETTINGS_SIDEWAYS_CHECKS: Readonly<Record<ViewportName, number>> = { mobile: 98, desktop: 95 };

/**
 * HOW MANY MACHINES GEOMETRY CHECKS A RUN THAT WALKS SETTINGS OWES (`assertMachinesGeometry`), per
 * viewport as the sideways checks are — sixty-four at each, measured. One per Machines frame —
 * fifty-five frames (the section itself is measured once
 * its Runtimes tab has loaded), less the Machines list on a phone, which is a screen of its own outside any
 * machine: 55 + 54 (P3 added an environment login's quota page). Profile scope (P7) added six: a profile's Advanced part open, a mixed profile, a refused
 * mixed draft, the Settings list's scope badges, and instructions rendered as Markdown and as source. Profiles
 * as a bag of components (R5) replaced the profile page's Advanced part, its layer editor and the three
 * Build a profile steps with the drag-and-drop editor's frames — a refused mix, an override chip, the
 * Resolved view, Edit as YAML and a new profile — plus the phone's Add picker: one more in all. The provider
 * tiles added four: the grid and a provider's key form, at each viewport. Same tripwire as the number above, for the same reason — a check
 * that stops being reached reads exactly like a check that passed — so a Machines frame added or removed
 * edits this, and the pull request says which frames the gate covers.
 */
const MACHINES_GEOMETRY_CHECKS: Readonly<Record<ViewportName, number>> = { mobile: 64, desktop: 64 };

/**
 * HOW MANY TERMINAL GEOMETRY CHECKS A RUN THAT WALKS SETTINGS OWES (`assertTerminalGeometry`): one per
 * theme family, at each viewport, in the run's own scheme — CI runs both schemes, so every family is
 * measured light and dark. Same tripwire as the two numbers above: a family added to the catalogue, or
 * a loop that stops early, changes the count rather than quietly measuring less.
 */
const TERMINAL_GEOMETRY_CHECKS: Readonly<Record<ViewportName, number>> = {
  mobile: THEME_FAMILIES.length,
  desktop: THEME_FAMILIES.length,
};

/**
 * WHICH VIEWPORT'S RUN OWES EACH PASS THAT OPENS ITS OWN CONTEXTS after the viewport loop. They pick
 * their own widths, so they are not split; each is owed in full by exactly one viewport, so a split run
 * owes it once between its two legs and an unsplit run owes all three. The safe-area and sessions-page
 * passes measure phones only; the session layout is mostly 1100–1920px desktops, so it is the desktop's.
 */
const PASS_OWNER = {
  sessionLayout: 'desktop',
  safeArea: 'mobile',
  sessionsPage: 'mobile',
} as const satisfies Record<string, ViewportName>;

/**
 * The closing line for a pass another viewport's run owes. It is still printed, with the owner named,
 * so the CI script can demand all five lines of every leg: a leg that skipped a pass it owed prints a
 * short tally and fails, and a leg that never reached the end prints neither line.
 */
const notOwedHere = (pass: string, owner: ViewportName): string =>
  `✅ ${pass} checks: 0/0 in ${SCHEME} at ${VIEWPORT_LABEL} — owed by the ${owner} run\n`;

/** The theme families the profile-scope frames are also captured in, beside the run's own scheme. */
const PROFILE_SCOPE_THEMES = ['blueprint-dark', 'phosphor-light', 'broadsheet-light'] as const;

/**
 * The Files evidence for handover #37 and #62, at whatever viewport is current.
 *
 * Its own function so `--files-only` can take it without walking the whole
 * gallery: these frames get re-taken every time the reload wording or the
 * notice layout moves, and a full pass is dozens of unrelated element shots
 * that each get their own chance to flake on a loaded machine.
 */
const captureFiles = async (page: Page, viewportName: string): Promise<void> => {
  const filesTarget = join(outDir, `files-${viewportName}.png`);
  await page.locator('#harness-files').scrollIntoViewIfNeeded();
  await captureElement(page, page.getByLabel('Files browser'), filesTarget);
  process.stdout.write(`📸 Files browser -> ${filesTarget}\n`);

  // The body behind ONE file tab (#35), not the picker: its own path in the
  // bar, its own raw/diff/Reload controls, its own bytes — plus the rich
  // preview and the two states a Reload can leave behind (#37/#62).
  //
  // The last two are DRIVEN, not drawn: their second read never settles and
  // fails respectively, so pressing Reload is what puts the surface in the
  // state being reviewed. Capturing before the press would show two ordinary
  // files and prove nothing.
  //
  // Explicit short timeouts, because the failure they guard is a WAIT. Each
  // driven path belongs to exactly one body (`main.tsx`); if that ever stops
  // being true the body never gets its first answer, the Reload control never
  // appears, and the default timeout would spend half a minute saying so. Five
  // seconds and a named locator is the difference between a deterministic
  // failure and a hung capture.
  await page.locator('#harness-file-instance').scrollIntoViewIfNeeded();
  for (const [slot, path] of [
    ['file-instance-reloading', 'RELEASE.md'],
    ['file-instance-reload-failed', 'DEPLOY.md'],
  ] as const) {
    const body = page.locator(`[data-harness="${slot}"]`);
    await body.scrollIntoViewIfNeeded();
    await body.getByLabel(`Reload ${path}`).click({ timeout: 5_000 });
    await body.locator('.kt-fs-stale:not(:empty)').first().waitFor({ state: 'visible', timeout: 5_000 });
  }
  // ONE BODY PER FRAME, at the real viewport. Four stacked bodies do not fit a
  // 390x844 phone, and borrowing a taller viewport to fit them would review a
  // layout no reader ever sees.
  for (const [slot, slug] of [
    ['file-instance-surface', 'file-instance'],
    ['file-instance-preview', 'file-preview'],
    ['file-instance-reloading', 'file-reloading'],
    ['file-instance-reload-failed', 'file-reload-failed'],
  ] as const) {
    const body = page.locator(`[data-harness="${slot}"]`);
    await body.scrollIntoViewIfNeeded();
    const target = join(outDir, `${slug}-${viewportName}.png`);
    await captureElement(page, body, target);
    process.stdout.write(`📸 File tab body ${slug} -> ${target}\n`);
  }

  // The failure compactly, then the SAME failure opened. A phone has no hover,
  // so this second frame is the evidence that a sighted touch reader can still
  // reach the whole sentence; the compact frame alone would only show a message
  // that stops mid-way.
  const failed = page.locator('[data-harness="file-instance-reload-failed"]');
  await failed.scrollIntoViewIfNeeded();
  await failed.locator('.kt-fs-stale-text').click({ timeout: 5_000 });
  await failed.locator('.kt-fs-stale-text[data-expanded="true"]').waitFor({ state: 'visible', timeout: 5_000 });
  const expandedTarget = join(outDir, `file-reload-expanded-${viewportName}.png`);
  await captureElement(page, failed, expandedTarget);
  process.stdout.write(`📸 File tab body file-reload-expanded -> ${expandedTarget}\n`);
};

/** Harness sections that live below the fold and are captured element by element. */
const SECTIONS = [
  'harness-new-session',
  'harness-session-screen',
  'harness-references',
  'harness-composer-markdown',
  'harness-lineage',
  'harness-marks',
  'harness-chat-width',
  'harness-dead-pane',
  'harness-fleet-sidebar',
  'harness-terminal-deck',
  'harness-surface-references',
  'harness-runtime-controls',
  'harness-pending-sends',
  'harness-skills',
  'harness-thinking-indicator',
  'harness-task-board',
  'harness-task-list-refs',
  // The install stage is deliberately absent: it is taller than a phone, and an
  // element capture inside this fixed gallery clips its top away. It gets a
  // page of its own below instead.
  // The entry question — what the reader HAS, which is the only thing this page
  // cannot detect — and the two questions the daemon subflow asks after it.
  'harness-onboarding-entry',
  'harness-onboarding-target',
  // The assumption stated with a way out, and the phone where the same screen
  // states a FACT instead, because the hardware answered the question.
  'harness-onboarding-doer',
  'harness-onboarding-doer-mobile',
  'harness-onboarding-brief',
  // The same prompt for an agent on another machine: a clipboard does not cross
  // devices, so this frame carries the share sheet and the page's own address.
  'harness-onboarding-brief-elsewhere',
  'harness-onboarding-agent-pair',
  // And that step without the "already open in another tab" line, which is true
  // only when the daemon is on the machine reading the page.
  'harness-onboarding-agent-pair-elsewhere',
  // The step that makes the daemon worth starting: Ferretry runs Claude Code and
  // Codex and is neither, so a daemon with both missing starts and can do nothing.
  'harness-onboarding-agents',
  'harness-onboarding-daemon',
  // The same-machine collapse, and the one screen that stands in for the whole
  // "another computer, by hand" branch — the same on a phone and on a computer.
  'harness-onboarding-local',
  'harness-onboarding-elsewhere',
  'harness-onboarding-elsewhere-mobile',
  'harness-onboarding-handoff',
  'harness-onboarding-scan',
  'harness-onboarding-pair',
  'harness-onboarding-done',
  // The two picker fields AT REST, and an unreadable roster beside a field that
  // still works. The OPEN list is captured on its own pages below instead: it is
  // an absolutely-positioned popover, and this gallery is a scroller.
  'harness-pickers',
  'harness-picker-failed',
  // The New session form's runtime buttons: one runtime, many, and none.
  'harness-new-session-one-runtime',
  'harness-new-session-many-runtimes',
  'harness-new-session-no-accounts',
] as const;

/**
 * The picker frames, each on a page of its own.
 *
 * Same reason as the Projects frames above, plus one of its own: the list
 * only exists while the field has FOCUS, and it paints outside the field's box.
 * Inside the gallery an element capture clips it and a full-page stitch repaints
 * the sticky app bar over it, so a page with no scrolling ancestor and no sticky
 * chrome is the only place a capture of an open list is the truth.
 */
const PICKER_FRAMES = ['account', 'account-checked', 'account-failed', 'project'] as const;

/** The touch floor the whole control family holds itself to, asserted rather than eyeballed. */
const TOUCH_TARGET_MINIMUM = 44;

/**
 * A software keyboard, told the truth.
 *
 * Chrome's `setViewportSize` (and CDP's visible-size) shrink the LAYOUT
 * viewport: `innerHeight` and `screen.height` move together and the page looks
 * like a short landscape device — which is the very misreading the portrait
 * gate was fixed for. An Android keyboard does something different: with
 * `interactive-widget=resizes-content` the screen stays a 390x844 portrait
 * phone and only `window.visualViewport` gets shorter.
 *
 * So the seam replaces `window.visualViewport` with a real EventTarget whose
 * height a harness setter can change, and dispatches the same `resize` the
 * browser would. The production producer (`useAppViewport`) listens to exactly
 * that, so the capture exercises the shipped code path rather than a mock of it.
 */
const VISUAL_VIEWPORT_SHIM = `(() => {
  const real = window.visualViewport;
  if (!real) throw new Error('this browser has no visualViewport to model a keyboard with');
  // WRAP, never replace: a substitute object breaks the driver's own pointer
  // coordinate maths once touch emulation is on, and every other reader of the
  // viewport would be reading a fake. Only 'height' is overridden, and only
  // while the harness says a keyboard is up.
  let override = null;
  const inherited = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(real), 'height');
  Object.defineProperty(real, 'height', {
    configurable: true,
    get: () => (override === null ? inherited.get.call(real) : override),
  });
  window.__harnessKeyboard = (nextHeight) => {
    override = nextHeight;
    real.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
  };
})();`;

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

/**
 * The full-screen browser frame's box, measured once its own transitions have finished.
 *
 * The harness runs under `prefers-reduced-motion: reduce`, and `styles/index.css` answers that with
 * `transition-duration: 1ms` on every element — while `transition-property` still defaults to `all`.
 * So the frame's move from the 520px pane to the full viewport is a real 1ms transition, and a
 * measurement that lands in the frame where it starts reads the OLD width (520 at a 1440 viewport) on a
 * loaded runner. `getAnimations()` flushes style first, so the transition is registered before this
 * waits on it; a frame that genuinely stays 520 wide still fails, it just fails after settling.
 */
async function measureFullBrowserFrame(exitBrowser: Locator) {
  return exitBrowser.evaluate(async button => {
    const frame = button.closest('aside')?.parentElement;
    await Promise.all((frame?.getAnimations() ?? []).map(animation => animation.finished.catch(() => undefined)));
    const box = frame?.getBoundingClientRect();
    return {
      fixed: frame === null || frame === undefined ? false : getComputedStyle(frame).position === 'fixed',
      width: box === undefined ? null : Math.round(box.width),
      height: box === undefined ? null : Math.round(box.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

/**
 * THE PAGE BODY MUST NEVER SCROLL SIDEWAYS, checked rather than eyeballed.
 *
 * This is the failure that a screenshot is worst at showing: a capture is clipped to the viewport, so a
 * panel whose widest value pushes the document 40px past the right edge looks completely fine in the
 * PNG. What gives it away on a real phone is that the whole app slides under your thumb.
 *
 * `Settings` owns its own scrollport (`data-settings-scroller`), so BOTH are asserted: the document, and
 * that scroller. A long path or identifier is allowed to scroll inside its own box — that is exactly what
 * `PanelPath` is for — and this is what keeps that promise honest, because a box that forgot its
 * `max-w-full` widens its ancestors instead of scrolling.
 *
 * One pixel of slack: sub-pixel layout rounding at fractional device ratios can leave `scrollWidth` a
 * hair over `clientWidth` on an element that does not actually scroll.
 *
 * EVERY CHECK ANNOUNCES ITSELF, PASS INCLUDED, and they are counted. This is a CI gate now, and the
 * way a gate like this dies is not a false red — it is a refactor that stops the checks running while
 * the job stays green, which reads exactly like "nothing was wrong". A silent pass is
 * indistinguishable from a check that was never reached, so the run ends by asserting the tally
 * against `SETTINGS_SIDEWAYS_CHECKS` and the CI script requires that closing line to be present.
 */
let sidewaysChecks = 0;

/**
 * THE TWO PAIRING FAILURES WHOSE SENTENCE IS THE REMEDY — the machine is older, or this browser cannot
 * make the key — pressed into their failed state and captured in both themes, each checked for fit and
 * margins first. Their codes are the harness's fixed fake one, never a real code.
 */
const capturePairingFailures = async (page: Page, viewportName: string): Promise<void> => {
  for (const [label, slug] of [
    ['Pairing failed — machine is older', 'pairing-failed-older-machine'],
    ['Pairing failed — app is older', 'pairing-failed-older-app'],
    ['Pairing failed — browser cannot make the key', 'pairing-failed-no-device-key'],
  ] as const) {
    const card = page.getByLabel(label, { exact: true });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: 'Pair this device' }).click();
    await card.locator('[data-pairing-failure="stated"]').waitFor();
    await assertCardFitsWithMargins(card, `${label} at ${viewportName}`);
    for (const theme of ['studio-dark', 'studio-light'] as const) {
      await applyTheme(page, theme);
      const target = join(outDir, `${slug}${theme === 'studio-light' ? '-light' : ''}-${viewportName}.png`);
      await captureElement(page, card, target);
      process.stdout.write(`📸 ${label} ${theme} ${viewportName} -> ${target}\n`);
    }
    await applyTheme(page, 'studio-dark');
  }
  // The notice a refused device sees in place of the page: no button to press, the same fit rule.
  const refused = page.getByLabel('Machine no longer accepts this browser', { exact: true });
  await refused.scrollIntoViewIfNeeded();
  const sideways = await refused.evaluate(element =>
    [element, ...element.querySelectorAll<HTMLElement>('*')].some(node => node.scrollWidth > node.clientWidth + 1),
  );
  if (sideways) throw new Error(`the refused-device notice scrolls sideways at ${viewportName}`);
  for (const theme of ['studio-dark', 'studio-light'] as const) {
    await applyTheme(page, theme);
    const target = join(outDir, `device-refused${theme === 'studio-light' ? '-light' : ''}-${viewportName}.png`);
    await captureElement(page, refused, target);
    process.stdout.write(`📸 device refused ${theme} ${viewportName} -> ${target}\n`);
  }
  await applyTheme(page, 'studio-dark');
};

/**
 * SIGNING IN TO A REMOTE MCP SERVER (docs/mcp-oauth.md): the real Components tab on an `auth: oauth`
 * server — needing a sign-in, signed in, its sheet coming back by itself, and its sheet the paste way with
 * the daemon's refusal on screen — then the static callback page in its three states.
 *
 * The callback page is served with the site's WHOLE app-wide policy, `script-src 'self'` included, so a
 * capture of its words is also proof its one same-origin script ran. "Done" is answered by a second page
 * in the same context listening on the channel, exactly as a Ferretry tab in the same browser would.
 *
 * A narrow mode, so it owes no Settings tally; its own sideways check runs on every frame instead.
 */
/**
 * Info › Context › MCP and Skills, and the Components page's MCP rows: every scope a ferret reads, a
 * Check that connected, one that needs a sign-in, a project server nobody approved, a SKILL.md opened,
 * and a machine that cannot be reached said in plain words. A narrow mode with its own sideways check.
 */
const captureContextTools = async (page: Page, viewportName: string): Promise<void> => {
  const shot = async (name: string): Promise<void> => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`context tools ${name} scrolls sideways by ${wide}px at ${viewportName}`);
    const target = join(outDir, `context-tools-${name}-${viewportName}-${SCHEME}.png`);
    await page.screenshot({ path: target, animations: 'disabled', fullPage: true });
    process.stdout.write(`📸 context tools ${name} ${viewportName} ${SCHEME} -> ${target}\n`);
  };
  const frame = async (name: string, ready: string): Promise<void> => {
    await page.goto(`${server.url}?context-tools=${name}`);
    await page.locator(ready).first().waitFor({ state: 'visible' });
  };

  await frame('mcp', '[data-mcp-row="docs"]');
  await page.locator('[data-mcp-check="docs"]').click();
  await page.locator('[data-mcp-sign-in="docs"]').waitFor({ state: 'visible' });
  await page.locator('[data-mcp-check="github"]').click();
  await page.locator('[data-mcp-row="github"] [data-mcp-tools]').waitFor({ state: 'visible' });
  await page.locator('[data-mcp-check="lint"]').click();
  await page.locator('[data-mcp-row="lint"] [data-mcp-status]').filter({ hasText: 'Not approved' }).waitFor();
  await shot('mcp');
  await page.locator('[data-mcp-sign-in="docs"]').click();
  await page.locator('[data-mcp-failure="sign-in"]').waitFor({ state: 'visible' });
  await page.locator('[data-mcp-failure="sign-in"] details summary').click();
  await page.locator('[data-mcp-check="scratch"]').click();
  await page.locator('[data-mcp-row="scratch"] [data-mcp-failure="check"] details summary').click();
  await shot('mcp-failures');

  await frame('skills', '[data-context-skill]');
  await shot('skills');
  await page.locator('[data-context-skill-open="release"]').click();
  await page.locator('[data-context-skill-file="release"] h1').waitFor({ state: 'visible' });
  await shot('skill-open');

  await frame('unreachable', '[data-context-failed]');
  await page.locator('[data-context-failed-details] summary').click();
  await shot('unreachable');

  await frame('components-mcp', '[data-component-kind="mcp"]');
  await page.locator('[data-component-kind="mcp"]').click();
  await page.locator('[data-mcp-check="github"]').click();
  await page.locator('[data-mcp-row="github"] [data-mcp-tools]').waitFor({ state: 'visible' });
  await shot('components-mcp');
};

const captureMcpSignIn = async (page: Page, viewportName: string): Promise<void> => {
  const noSideways = async (where: string): Promise<void> => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`${where} scrolls sideways by ${wide}px at ${viewportName}`);
  };
  const shot = async (name: string): Promise<void> => {
    await noSideways(`mcp ${name}`);
    const target = join(outDir, `mcp-${name}-${viewportName}.png`);
    await page.screenshot({ path: target, animations: 'disabled' });
    process.stdout.write(`📸 MCP sign-in ${name} ${viewportName} -> ${target}\n`);
  };
  const frame = async (name: string): Promise<void> => {
    await page.goto(`${server.url}?mcp-sign-in=${name}`);
    await page.locator('[data-mcp-sign-in-status]').waitFor({ state: 'visible' });
  };

  await frame('needs-sign-in');
  await shot('needs-sign-in');
  await frame('signed-in');
  await page.locator('[data-mcp-sign-in-secrets]').waitFor({ state: 'visible' });
  await shot('signed-in');

  await frame('sheet-pwa');
  await page.locator('[data-catalog-section="mcp-sign-in"] [data-change-submit]').click();
  await page.locator('[data-mcp-sign-in="waiting"][data-mcp-sign-in-mode="pwa"]').waitFor({ state: 'visible' });
  await shot('sheet-pwa');
  await page.locator('[data-mcp-sign-in-paste-disclosure] summary').click();
  await page.locator('textarea[name="mcp-sign-in-address"]').waitFor({ state: 'visible' });
  await shot('sheet-pwa-paste-open');

  await frame('sheet-paste');
  await page.locator('[data-catalog-section="mcp-sign-in"] [data-change-submit]').click();
  await page.locator('[data-mcp-sign-in-use-paste]').click();
  await page.locator('[data-mcp-sign-in-mode="paste"]').waitFor({ state: 'visible' });
  await page
    .locator('textarea[name="mcp-sign-in-address"]')
    .fill('http://localhost:51234/callback?code=harness-preview&state=harness-stale');
  await page.locator('[data-mcp-sign-in-paste] button[type="submit"]').click();
  await page.locator('[data-mcp-sign-in-refusal]').waitFor({ state: 'visible' });
  if ((await page.locator('textarea[name="mcp-sign-in-address"]').inputValue()) !== '')
    fail('the MCP sign-in sheet kept a pasted address after sending it');
  await shot('sheet-paste-refused');

  const callback = `${server.url}oauth/mcp-callback/0123456789abcdef?code=harness-preview&state=harness-preview`;
  await page.goto(callback);
  await page.locator('#callback[data-state="waiting"]').waitFor({ state: 'attached' });
  await shot('callback-waiting');
  await page.locator('#callback[data-state="fallback"]').waitFor({ state: 'visible', timeout: 10_000 });
  await shot('callback-fallback');

  const ferretryTab = await page.context().newPage();
  try {
    await ferretryTab.goto(`${server.url}oauth/mcp-callback/0123456789abcdef`);
    await ferretryTab.evaluate(() => {
      const channel = new BroadcastChannel('ferretry-mcp-oauth');
      channel.onmessage = event => {
        const data = event.data as { type?: string; id?: string };
        if (data.type !== 'callback' || data.id === undefined) return;
        channel.postMessage({ type: 'received', id: data.id });
        channel.postMessage({ type: 'finished', id: data.id, ok: true });
      };
    });
    await page.goto(callback);
    await page.locator('#callback[data-state="done"]').waitFor({ state: 'visible' });
    if (new URL(page.url()).search !== '') fail('the MCP callback page kept its code after Ferretry took it');
    await shot('callback-done');
  } finally {
    await ferretryTab.close();
  }
};

/**
 * SETTINGS › MACHINE › ABOUT, in its three states (`docs/updating.md`): an update available on a
 * Homebrew install with two ferrets mid-turn (the "they keep running" line and Update when idle), the
 * update running once Update is pressed, and the manual steps a deb install shows instead. The harness
 * daemon answers all three in the page (`?about=manual` picks the deb).
 *
 * A narrow mode, so it owes no Settings tally; its own sideways check runs on every frame instead, and
 * the About panel's geometry in the gated walk is the `about` row of the daemon-panel loop.
 */
const captureAbout = async (page: Page, viewportName: string): Promise<void> => {
  const shot = async (name: string): Promise<void> => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`about ${name} scrolls sideways by ${wide}px at ${viewportName}`);
    const target = join(outDir, `about-${name}-${SCHEME}-${viewportName}.png`);
    await page.screenshot({ path: target, animations: 'disabled' });
    process.stdout.write(`📸 about ${name} ${SCHEME} ${viewportName} -> ${target}\n`);
  };
  for (const state of ['available', 'manual'] as const) {
    const url = new URL(server.url);
    url.searchParams.set('settings-harness', '1');
    if (state === 'manual') url.searchParams.set('about', 'manual');
    await page.goto(url.toString());
    const settings = page.getByLabel('Settings page preview', { exact: true });
    const navigation = settings.locator(viewportName === 'mobile' ? '[data-settings-home]' : '[data-settings-sidebar]');
    await navigation.locator('[data-settings-machine="harness-daemon"]').click();
    const surface = settings.locator('[data-machines-surface="harness-daemon"]');
    await surface.locator('[data-machine-tab="machine"]').click();
    const frame = settings.locator('[data-daemon-settings-frame="harness-daemon"]');
    await frame.locator('[data-daemon-panel="about"]').click();
    const heading = frame.locator('#about-machine-heading');
    await heading.waitFor({ state: 'visible' });
    await heading.scrollIntoViewIfNeeded();
    await settleTransitions(page);
    await shot(state);
    if (state === 'available') {
      const note = frame.locator('[data-about-mid-turn]');
      await note.waitFor({ state: 'visible' });
      await frame.locator('[data-about-update]').click();
      const running = frame.locator('[data-about-job]');
      await running.waitFor({ state: 'visible' });
      await running.scrollIntoViewIfNeeded();
      await settleTransitions(page);
      await shot('updating');
    }
  }
};

/**
 * SETTINGS › MACHINE › AGENT CLIs, for every install method (`docs/updating.md`): the harness daemon
 * answers `?agent-clis=npm|nix|native` in the page (`harness/main.tsx`). Each harness card is captured
 * in view, and in the npm state Codex's Update is pressed so the "not yet verified" question is on screen.
 *
 * A narrow mode, so it owes no Settings tally; its own sideways check runs on every frame instead, and
 * the panel's geometry in the gated walk is the `agent-clis` row of the daemon-panel loop.
 */
const captureAgentClis = async (page: Page, viewportName: string): Promise<void> => {
  const shot = async (name: string): Promise<void> => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`agent CLIs ${name} scrolls sideways by ${wide}px at ${viewportName}`);
    const target = join(outDir, `agent-clis-${name}-${SCHEME}-${viewportName}.png`);
    await page.screenshot({ path: target, animations: 'disabled' });
    process.stdout.write(`📸 agent CLIs ${name} ${SCHEME} ${viewportName} -> ${target}\n`);
  };
  for (const state of ['npm', 'nix', 'native'] as const) {
    const url = new URL(server.url);
    url.searchParams.set('settings-harness', '1');
    url.searchParams.set('agent-clis', state);
    await page.goto(url.toString());
    const settings = page.getByLabel('Settings page preview', { exact: true });
    const navigation = settings.locator(viewportName === 'mobile' ? '[data-settings-home]' : '[data-settings-sidebar]');
    await navigation.locator('[data-settings-machine="harness-daemon"]').click();
    const surface = settings.locator('[data-machines-surface="harness-daemon"]');
    await surface.locator('[data-machine-tab="machine"]').click();
    const frame = settings.locator('[data-daemon-settings-frame="harness-daemon"]');
    await frame.locator('[data-daemon-panel="agent-clis"]').click();
    await frame.locator('#agent-clis-heading').waitFor({ state: 'visible' });
    for (const harness of ['claude', 'codex'] as const) {
      const card = frame.locator(`[data-agent-cli="${harness}"]`);
      await card.scrollIntoViewIfNeeded();
      await settleTransitions(page);
      await shot(`${state}-${harness}`);
    }
    if (state === 'npm') {
      await frame.locator('[data-agent-cli-update="codex:newest"]').click();
      const confirm = frame.locator('[data-agent-cli-confirm="codex"]');
      await confirm.waitFor({ state: 'visible' });
      await confirm.scrollIntoViewIfNeeded();
      await shot('npm-unverified-confirm');
    }
  }
};
/**
 * "Pair a phone" from the machine menu (`?pair-from-menu`, `harness/pair-from-menu.tsx`): the journey a
 * reader takes, driven rather than posed — open the machine menu, choose "Pair a phone with studio…",
 * mint a code, see the QR, and Escape back to the switcher.
 *
 * THE CODE ON SCREEN MUST BE THE FIXED FAKE. A capture of anything else would be a real credential in a
 * PNG, so the run fails rather than write one (`docs/pairing.md`).
 *
 * A narrow mode, so it owes no Settings tally; its own sideways check runs on every frame instead.
 */
const PAIR_FROM_MENU_FAKE_CODE = '7F3K-Q2ND';
const capturePairFromMenu = async (page: Page, viewportName: string): Promise<void> => {
  const shot = async (name: string): Promise<void> => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`pair-from-menu ${name} scrolls sideways by ${wide}px at ${viewportName}`);
    const target = join(outDir, `pair-from-menu-${name}-${SCHEME}-${viewportName}.png`);
    await page.screenshot({ path: target, animations: 'disabled' });
    process.stdout.write(`📸 pair from menu ${name} ${SCHEME} ${viewportName} -> ${target}\n`);
  };
  await page.goto(`${server.url}?pair-from-menu`);
  const machine = page.locator('[data-sbar-machine]').first();
  await machine.waitFor({ state: 'visible' });
  await machine.click();
  const menu = page.getByRole('menu', { name: 'Switch machine' });
  await menu.waitFor({ state: 'visible' });
  const labels = (await menu.getByRole('menuitem').allTextContents()).map(label => label.trim());
  const expected = ['studiothis one', 'laptop', 'Pair a phone with studio…', 'Add a machine…'];
  if (JSON.stringify(labels) !== JSON.stringify(expected))
    fail(`the machine menu reads ${JSON.stringify(labels)}, expected ${JSON.stringify(expected)}`);
  if ((await menu.locator('[data-menu-separator]').count()) !== 1) fail('the machine menu has no single divider');
  if (viewportName === 'mobile') {
    const short = await menu
      .getByRole('menuitem')
      .evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height).filter(height => height < 44));
    if (short.length > 0) fail(`machine menu rows under the 44px touch floor on a phone: ${short.join(', ')}`);
  }
  await shot('menu');

  await menu.getByRole('menuitem', { name: 'Pair a phone with studio…' }).click();
  const body = page.locator('[data-pair-phone-body]');
  await body.locator('[data-pair-mint]').waitFor({ state: 'visible' });
  await shot('sheet');

  await body.locator('[data-pair-mint]').click();
  await body.locator('[data-pair-qr]').waitFor({ state: 'visible' });
  if (!(await body.innerText()).includes(PAIR_FROM_MENU_FAKE_CODE))
    fail('the pairing sheet is not showing the fixed fake code, so it will not be captured');
  await shot('qr');

  await page.keyboard.press('Escape');
  await page.locator('[data-pair-phone-body]').waitFor({ state: 'detached' });
  const focusedSwitcher = await page.evaluate(() => document.activeElement?.hasAttribute('data-sbar-machine') === true);
  if (!focusedSwitcher)
    fail(`closing the pairing sheet did not return focus to the machine switcher at ${viewportName}`);
};

/**
 * "What's new" (`?whats-new`, `harness/whats-new.tsx`): the newest releases with their "New" chips, then
 * the older ones after "Show older versions". Fails if the chips or the grouping are not what the fixed
 * changelog says, if a row scrolls sideways, or if the sheet is not a sheet on a phone and a dialog elsewhere.
 */
const captureWhatsNew = async (page: Page, viewportName: string): Promise<void> => {
  const shot = async (name: string): Promise<void> => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`whats-new ${name} scrolls sideways by ${wide}px at ${viewportName}`);
    const target = join(outDir, `whats-new-${name}-${SCHEME}-${viewportName}.png`);
    await page.screenshot({ path: target, animations: 'disabled' });
    process.stdout.write(`📸 whats new ${name} ${SCHEME} ${viewportName} -> ${target}\n`);
  };
  await page.goto(`${server.url}?whats-new`);
  const body = page.locator('[data-whats-new-body]');
  await body.waitFor({ state: 'visible' });
  const frame = viewportName === 'mobile' ? 'sheet' : 'dialog';
  if ((await page.locator(`[data-whats-new="${frame}"]`).count()) !== 1)
    fail(`what's new is not a ${frame} at ${viewportName}`);
  const chips = await body.locator('[data-whats-new-new]').count();
  if (chips !== 2) fail(`expected 2 "New" chips, saw ${chips} at ${viewportName}`);
  const first = (await body.locator('h3').first().textContent())?.trim();
  if (first !== '4.93.0') fail(`the newest release is not first: ${first ?? 'none'}`);
  await shot('top');

  await body.locator('[data-whats-new-older]').scrollIntoViewIfNeeded();
  await shot('end');
  await body.locator('[data-whats-new-older]').click();
  if ((await body.locator('[data-whats-new-release]').count()) <= 12) fail('"Show older versions" showed nothing more');
  await page.keyboard.press('Escape');
  await body.waitFor({ state: 'detached' });
};

/**
 * The sessions bar's row menu (`?session-context-menu`, `harness/session-context-menu.tsx`), driven the way a
 * reader does it: a right-click on a parent row on a desktop (a menu at the pointer, inside the viewport,
 * the same Actions as the header), a held finger on a phone (a bottom sheet of 44px rows). Both are walked
 * through Escape and the inline Stop confirmation, and a sub-ferret row's menu is captured too.
 */
const captureSessionContextMenu = async (page: Page, viewportName: string): Promise<void> => {
  const shot = async (name: string): Promise<void> => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) fail(`session-context-menu ${name} scrolls sideways by ${wide}px at ${viewportName}`);
    const target = join(outDir, `session-context-menu-${name}-${SCHEME}-${viewportName}.png`);
    await page.screenshot({ path: target, animations: 'disabled' });
    process.stdout.write(`📸 session context menu ${name} ${SCHEME} ${viewportName} -> ${target}\n`);
  };
  await page.goto(`${server.url}?session-context-menu`);
  const parent = page.locator('[data-sbar-session="hadi"]');
  await parent.waitFor({ state: 'visible' });
  const phone = viewportName === 'mobile';
  const openMenu = async (id: string): Promise<void> => {
    const target = page.locator(`[data-sbar-session="${id}"]`);
    if (!phone) {
      await target.click({ button: 'right' });
    } else {
      const box = await target.boundingBox();
      if (box === null) fail(`no box for ${id}`);
      const client = await page.context().newCDPSession(page);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.waitForTimeout(700);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await page.getByRole('menu', { name: /actions$/u }).waitFor({ state: 'visible' });
  };
  await openMenu('hadi');
  const menu = page.getByRole('menu', { name: 'Hadi actions' });
  const labels = (await menu.getByRole('menuitem').allTextContents()).map(label => label.trim());
  for (const wanted of ['Open', 'Rename…', 'Restart CLI', 'Stop ferret…'])
    if (!labels.some(label => label.startsWith(wanted))) fail(`the row menu has no "${wanted}": ${labels.join(' | ')}`);
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) fail('no menu box');
  else if (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1)
    fail(`the row menu leaves the viewport: ${JSON.stringify(box)}`);
  if (phone) {
    const short = await menu
      .getByRole('menuitem')
      .evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height).filter(height => height < 44));
    if (short.length > 0) fail(`row-menu rows under the 44px touch floor on a phone: ${short.join(', ')}`);
  }
  await shot('menu');

  await menu.getByRole('menuitem', { name: /^Stop ferret/u }).click();
  await page.locator('[data-menu-confirm]').waitFor({ state: 'visible' });
  await shot('confirm');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: /actions$/u }).waitFor({ state: 'detached' });

  await openMenu('hadi-a');
  await page.getByRole('menu', { name: /actions$/u }).waitFor({ state: 'visible' });
  await shot('sub-ferret');
};

/**
 * One card fits its column and keeps its words off its edges.
 *
 * For the pairing failures, whose whole job is one sentence: the card may not be wider than the space
 * it was given, nothing in it may scroll sideways, and the failure sentence must sit at least 12px in
 * from every edge of the card — a sentence flush against a border reads as clipped even when it is not.
 */
const assertCardFitsWithMargins = async (card: Locator, where: string): Promise<void> => {
  const problems = await card.evaluate(element => {
    const found: string[] = [];
    const box = element.getBoundingClientRect();
    const parent = element.parentElement?.getBoundingClientRect();
    if (parent !== undefined && box.width > parent.width + 1) found.push(`card ${box.width}px in ${parent.width}px`);
    for (const node of [element, ...element.querySelectorAll<HTMLElement>('*')])
      if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== 'visible')
        found.push(`${node.tagName.toLowerCase()} scrolls sideways (${node.scrollWidth}px in ${node.clientWidth}px)`);
    const sentence = element.querySelector('[data-pairing-failure]')?.getBoundingClientRect();
    if (sentence === undefined) found.push('no failure sentence');
    else {
      const insets = { left: sentence.left - box.left, right: box.right - sentence.right, top: sentence.top - box.top };
      for (const [side, inset] of Object.entries(insets))
        if (inset < 12) found.push(`sentence ${inset}px from the ${side} edge`);
    }
    return found;
  });
  if (problems.length > 0) throw new Error(`${where}: ${problems.join('; ')}`);
  process.stdout.write(`🧭 fits with margins: ${where}\n`);
};

/**
 * A runtime's Rename or Remove dialog fits the screen: inside the viewport with a gutter on each side,
 * never taller than it, and its confirm button wholly in view — on a phone that is the bottom sheet's
 * thumb-reach promise, and a button below the fold is a dialog nobody can finish.
 */
const assertRuntimeDialogGeometry = async (page: Page, where: string): Promise<void> => {
  const problems = await page.evaluate(() => {
    const found: string[] = [];
    const dialog = document.querySelector('[data-runtime-dialog]');
    const submit = [...document.querySelectorAll('[data-runtime-dialog] [data-change-submit]')].at(-1);
    if (dialog === null || submit === undefined) return ['no dialog with a confirm button is open'];
    const box = dialog.getBoundingClientRect();
    if (box.left < 8) found.push(`dialog ${Math.round(box.left)}px from the left edge`);
    if (window.innerWidth - box.right < 8)
      found.push(`dialog ${Math.round(window.innerWidth - box.right)}px from the right edge`);
    if (box.top < 0 || box.bottom > window.innerHeight) found.push('dialog runs past the top or bottom of the screen');
    const button = submit.getBoundingClientRect();
    if (button.top < 0 || button.bottom > window.innerHeight || button.left < 0 || button.right > window.innerWidth)
      found.push('confirm button is not wholly in view');
    if (submit.scrollWidth > submit.clientWidth + 1)
      found.push(`confirm button label is cut off: "${submit.textContent}"`);
    return found;
  });
  if (problems.length > 0) throw new Error(`${where}: ${problems.join('; ')}`);
  process.stdout.write(`🧭 dialog fits: ${where}\n`);
};

const assertNoSidewaysScroll = async (page: Page, where: string): Promise<void> => {
  const overflow = await page.evaluate(() => {
    /**
     * The elements actually sticking out, named — because a width alone is not a repair.
     *
     * "402px of content in a 390px box" says a regression exists and leaves finding it to whoever
     * reads the log, and the reader of a CI log is usually not at a machine that reproduces it. Text
     * metrics differ between a developer's font set and a runner's, so a 12px overflow can be real on
     * CI and absent locally — which makes "which element" the only part of the message that travels.
     *
     * Only LEAF offenders are reported. Every ancestor of a too-wide element is also too wide, so
     * sorting by width would name the page, the section and the card before the one node to fix;
     * dropping any offender that contains another leaves the culprits.
     */
    const describe = (element: Element): string => {
      const classes =
        typeof element.className === 'string' && element.className.trim() !== ''
          ? `.${element.className.trim().split(/\s+/).slice(0, 5).join('.')}`
          : '';
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
      return (
        `${element.tagName.toLowerCase()}${element.id === '' ? '' : `#${element.id}`}${classes}` +
        `${text === '' ? '' : ` "${text}"`}`
      );
    };
    const culprits = (box: Element): readonly string[] => {
      const limit = box.getBoundingClientRect().left + box.clientWidth + 1;
      /**
       * TWO WAYS TO STICK OUT, and only checking the obvious one reports nothing on the common case.
       *
       * A too-wide ELEMENT has a rect past the limit — a fixed width, a min-width, an unshrinkable flex
       * child. But unbreakable TEXT does not move its own block's box: a `<li>` stays exactly as wide as
       * its container while a 44-character `PATH` paints straight past it, so a rect comparison finds
       * nothing and the honest-looking conclusion is "the box is sized wrong". It is not — it is holding
       * content it never agreed to clip. That case is a box whose own `scrollWidth` exceeds its
       * `clientWidth` while its `overflow-x` is `visible`, which is precisely "leaking into my
       * ancestors" as opposed to "scrolling in my own box", the latter being what `PanelPath` does on
       * purpose and must not be reported.
       */
      const offenders = [...box.querySelectorAll('*')].filter(element => {
        if (element.getBoundingClientRect().right > limit) return true;
        return element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible';
      });
      return offenders
        .filter(element => !offenders.some(other => other !== element && element.contains(other)))
        .slice(0, 4)
        .map(
          element =>
            `${describe(element)} — ${element.scrollWidth}px of content in a ${element.clientWidth}px box, ` +
            `right edge ${element.getBoundingClientRect().right.toFixed(1)}px`,
        );
    };
    const boxes = [
      { name: 'document', element: document.documentElement as Element },
      ...[...document.querySelectorAll('[data-settings-scroller]')].map(element => ({
        name: 'settings scroller',
        element,
      })),
    ];
    return boxes
      .filter(box => box.element.scrollWidth > box.element.clientWidth + 1)
      .map(box => ({
        name: box.name,
        scroll: box.element.scrollWidth,
        client: box.element.clientWidth,
        culprits: culprits(box.element),
      }));
  });
  for (const box of overflow)
    fail(
      `${where}: the ${box.name} scrolls sideways — ${box.scroll}px of content in a ${box.client}px box\n` +
        (box.culprits.length === 0
          ? '   no descendant sticks out, so the box itself is sized wrong rather than holding something too wide'
          : box.culprits.map(culprit => `   sticking out: ${culprit}`).join('\n')),
    );
  sidewaysChecks += 1;
  process.stdout.write(`🧭 no sideways scroll: ${where}\n`);
};

/**
 * THE MACHINES SECTION HAS ONE LEFT EDGE, and the tab bar fits, checked rather than eyeballed.
 *
 * "Be careful of margins" was the owner's ask, and the defect it named is one a sideways-scroll check
 * cannot see: the section heading, its sentence and the machine switcher sat 4px right of the tab bar
 * and every card under it, because two stray `px-1`s indented text that nothing else was indented by.
 * Every box still fitted the phone, so every gate was green. So this reads where things START.
 *
 * WHAT "STARTS" MEANS. A card — anything that paints its own border or background — starts at its
 * border box, because that edge is what the eye lines up. Anything else starts where its CONTENT does
 * (border box plus padding), because an unpainted box is invisible and only its text is seen: that is
 * exactly how a `px-1` header hid its indent. The section's own left edge is the reference.
 *
 * WHICH THINGS. The outermost visible thing on each line: walking down from the section, a card, a
 * control, a list, a heading, a paragraph or a bare run of text is collected and not descended into —
 * a card's inside belongs to its own padding, which is asserted separately. A collected thing that is
 * not at the edge is allowed only if something else on the same line sits to its left (a Close button
 * beside a heading, a label beside its icon). Anything left of the edge, right of the section's right
 * edge, or indented with nothing beside it is a failure, named.
 *
 * AND BETWEEN THEM: every top-level panel card is padded by `--pad-panel`, and a card or a control
 * stacked under another top-level thing is at least `--gap-xs` from it — nothing flush. Text under text
 * is left to its line height, which is the type scale's business rather than a margin.
 *
 * THE TAB BAR, while it is shown: no label wider than its button, the label inside the button's padding,
 * adjacent tabs at least `--gap-xs` apart, every tab inside the row, the row not scrolling, exactly one
 * tab marked current, and — hovered — an unselected tab still not painted like the selected one. That
 * last one is the double-active tab U19 shipped a capture of.
 *
 * Transitions are FINISHED first, which is also what the captures do (`animations: 'disabled'`): a tab
 * mid-fade is a timing artefact of the capture, measured, not a layout — `transition-colors` holds the
 * tab just left in its selected colours for 150ms, and a capture taken in that window shows two
 * selected tabs. Settled is the state a person looks at.
 *
 * Counted and asserted like the sideways checks, against `MACHINES_GEOMETRY_CHECKS`.
 */
let machinesGeometryChecks = 0;

/**
 * A TERMINAL DRAWS ITS TEXT ONE CELL PER CHARACTER — measured, in every theme family.
 *
 * The defect this exists for shipped in screenshots: `$ bun dev` drawn as `$  b u n  d e v`. xterm
 * sizes a cell from one `W` and pads every glyph to it, so a proportional face (what `monospace`
 * resolves to on a host with no monospace font installed) or tracking inherited from a theme spreads
 * every narrow letter across a wide cell. Nothing but a real browser rendering a real emulator can see
 * that, so it is measured here rather than asserted on markup:
 *
 *   - the terminal's resolved face is MONOSPACE: `iiiiiiiiii` and `WWWWWWWWWW` set in it are the same
 *     width — a proportional face fails by roughly half;
 *   - a rendered row of N characters spans N cells: its width is N × the face's own advance, within half
 *     a pixel a character — padding added between glyphs fails by the padding;
 *   - nothing typographic leaks into the emulator: no letter or word spacing, no text transform.
 *
 * Counted against `TERMINAL_GEOMETRY_CHECKS`.
 */
let terminalGeometryChecks = 0;

const assertTerminalGeometry = async (page: Page, rootUrl: string, family: string, where: string): Promise<void> => {
  await page.evaluate(
    ([id, scheme]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family: id, mode: scheme })),
    [family, SCHEME] as const,
  );
  // A query per family, so every family is a full load: `pre-paint.js` resolves the theme only then,
  // and a hash-only change to the same URL would keep the previous family on screen.
  await page.goto(`${rootUrl}?split&family=${family}#session-workspace`);
  await page.locator('#harness-session-workspace-page').waitFor({ state: 'visible' });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== `${family}-${SCHEME}`)
    fail(`the terminal geometry pass asked for ${family}-${SCHEME} and got ${theme}`);
  // The `dev` shell `?split` puts on screen. The harness's second shell paints the same output into a
  // hidden panel, and a row there has text but no layout, so it would measure as zero wide.
  const row = page.locator('[data-workspace-terminal="a1b2c3d4e5f6"] .xterm-rows > div', {
    hasText: 'GET /login 200 18ms',
  });
  // A phone shows one tab at a time; the terminal is a chip away from the Chat it opens on.
  if (!(await row.first().isVisible())) await page.getByRole('tab', { name: /^dev/u }).first().click();
  await row.first().waitFor({ state: 'visible' });
  // Settled before measuring: the face finishes loading and xterm redraws its rows once more after it
  // re-measures. Fonts being ready is not enough. xterm sets `.xterm-rows` letter-spacing to its cell
  // width minus the width of a "W", so rows drawn before it has measured a cell carry a letter-spacing
  // of minus one glyph and collapse every character onto the first. That transient frame failed CI as
  // "spans 0.015625px", in a random family each time. So wait until the cell xterm drew with — that "W"
  // plus the rows' letter-spacing — is a real width, unchanged for three frames. This reads xterm's own
  // cell and never the text's spread, so a row that IS spread, or stays collapsed, is still measured
  // below and still fails.
  await row.first().evaluate(async element => {
    await document.fonts.ready;
    const rows = element.parentElement as HTMLElement;
    const cell = (): number => {
      const style = getComputedStyle(rows);
      const span = document.createElement('span');
      span.style.cssText = `font-family:${style.fontFamily};font-size:${style.fontSize};letter-spacing:0;white-space:pre;position:absolute;visibility:hidden`;
      span.textContent = 'W';
      rows.append(span);
      const glyph = span.getBoundingClientRect().width;
      span.remove();
      return glyph + (Number.parseFloat(style.letterSpacing) || 0);
    };
    const deadline = performance.now() + 5000;
    let last = Number.NaN;
    let still = 0;
    while (performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const now = cell();
      still = now > 0.5 && now === last ? still + 1 : 0;
      last = now;
      if (still >= 3) return;
    }
  });
  const measured = await row.first().evaluate(element => {
    const rows = element.parentElement as HTMLElement;
    const style = getComputedStyle(rows);
    const probe = (text: string): number => {
      const span = document.createElement('span');
      span.style.cssText = `font-family:${style.fontFamily};font-size:${style.fontSize};letter-spacing:0;white-space:pre;position:absolute;visibility:hidden`;
      span.textContent = text;
      rows.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    const text = (element.textContent ?? '').trimEnd();
    // From the row's first character to its last visible one, whatever spans or bare text nodes xterm
    // drew them in — trailing blank cells are not part of the text being measured.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
    const last = nodes.findLast(node => (node.textContent ?? '').trim() !== '');
    const range = document.createRange();
    if (nodes[0] !== undefined && last !== undefined) {
      range.setStart(nodes[0], 0);
      range.setEnd(last, (last.textContent ?? '').trimEnd().length);
    }
    const host = rows.closest('.xterm') as HTMLElement;
    const hostStyle = getComputedStyle(host);
    return {
      text,
      family: style.fontFamily,
      narrow: probe('iiiiiiiiii'),
      wide: probe('WWWWWWWWWW'),
      advance: probe('0123456789') / 10,
      rendered: range.getBoundingClientRect().right - element.getBoundingClientRect().left,
      letterSpacing: hostStyle.letterSpacing,
      wordSpacing: hostStyle.wordSpacing,
      textTransform: hostStyle.textTransform,
    };
  });
  const label = `the ${family}-${SCHEME} terminal at ${where}`;
  process.stdout.write(
    `   terminal geometry ${family}-${SCHEME} ${where}: "${measured.text}" ${measured.rendered.toFixed(1)}px for ` +
      `${measured.text.length} cells of ${measured.advance.toFixed(2)}px; i×10=${measured.narrow.toFixed(1)} ` +
      `W×10=${measured.wide.toFixed(1)} in ${measured.family}\n`,
  );
  if (Math.abs(measured.narrow - measured.wide) > 1)
    fail(
      `${label} resolved a proportional face (i×10 ${measured.narrow}px, W×10 ${measured.wide}px) from ${measured.family}`,
    );
  if (Math.abs(measured.rendered - measured.text.length * measured.advance) > measured.text.length * 0.5)
    fail(
      `${label} spreads its text: "${measured.text}" spans ${measured.rendered}px, not ` +
        `${measured.text.length} × ${measured.advance}px`,
    );
  if (measured.letterSpacing !== 'normal' || measured.wordSpacing !== '0px' || measured.textTransform !== 'none')
    fail(
      `${label} inherits typography: letter-spacing ${measured.letterSpacing}, word-spacing ` +
        `${measured.wordSpacing}, text-transform ${measured.textTransform}`,
    );
  terminalGeometryChecks += 1;
};

const settleTransitions = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    // A finite transition is settled; an infinite busy mark (a spinner's reduced-motion pulse) has no
    // end to finish at, and `finish()` throws on one.
    for (const animation of document.getAnimations())
      if (animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY) animation.finish();
  });
};

/**
 * Put `<html data-theme>` to `theme` (`''` removes it) and let the page LAND there before the next step.
 *
 * Every theme flip in this file goes through here, because a flip on its own leaves the page moving.
 * The contexts emulate reduced motion, and `index.css` answers that by giving every element a 1ms
 * transition — on every property, since `transition-property` defaults to `all` — so a new theme's
 * font sizes, line heights and padding are not applied until the transitions run, two frames later.
 * Two frames of the OLD layout is exactly what Playwright's "stable" check accepts. Measured at
 * 1440px, the Edit as YAML button at the foot of a profile sat still for two frames after the theme
 * was put back, then dropped 23px — more than half its height — so a click pressed it at its old
 * place and released over the row above, the button never saw a click, and the editor it opens was
 * waited for until the run timed out. Finishing the transitions puts every box where it ends up before
 * anything is clicked or measured.
 */
const applyTheme = async (page: Page, theme: string): Promise<void> => {
  await page.evaluate(next => {
    if (next === '') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  }, theme);
  await settleTransitions(page);
};

/**
 * The machine tab strip scrolls the current tab to its centre SMOOTHLY (unless the reader asked for
 * reduced motion), so a read taken the frame after a click measures a strip still on its way there.
 * Wait until it has stopped moving — what a person looks at — rather than for a fixed time.
 */
const settleTabStrip = async (page: Page): Promise<void> => {
  await page.evaluate(
    async () =>
      await new Promise<void>(resolve => {
        const strip = document.querySelector('[data-machines-surface] [data-underline-tabs] ul');
        if (strip === null) return resolve();
        let last = -1;
        let still = 0;
        const tick = (): void => {
          still = strip.scrollLeft === last ? still + 1 : 0;
          last = strip.scrollLeft;
          if (still >= 3) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
};

/**
 * Move the pointer off every control. A ghost button paints its hover fill, so one left under the pointer
 * by the click that opened a page (a disclosure, a row that moved under it) reads as a painted box whose
 * edge sits in the gutter, though a person looking at the page sees no fill. The corner is padding.
 */
const parkPointer = async (page: Page): Promise<void> => {
  await page.mouse.move(1, 1);
  await settleTransitions(page);
};

const assertMachinesGeometry = async (page: Page, where: string): Promise<void> => {
  await settleTransitions(page);
  await settleTabStrip(page);
  const tabs = page.locator('[data-machines-surface] [data-machine-tab]');
  // The hover half needs a real pointer over a real unselected tab, so it is driven before the read. It
  // is an unselected tab ALREADY IN VIEW, moved to by coordinates: `locator.hover()` would scroll the
  // strip to reach the first one, and a strip scrolled by the measurement is not the strip a person sees.
  let hovered: string | null = null;
  if ((await tabs.count()) > 0) {
    const target = await page.evaluate(() => {
      const strip = document.querySelector('[data-machines-surface] [data-underline-tabs] ul');
      const stripBox = strip?.getBoundingClientRect();
      for (const tab of document.querySelectorAll('[data-machines-surface] [data-machine-tab]:not([aria-current])')) {
        const box = tab.getBoundingClientRect();
        if (stripBox === undefined || (box.left >= stripBox.left && box.right <= stripBox.right))
          return { id: tab.getAttribute('data-machine-tab'), x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      return null;
    });
    if (target !== null) {
      hovered = target.id;
      await page.mouse.move(target.x, target.y);
      await settleTransitions(page);
    } else {
      await parkPointer(page);
    }
  } else {
    await parkPointer(page);
  }
  const problems = await page.evaluate(hoveredTab => {
    const found: string[] = [];
    const section = document.querySelector('[data-settings-section="machines"]');
    if (section === null) return ['the Machines section is not on screen'];
    const root = getComputedStyle(document.documentElement);
    const token = (name: string): number => Number.parseFloat(root.getPropertyValue(name));
    const padPanel = token('--pad-panel');
    const gapXs = token('--gap-xs');
    const sectionBox = section.getBoundingClientRect();
    const edge = sectionBox.left;
    const right = sectionBox.right;
    const describe = (element: Element): string => {
      const hooks = [...element.attributes]
        .filter(attribute => attribute.name.startsWith('data-'))
        .map(attribute => `[${attribute.name}${attribute.value === '' ? '' : `="${attribute.value}"`}]`)
        .slice(0, 2)
        .join('');
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${element.tagName.toLowerCase()}${hooks}${text === '' ? '' : ` "${text}"`}`;
    };
    // A colour nobody can see paints nothing: a ghost button's transparent border is not an edge.
    const seen = (colour: string): boolean => {
      const alpha = /rgba?\([^)]*?,\s*[^,]+,\s*[^,]+,\s*([\d.]+)\)/.exec(colour);
      return colour !== 'transparent' && (alpha === null || Number.parseFloat(alpha[1] ?? '1') > 0);
    };
    const painted = (style: CSSStyleDeclaration): boolean =>
      (Number.parseFloat(style.borderLeftWidth) > 0 &&
        style.borderLeftStyle !== 'none' &&
        seen(style.borderLeftColor)) ||
      seen(style.backgroundColor);
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.position !== 'absolute' && style.position !== 'fixed';
    };
    const LEAVES = new Set([
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'P',
      'UL',
      'OL',
      'DL',
      'TABLE',
      'PRE',
      'BUTTON',
      'A',
      'INPUT',
      'SELECT',
      'TEXTAREA',
      'LABEL',
      'NAV',
      'FIELDSET',
      'SVG',
      'IMG',
      'DETAILS',
    ]);
    const ownText = (element: Element): boolean =>
      [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
    interface Item {
      readonly element: Element;
      readonly start: number;
      readonly box: DOMRect;
      readonly card: boolean;
    }
    const items: Item[] = [];
    // `bleed`: inside a card, a painted band that spans the card edge to edge (a header strip, a row
    // divider) is part of the card's surface rather than content, so its content is what is inset.
    const walk = (element: Element, into: Item[], bleed?: number): void => {
      for (const child of element.children) {
        if (!visible(child)) {
          // display: contents and zero-size wrappers still hold visible children.
          if (getComputedStyle(child).display === 'contents' || child.getBoundingClientRect().width > 1)
            walk(child, into, bleed);
          continue;
        }
        const style = getComputedStyle(child);
        const card = painted(style);
        const box = child.getBoundingClientRect();
        if (card && bleed !== undefined && Math.abs(box.left - bleed) <= 0.5) {
          walk(child, into, bleed + Number.parseFloat(style.borderLeftWidth));
          continue;
        }
        if (card || LEAVES.has(child.tagName.toUpperCase()) || ownText(child)) {
          // A bulleted list starts at its box: the bullet hangs in the list's padding by design.
          const marked = ['UL', 'OL'].includes(child.tagName.toUpperCase()) && style.listStyleType !== 'none';
          const start =
            card || marked
              ? box.left
              : box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
          into.push({ element: child, start, box, card });
          continue;
        }
        walk(child, into, bleed);
      }
    };
    walk(section, items);
    if (items.length === 0) found.push('nothing visible was found in the Machines section');
    const overlapsVertically = (a: DOMRect, b: DOMRect): boolean =>
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (const item of items) {
      if (item.start < edge - 0.5)
        found.push(`${describe(item.element)} starts ${(edge - item.start).toFixed(1)}px LEFT of the section's edge`);
      else if (item.start > edge + 0.5) {
        const beside = items.some(
          other => other !== item && overlapsVertically(other.box, item.box) && other.box.right <= item.box.left + 0.5,
        );
        if (!beside)
          found.push(
            `${describe(item.element)} starts ${(item.start - edge).toFixed(1)}px right of the section's edge ` +
              'with nothing beside it — one left edge for the whole section',
          );
      }
      if (item.box.right > right + 0.5)
        found.push(
          `${describe(item.element)} ends ${(item.box.right - right).toFixed(1)}px past the section's right edge`,
        );
    }
    // EVERY panel card in the section, nested ones included (a list of cards is the commonest nesting):
    // its content starts `--pad-panel` in. The INSET, not the padding property — a list card pads its
    // rows rather than itself, and what a reader sees is where the card's content starts.
    for (const panel of section.querySelectorAll('.kt-panel')) {
      if (!visible(panel)) continue;
      const inner = panel.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(panel).borderLeftWidth);
      const content: Item[] = [];
      walk(panel, content, inner);
      if (content.length === 0) continue;
      const inset = Math.min(...content.map(entry => entry.start)) - inner;
      if (Math.abs(inset - padPanel) > 0.5)
        found.push(
          `${describe(panel)} is a panel whose content starts ${inset.toFixed(1)}px in, not --pad-panel (${padPanel}px)`,
        );
    }
    // And no card or button is flush under the thing before it, at any depth: the nearest previous
    // sibling of it or of an ancestor (a card in a list is an `li`'s child) is at least `--gap-xs` above.
    for (const block of section.querySelectorAll('.kt-panel, .kt-btn, button, a[data-variant]')) {
      if (!visible(block)) continue;
      const top = block.getBoundingClientRect();
      for (let node: Element | null = block; node !== null && node !== section; node = node.parentElement) {
        let previous = node.previousElementSibling;
        while (previous !== null && !visible(previous)) previous = previous.previousElementSibling;
        if (previous === null) continue;
        const before = previous.getBoundingClientRect();
        const stacked =
          before.bottom <= top.top + 0.5 && Math.min(before.right, top.right) - Math.max(before.left, top.left) > 1;
        // A row of a divided list (`divide-y`) is flush with a rule between, which is the separation.
        const divided = Number.parseFloat(getComputedStyle(node).borderTopWidth) > 0;
        if (stacked && !divided && top.top - before.bottom < gapXs - 0.5)
          found.push(
            `${describe(block)} is ${(top.top - before.bottom).toFixed(1)}px under ${describe(previous)} — ` +
              `closer than --gap-xs (${gapXs}px)`,
          );
        break;
      }
    }
    const blocks = (item: Item): boolean =>
      item.card || ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(item.element.tagName.toUpperCase());
    for (const item of items) {
      if (!blocks(item)) continue;
      // The nearest thing above it that shares its columns.
      const above = items
        .filter(
          other =>
            other !== item &&
            other.box.bottom <= item.box.top + 0.5 &&
            Math.min(other.box.right, item.box.right) - Math.max(other.box.left, item.box.left) > 1,
        )
        .sort((a, b) => b.box.bottom - a.box.bottom)[0];
      if (above !== undefined && item.box.top - above.box.bottom < gapXs - 0.5)
        found.push(
          `${describe(item.element)} is ${(item.box.top - above.box.bottom).toFixed(1)}px under ` +
            `${describe(above.element)} — closer than --gap-xs (${gapXs}px)`,
        );
    }

    const row = section.querySelector('[data-machines-surface] [data-underline-tabs] ul');
    if (row !== null) {
      // THE STRIP MAY SCROLL — on a phone it is meant to — but never silently: the current tab is kept in
      // view, and an edge with tabs beyond it says so with its fade.
      const strip = row.closest('[data-underline-tabs]');
      const more = { start: row.scrollLeft > 1, end: row.scrollLeft + row.clientWidth < row.scrollWidth - 1 };
      for (const [edgeName, beyond] of [
        ['start', more.start],
        ['end', more.end],
      ] as const)
        if (strip?.getAttribute(`data-more-${edgeName}`) !== String(beyond))
          found.push(
            `the tab strip's ${edgeName} fade says ${strip?.getAttribute(`data-more-${edgeName}`)} with tabs beyond it: ${beyond}`,
          );
      const rowBox = row.getBoundingClientRect();
      const buttons = [...row.querySelectorAll('[data-machine-tab]')];
      if (buttons.length !== 5) found.push(`the tab row has ${buttons.length} tabs instead of 5`);
      const current = buttons.filter(button => button.getAttribute('aria-current') === 'page');
      if (current.length !== 1) found.push(`${current.length} tabs are marked current instead of one`);
      const cells = buttons.map(button => button.getBoundingClientRect());
      buttons.forEach((button, index) => {
        const name = button.getAttribute('data-machine-tab');
        const box = cells[index] as DOMRect;
        if (button.scrollWidth > button.clientWidth)
          found.push(`the ${name} tab's content is ${button.scrollWidth}px in a ${button.clientWidth}px button`);
        if (
          button.getAttribute('aria-current') === 'page' &&
          (box.left < rowBox.left - 0.5 || box.right > rowBox.right + 0.5)
        )
          found.push(`the current ${name} tab is scrolled out of view`);
        const style = getComputedStyle(button);
        const inner = {
          left: box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
          right: box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
        };
        const label = button.querySelector('span');
        const range = document.createRange();
        if (label !== null) range.selectNodeContents(label);
        const text = label === null ? null : range.getBoundingClientRect();
        if (text === null) found.push(`the ${name} tab has no label`);
        else if (text.left < inner.left - 0.5 || text.right > inner.right + 0.5)
          found.push(
            `the ${name} tab's label (${text.left.toFixed(1)}–${text.right.toFixed(1)}px) reaches into its ` +
              `padding (${inner.left.toFixed(1)}–${inner.right.toFixed(1)}px)`,
          );
        const next = cells[index + 1];
        if (next !== undefined && next.left - box.right < gapXs - 0.5)
          found.push(
            `the ${name} tab is ${(next.left - box.right).toFixed(1)}px from the next — under --gap-xs (${gapXs}px)`,
          );
      });
      const look = (button: Element): string => {
        const style = getComputedStyle(button);
        return `${style.borderBottomColor} ${style.color}`;
      };
      const selected = current[0];
      if (selected !== undefined)
        for (const button of buttons)
          if (button !== selected) {
            const a = getComputedStyle(button);
            const b = getComputedStyle(selected);
            // The underline and the ink are what mark a tab selected; no tab paints a fill.
            if (a.borderBottomColor === b.borderBottomColor || a.color === b.color)
              found.push(
                `the ${button.getAttribute('data-machine-tab')} tab${
                  button.getAttribute('data-machine-tab') === hoveredTab ? ', hovered,' : ''
                } shares a colour with the selected tab (${look(button)} vs ${look(selected)}) — two tabs read as selected`,
              );
          }
    }
    return found;
  }, hovered);
  if (hovered !== null) await page.mouse.move(0, 0);
  if (problems.length > 0) fail(`${where}: the Machines layout is off\n${problems.map(p => `   ${p}`).join('\n')}`);
  machinesGeometryChecks += 1;
  process.stdout.write(`📐 one left edge${hovered === null ? '' : ', tab bar fits'}: ${where}\n`);
};

/**
 * NEW MACHINE SETUP'S CONTRACT, measured: no app chrome at all; a progress rail — a column on a desktop,
 * a strip on a phone — marking exactly the step on screen; and ‹ Back with Skip and Continue in ONE footer
 * pinned inside the viewport, above a phone's home indicator, on every step. Counted with the Machines frames.
 */
const assertSetupGeometry = async (page: Page, where: string): Promise<void> => {
  await settleTransitions(page);
  const problems = await page.evaluate(() => {
    const found: string[] = [];
    if (document.querySelector('[data-density-region="app-bar"], [data-app-tab-bar]') !== null)
      found.push('app chrome is on screen around the setup');
    // New machine setup (P9): a progress rail — a column on a desktop, a strip on a phone — with the open
    // step marked, and Back / Skip / Continue pinned to the bottom of the screen.
    const setup = document.querySelector<HTMLElement>('[data-machine-onboarding]');
    if (setup === null) return [...found, 'New machine setup is not on screen'];
    const wide = window.innerWidth >= 768;
    const rail = setup.querySelector<HTMLElement>(`[data-onboarding-rail="${wide ? 'column' : 'row'}"]`);
    if (rail === null || rail.getBoundingClientRect().width === 0)
      return [...found, `the ${wide ? 'step rail' : 'step strip'} is not shown`];
    const current = [...rail.querySelectorAll('[data-onboarding-go]')].filter(
      step => step.getAttribute('aria-current') === 'step',
    );
    if (current.length !== 1) found.push(`the rail marks ${current.length} current steps instead of 1`);
    else if (current[0]?.getAttribute('data-onboarding-go') !== setup.getAttribute('data-onboarding-at'))
      found.push('the rail marks a different step from the one on screen');
    const foot = setup.querySelector<HTMLElement>('[data-onboarding-foot]');
    if (foot === null) return [...found, 'there is no pinned footer'];
    const box = foot.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight + 0.5)
      found.push(
        `the footer (${box.top.toFixed(0)}–${box.bottom.toFixed(0)}px) is not inside the ${window.innerHeight}px viewport`,
      );
    const buttons = [...foot.querySelectorAll('button')];
    if (buttons.length === 0) found.push('the footer holds no Back and no action');
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (rect.left < -0.5 || rect.right > window.innerWidth + 0.5)
        found.push(`the footer's "${button.textContent?.trim()}" sits outside the viewport`);
    }
    return found;
  });
  if (problems.length > 0) fail(`${where}: the setup layout is off\n${problems.map(p => `   ${p}`).join('\n')}`);
  machinesGeometryChecks += 1;
  process.stdout.write(`📐 New machine setup, rail and pinned footer: ${where}\n`);
};

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: packageDir, stdio: 'inherit' });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`);
}

type HarnessViewport = (typeof VIEWPORTS)[number];

/** Read paint and accessibility facts from one presented search control. */
async function inspectSessionSearch(page: Page, regionSelector: string) {
  return await page.evaluate(selector => {
    const region = document.querySelector<HTMLElement>(selector);
    if (region === null) throw new Error(`missing session-search region ${selector}`);
    const input = region.querySelector<HTMLInputElement>('[data-current-session-search] input');
    const leading = region.querySelector<HTMLElement>('[data-search-leading]');
    const trailing = region.querySelector<HTMLElement>('[data-search-trailing]');
    const popup = region.querySelector<HTMLElement>('[data-session-search-popup]');
    if (input === null || leading === null || trailing === null || popup === null)
      throw new Error(`incomplete session-search geometry in ${selector}`);

    const inputBox = input.getBoundingClientRect();
    const leadingBox = leading.getBoundingClientRect();
    const trailingBox = trailing.getBoundingClientRect();
    const popupBox = popup.getBoundingClientRect();
    const style = getComputedStyle(input);
    const borderStart = Number.parseFloat(style.borderInlineStartWidth) || 0;
    const borderEnd = Number.parseFloat(style.borderInlineEndWidth) || 0;
    const paddingStart = Number.parseFloat(style.paddingInlineStart) || 0;
    const paddingEnd = Number.parseFloat(style.paddingInlineEnd) || 0;
    const active = input.getAttribute('aria-activedescendant');
    const activeNode = active === null ? null : document.getElementById(active);
    const sampleX = Math.round(popupBox.left + popupBox.width / 2);
    const sampleY = Math.round(popupBox.top + Math.min(popupBox.height / 2, 20));
    const hit = document.elementFromPoint(sampleX, sampleY);
    const clippers: string[] = [];
    for (let ancestor = popup.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(ancestorStyle.overflowX);
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(ancestorStyle.overflowY);
      if (!clipsX && !clipsY) continue;
      const box = ancestor.getBoundingClientRect();
      if (
        (clipsX && (popupBox.left < box.left - 0.5 || popupBox.right > box.right + 0.5)) ||
        (clipsY && (popupBox.top < box.top - 0.5 || popupBox.bottom > box.bottom + 0.5))
      )
        clippers.push(`${ancestor.tagName.toLocaleLowerCase()}.${ancestor.className}`);
    }

    return {
      expanded: input.getAttribute('aria-expanded'),
      active,
      activeOwned: activeNode !== null && popup.contains(activeNode),
      // Both hooks are BOOLEAN — presence is the fact, per the frozen interface
      // contract — so the partial semantic comes from the fixture and the copy,
      // never from an attribute value the driver would be free to invent.
      // `coveragePartial` is only ever present on an unfinished walk; `skipNote`
      // is rendered at any coverage, because a complete index still leaves out
      // denied, excluded and unsupported paths and must say which.
      coveragePartial: region.querySelector('[data-search-coverage]') !== null,
      skipNote: region.querySelector('[data-search-skips]')?.textContent?.trim() ?? null,
      // Kept by the harness fetch wrapper, because an answered route never
      // reaches the network and the driver's own request events see nothing.
      requests: [...((window as unknown as { __harnessRequests?: readonly string[] }).__harnessRequests ?? [])],
      options: region.querySelectorAll('[role="option"]').length,
      kinds: Array.from(region.querySelectorAll<HTMLElement>('[role="option"]'), option => option.dataset.resultKind),
      indexing: region.querySelector('[data-search-indexing]') !== null,
      shortcut: region.querySelector('[data-search-shortcut]')?.textContent ?? null,
      text: region.textContent ?? '',
      focused: document.activeElement === input,
      focusVisible: input.matches(':focus-visible'),
      contentStart: inputBox.left + borderStart + paddingStart,
      contentEnd: inputBox.right - borderEnd - paddingEnd,
      leadingRight: leadingBox.right,
      trailingLeft: trailingBox.left,
      popup: {
        top: popupBox.top,
        right: popupBox.right,
        bottom: popupBox.bottom,
        left: popupBox.left,
      },
      popupOwned: hit !== null && popup.contains(hit),
      clippers,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, regionSelector);
}

function assertSessionSearchGeometry(
  state: Awaited<ReturnType<typeof inspectSessionSearch>>,
  label: string,
  viewport: HarnessViewport,
): void {
  if (state.expanded !== 'true') fail(`${label} did not present its popup at ${viewport.name}`);
  if (!state.focused) fail(`${label} lost focus from its combobox at ${viewport.name}`);
  if (state.contentStart < state.leadingRight + 4)
    fail(
      `${label} lets its leading glyph overlap the text/caret at ${viewport.name}: ` +
        `content starts ${state.contentStart.toFixed(1)}px, glyph ends ${state.leadingRight.toFixed(1)}px`,
    );
  if (state.contentEnd > state.trailingLeft - 4)
    fail(
      `${label} does not reserve its trailing spinner/hint slot at ${viewport.name}: ` +
        `content ends ${state.contentEnd.toFixed(1)}px, slot starts ${state.trailingLeft.toFixed(1)}px`,
    );
  const popup = state.popup;
  if (
    popup.top < -0.5 ||
    popup.left < -0.5 ||
    popup.right > state.viewport.width + 0.5 ||
    popup.bottom > state.viewport.height + 0.5
  )
    fail(
      `${label} popup leaves ${viewport.name}: ${popup.left.toFixed(1)},${popup.top.toFixed(1)} → ` +
        `${popup.right.toFixed(1)},${popup.bottom.toFixed(1)} in ${state.viewport.width}x${state.viewport.height}`,
    );
  if (state.clippers.length > 0) fail(`${label} popup is clipped at ${viewport.name} by ${state.clippers.join(', ')}`);
  if (!state.popupOwned) fail(`${label} popup is painted under another layer at ${viewport.name}`);
  if (state.active !== null && !state.activeOwned)
    fail(`${label} aria-activedescendant does not name one of its own options at ${viewport.name}`);
  if (viewport.name === 'mobile' && state.shortcut !== null)
    fail(`${label} prints the non-actionable physical-key hint ${JSON.stringify(state.shortcut)} on mobile`);
}

/** The session the healthy search fixture answers for, and its short-index twin. */
const SEARCH_SESSION_ID = 'harness-session';
const SEARCH_PARTIAL_SESSION_ID = 'harness-partial-session';

/**
 * A task whose SUMMARY contains no `port` — only its original ask does.
 *
 * It is the whole point of the mixed-results assertion: a client matching
 * locally against summaries cannot produce this row, so its presence is the
 * evidence that the daemon answered the query.
 */
const SEARCH_PROSE_ONLY_TASK = 'Retire the legacy state path';

/** The frozen partial-coverage sentence (irish → alexandra interface contract). */
const SEARCH_PARTIAL_SENTENCE = 'File results are incomplete: the index did not finish.';

/**
 * One session's reads, taken from the in-page ledger and narrowed to that
 * session's own route prefix.
 *
 * Narrowing by session id is what makes the counts EXACT rather than "at least":
 * the compiled workspace page renders `harness-workspace` while its search box
 * reads `harness-session`, so the page's own file reads share no prefix with the
 * search's and cannot be miscounted as one.
 */
function sessionRequestLedger(requests: readonly string[], sessionId: string) {
  const prefix = `/v1/sessions/${sessionId}/`;
  const scoped = requests.filter(entry => entry.includes(prefix));
  const routes = scoped.map(entry => entry.slice(entry.indexOf(prefix) + prefix.length));
  return {
    scoped,
    /** The bare board read: no query string at all. */
    board: routes.filter(route => route === 'tasks').length,
    /** Every `q` the reader actually sent, DECODED — so `a+b` cannot pass as `a b`. */
    queries: routes.flatMap(route => {
      if (!route.startsWith('tasks?')) return [];
      const value = new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('q');
      return value === null ? [] : [value];
    }),
    index: routes.filter(route => route === 'fs/index').length,
    /** The deleted N+1: one detail read per row. */
    detail: routes.filter(route => /^tasks\/[^?]/.test(route)).length,
    /** The deleted browser-side walk: one directory listing per node. */
    listing: routes.filter(route => route.startsWith('fs?')).length,
  };
}

/**
 * Wait until the typed query has actually been SENT for this session.
 *
 * Rows can be on screen before it has: files are filtered from the index the
 * page already holds, while the task half is a debounced request. Inspecting on
 * the rows alone photographs a half-settled popup and reads back `q=[]` — which
 * is a race in the driver, not a finding about the product. If the reader never
 * sends one, this is where that shows up.
 */
async function waitForSettledQuery(page: Page, sessionId: string): Promise<void> {
  await page.waitForFunction(
    prefix => {
      const requests = (window as unknown as { __harnessRequests?: readonly string[] }).__harnessRequests ?? [];
      return requests.some(entry => entry.includes(`${prefix}tasks?`));
    },
    `/v1/sessions/${sessionId}/`,
    { timeout: 10_000 },
  );
}

function describeLedger(ledger: ReturnType<typeof sessionRequestLedger>): string {
  return (
    `tasks=${ledger.board} q=[${ledger.queries.join('|')}] fs/index=${ledger.index} ` +
    `tasks/:id=${ledger.detail} fs?path=${ledger.listing}`
  );
}

/**
 * Current-session search evidence, both as a state ledger and inside the real
 * compiled workspace shell. Kept in one function so `--search-only` exercises
 * exactly the same journey as the full visual run.
 */
async function captureSessionSearchEvidence(page: Page, viewport: HarnessViewport, rootUrl: string): Promise<void> {
  for (const card of ['results', 'no-match', 'indexing', 'unavailable', 'partial-coverage'] as const) {
    await page.goto(`${rootUrl}#session-search`);
    await page.reload();
    const selector = `[data-search-card="${card}"]`;
    const cardRegion = page.locator(selector);
    await cardRegion.waitFor({ state: 'visible' });

    const typed = card === 'no-match' ? 'zzzz-nothing-matches-this' : 'port';
    // The two cards whose daemon never answers are the two whose reads this
    // ledger does not record; the rest are the healthy host, one scope each.
    const ledgerSession = card === 'partial-coverage' ? SEARCH_PARTIAL_SESSION_ID : SEARCH_SESSION_ID;
    const answers = card !== 'indexing' && card !== 'unavailable';
    const field = cardRegion.locator('[data-current-session-search] input');
    await field.click();
    await field.fill(typed);
    await cardRegion.locator('[data-session-search-popup]').waitFor({ state: 'visible' });
    // Presentation is synchronous; evidence is not. Wait for the state this
    // capture claims instead of racing the independent task/file reads.
    if (card === 'results') await cardRegion.locator('[role="option"]').nth(1).waitFor({ state: 'visible' });
    else if (card === 'no-match')
      await cardRegion.getByText('No current-session files or tasks match', { exact: false }).waitFor();
    else if (card === 'unavailable') await cardRegion.getByText('unavailable:', { exact: false }).waitFor();
    else if (card === 'partial-coverage') await cardRegion.locator('[data-search-coverage]').waitFor();
    if (answers) await waitForSettledQuery(page, ledgerSession);
    const state = await inspectSessionSearch(page, selector);
    assertSessionSearchGeometry(state, `session search ${card}`, viewport);
    // The `indexing` and `unavailable` cards read hosts this ledger deliberately
    // does not record, so their entry here is the healthy session the OTHER
    // providers on this page mount — which is exactly what the zero claims below
    // are about. Counts of one are NOT asserted on this hash: the root provider
    // and two cards share `harness-session`, so the board and index reads
    // legitimately multiply. Only the compiled shell has one provider per scope.
    const ledger = sessionRequestLedger(state.requests, ledgerSession);

    process.stdout.write(
      `   session search ${card} @ ${viewport.name}: expanded=${state.expanded ?? '(none)'} ` +
        `options=${state.options} kinds=${state.kinds.join(',') || '(none)'} active=${state.active ?? '(none)'} ` +
        `indexing=${String(state.indexing)} shortcut=${state.shortcut ?? '(hidden)'} ` +
        `partial=${String(state.coveragePartial)} skips=${JSON.stringify(state.skipNote)} ` +
        `text-gap=${(state.contentStart - state.leadingRight).toFixed(1)}px\n` +
        `   session search ${card} @ ${viewport.name} ledger[${ledgerSession}]: ${describeLedger(ledger)}\n`,
    );

    if (ledger.detail > 0)
      fail(
        `the ${card} session-search card still reads task detail at ${viewport.name}: ` +
          `${ledger.detail} \`/tasks/:id\` request(s)`,
      );
    if (ledger.listing > 0)
      fail(
        `the ${card} session-search card still walks the filesystem at ${viewport.name}: ` +
          `${ledger.listing} \`/fs?path=\` request(s)`,
      );
    if (answers && ledger.queries.join('|') !== typed)
      fail(
        `the ${card} session-search card did not send exactly one settled query at ${viewport.name}: ` +
          `${JSON.stringify(ledger.queries)}`,
      );

    if (card === 'results') {
      if (!state.kinds.includes('file') || !state.kinds.includes('task'))
        fail(
          `the results card is not a mixed file/task result set at ${viewport.name}: ${JSON.stringify(state.kinds)}`,
        );
      if (state.active === null) fail(`the results card points aria-activedescendant at nothing at ${viewport.name}`);
      if (!state.text.includes(SEARCH_PROSE_ONLY_TASK))
        fail(
          `the results card lost its ask-prose-only task at ${viewport.name}: ` +
            `${JSON.stringify(SEARCH_PROSE_ONLY_TASK)} matches \`port\` in no summary field, so its absence ` +
            `means the query was answered locally rather than by the daemon`,
        );
      // A COMPLETE index still names what it deliberately left out — the
      // fixture's denied, excluded and unsupported entries — and must not borrow
      // the partial sentence to do it.
      if (state.coveragePartial) fail(`the results card called a complete index partial at ${viewport.name}`);
      if (state.skipNote === null || state.skipNote === '')
        fail(`the results card hid its policy skips at ${viewport.name}`);
    }
    if (card === 'partial-coverage') {
      if (state.options === 0) fail(`the partial-coverage card rendered no indexed rows at ${viewport.name}`);
      // A short FILE index says nothing about the task half. If the task rows
      // vanish here, an incomplete walk has been allowed to degrade a result set
      // it does not own.
      if (!state.kinds.includes('file') || !state.kinds.includes('task'))
        fail(
          `the partial-coverage card let a short file index suppress the task half at ${viewport.name}: ` +
            JSON.stringify(state.kinds),
        );
      if (!state.coveragePartial)
        fail(`the partial-coverage card never declared its walk unfinished at ${viewport.name}`);
      if (!state.text.includes(SEARCH_PARTIAL_SENTENCE))
        fail(
          `the partial-coverage card rendered rows without qualifying them at ${viewport.name}: ` +
            `expected ${JSON.stringify(SEARCH_PARTIAL_SENTENCE)}`,
        );
      if (state.skipNote === null || state.skipNote === '')
        fail(`the partial-coverage card never named the work it skipped at ${viewport.name}`);
      if (state.text.includes('No current-session files or tasks match'))
        fail(`the partial-coverage card called a short index an empty result at ${viewport.name}`);
      if (state.text.includes('unavailable:'))
        fail(`the partial-coverage card called a short index a refusal at ${viewport.name}`);
    }
    const owed: Readonly<Record<string, string>> = {
      'no-match': 'No current-session files or tasks match',
      indexing: "Indexing this session's files and tasks",
      unavailable: 'unavailable:',
    };
    const sentence = owed[card];
    if (sentence !== undefined && !state.text.includes(sentence))
      fail(`the ${card} session-search card never said ${JSON.stringify(sentence)} at ${viewport.name}`);
    if (card === 'unavailable' && state.text.includes('No current-session files or tasks match'))
      fail(`the unavailable session-search card called a failed index an empty result at ${viewport.name}`);

    const target = join(outDir, `${viewport.name}-session-search-${card}.png`);
    await page.screenshot({ path: target });
    process.stdout.write(`📸 ${viewport.name} session search ${card} -> ${target}\n`);
  }

  await page.goto(`${rootUrl}#session-workspace`);
  await page.reload();
  const shellSelector = '#harness-session-workspace-page';
  const shell = page.locator(shellSelector);
  await shell.waitFor({ state: 'visible' });
  // A PHONE'S SESSION PAGE HAS NO SEARCH BOX: its one bar is the agent's name, status and actions, and
  // the finder lives in the sessions drawer behind ☰. The shell's search is a desktop surface.
  if (viewport.name === 'mobile') {
    process.stdout.write(
      '   compiled shell @ mobile: no shell search on a phone session page (the drawer holds the finder)\n',
    );
    return;
  }
  // The sessions bar keeps a finder icon beside this session's own search.
  await page.locator('[data-app-bar-destination-search]').first().waitFor({ state: 'visible' });
  const destinationShortcut = await page.evaluate(() => {
    const finders = Array.from(document.querySelectorAll<HTMLElement>('[data-app-bar-destination-search]'));
    return {
      finders: finders.length,
      ariaClaims: finders.filter(finder => finder.hasAttribute('aria-keyshortcuts')).length,
      physicalLegends: finders.filter(finder => /\bCtrl\s*K\b|⌘\s*K/u.test(finder.textContent ?? '')).length,
    };
  });
  if (destinationShortcut.finders === 0)
    fail(`compiled app shell has no clickable global Find entry at ${viewport.name}`);
  if (destinationShortcut.ariaClaims > 0 || destinationShortcut.physicalLegends > 0)
    fail(
      `global Find still claims the current-session shortcut at ${viewport.name}: ` +
        `${destinationShortcut.ariaClaims} aria claim(s), ${destinationShortcut.physicalLegends} physical legend(s)`,
    );
  const shellField = shell.locator('[data-sessions-bar] [data-current-session-search] input');
  // Programmatic keyboard focus makes the focus-visible ring part of the
  // evidence without pretending a phone has a physical Ctrl key.
  await shellField.focus();
  await shellField.fill('port');
  await shell.locator('[role="option"]').nth(1).waitFor({ state: 'visible' });
  await waitForSettledQuery(page, SEARCH_SESSION_ID);
  const shellState = await inspectSessionSearch(page, shellSelector);
  assertSessionSearchGeometry(shellState, 'compiled app-shell session search', viewport);
  if (!shellState.focusVisible) fail(`compiled app-shell search has no keyboard focus ring at ${viewport.name}`);
  if (!shellState.kinds.includes('file') || !shellState.kinds.includes('task'))
    fail(`compiled app-shell search is not a mixed selectable result set at ${viewport.name}`);

  /**
   * The exact ledger, and the only place it can be exact.
   *
   * One provider holds `harness-session` on this page, and `/v1/sessions/:id/tasks`
   * is dialled from exactly one place in the PWA — so `1` is a count, not a floor.
   * The page's own Files tab and reference reads are `harness-workspace` and are
   * filtered out by prefix rather than by hoping they did not fire.
   */
  const shellLedger = sessionRequestLedger(shellState.requests, SEARCH_SESSION_ID);
  process.stdout.write(
    `   compiled shell @ ${viewport.name} ledger[${SEARCH_SESSION_ID}]: ${describeLedger(shellLedger)}\n`,
  );
  const shellExpected = { board: 1, queries: 'port', index: 1, detail: 0, listing: 0 };
  const shellActual = {
    board: shellLedger.board,
    queries: shellLedger.queries.join('|'),
    index: shellLedger.index,
    detail: shellLedger.detail,
    listing: shellLedger.listing,
  };
  if (JSON.stringify(shellActual) !== JSON.stringify(shellExpected))
    fail(
      `the compiled shell's ${SEARCH_SESSION_ID} request ledger is wrong at ${viewport.name}: ` +
        `expected ${JSON.stringify(shellExpected)}, measured ${JSON.stringify(shellActual)} ` +
        `from ${JSON.stringify(shellLedger.scoped)}`,
    );
  const shellTarget = join(outDir, `${viewport.name}-session-search-shell.png`);
  await page.screenshot({ path: shellTarget });
  process.stdout.write(
    `📸 ${viewport.name} compiled app-shell session search (${shellState.options} options, ` +
      `${shellState.kinds.join(',')}) -> ${shellTarget}\n`,
  );
}

/**
 * DictationSheet renders its `[data-dictation-panel="non-modal"]` overlay
 * absolutely positioned ABOVE its anchor, so it can paint outside the card's
 * own bounding box without ever growing it — `card.screenshot()` clips the
 * overlay away. Scroll the card into view, take the union of the card and
 * every visible panel descendant's page bounding box, and clip a page
 * screenshot to that union instead.
 */
async function screenshotDictationCard(page: Page, card: Locator, target: string): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const panels = card.locator('[data-dictation-panel="non-modal"]');

  const measureUnion = async () => {
    const cardBox = await card.boundingBox();
    if (cardBox === null) fail(`${target}: dictation card has no bounding box`);
    const panelCount = await panels.count();
    if (panelCount === 0) fail(`${target}: no dictation panel found to union with the card`);
    const boxes = [cardBox];
    for (let index = 0; index < panelCount; index += 1) {
      const panel = panels.nth(index);
      if (!(await panel.isVisible())) continue;
      const panelBox = await panel.boundingBox();
      if (panelBox === null) fail(`${target}: visible dictation panel ${index} has no bounding box`);
      boxes.push(panelBox);
    }
    return {
      left: Math.min(...boxes.map(box => box.x)),
      top: Math.min(...boxes.map(box => box.y)),
      right: Math.max(...boxes.map(box => box.x + box.width)),
      bottom: Math.max(...boxes.map(box => box.y + box.height)),
    };
  };

  let union = await measureUnion();
  if (union.top < 0) {
    // The overlay renders above its anchor, so it can extend above the top of
    // the viewport even once the card itself is scrolled into view. Scroll
    // the extra distance and re-measure against the new scroll position.
    await page.evaluate(deltaY => window.scrollBy(0, deltaY), union.top);
    union = await measureUnion();
  }

  const viewport = page.viewportSize();
  if (viewport === null) fail(`${target}: page has no viewport to clip against`);
  const x = Math.max(0, Math.floor(union.left));
  const y = Math.max(0, Math.floor(union.top));
  const right = Math.min(viewport.width, Math.ceil(union.right));
  const bottom = Math.min(viewport.height, Math.ceil(union.bottom));
  if (right <= x || bottom <= y) fail(`${target}: clipped dictation capture collapsed to an empty rect`);

  await page.screenshot({ path: target, clip: { x, y, width: right - x, height: bottom - y } });
}

mkdirSync(outDir, { recursive: true });

/**
 * The public landing is intentionally outside the React harness: proving that
 * it never loads the app bundle means shooting the real Vite build instead of a
 * component rendition. Keep this narrow mode in the existing harness so it
 * inherits the same loopback-only browser lifecycle and cleanup guarantees.
 */
if (process.argv.includes('--landing-only')) {
  process.stdout.write('📦 building the public landing…\n');
  run('bun', ['run', 'build']);
  const landingDir = join(packageDir, 'dist');
  const landingServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      // A directory is its `index.html`, the way Pages and the release worker resolve `/get-started/`.
      return new Response(Bun.file(join(landingDir, path.endsWith('/') ? `${path}index.html` : path)));
    },
  });
  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) {
    landingServer.stop();
    fail('no system Chrome or Chromium found');
  }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    // Both static pages, at both widths, in both colour schemes: they follow `prefers-color-scheme`
    // alone, so the emulated scheme IS the theme.
    const pages = [
      { name: 'landing', path: '/' },
      { name: 'get-started', path: '/get-started/' },
    ] as const;
    // 360 is the narrowest phone a visitor still has; the fixed-element check runs at every width.
    const landingViewports = [{ name: 'small', width: 360, height: 740 }, ...VIEWPORTS] as const;
    const shots = landingViewports.flatMap(viewport =>
      (['light', 'dark'] as const).flatMap(scheme => pages.map(shot => ({ viewport, scheme, shot }))),
    );
    for (const { viewport, scheme, shot } of shots) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== landingServer.url.origin) {
            await route.abort();
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        await page.goto(new URL(shot.path, landingServer.url).toString());
        const label = `${shot.name} at ${viewport.width}px in ${scheme}`;
        const geometry = await assertFixedElementsClear(page, label);
        process.stdout.write(
          `📐 ${label}: ${geometry.fixedSeen} fixed-element sightings over ${geometry.stops} scroll stops, none collide\n`,
        );
        // A landing that never showed its floating button measured nothing: the check must have had something to check.
        if (shot.name === 'landing' && geometry.fixedSeen === 0)
          fail(`${label}: the floating button was never visible`);
        const target = join(outDir, `${shot.name}-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${shot.name} ${viewport.name} ${scheme} -> ${target}\n`);
        // The bottom of the page as a visitor sees it: the closing buttons with a floating button that must not cover them.
        if (shot.name === 'landing') {
          // Mid-page, where the floating button is up and nothing else is.
          await page.evaluate(() => window.scrollTo(0, window.innerHeight * 2));
          await page.screenshot({ path: join(outDir, `landing-${viewport.name}-${scheme}-floating.png`) });
        } else {
          await page.locator('#agent').scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(outDir, `get-started-${viewport.name}-${scheme}-agent.png`) });
        }
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.screenshot({ path: join(outDir, `${shot.name}-${viewport.name}-${scheme}-bottom.png`) });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    landingServer.stop();
  }
  process.exit(0);
}

process.stdout.write('📦 bundling the harness page…\n');
run('bun', ['build', 'harness/main.tsx', '--outdir', 'harness/out', '--target', 'browser']);

process.stdout.write('🎨 compiling the design system…\n');
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  'harness/out/app.css',
]);

/**
 * THE GALLERY RUNS UNDER THE SHIPPED TRUSTED TYPES RULE (docs/cross-daemon.md §2b). The two directives
 * are read out of `public/_headers`'s app-wide policy rather than restated, and served on the page, so
 * every surface this walk renders writes its markup and registers its workers exactly as the app must
 * under that rule. A violation fails the run below; the rest of the policy is the release worker's and
 * the integration tests', because this harness is not the app's own document.
 */
const TRUSTED_TYPES_POLICY = (() => {
  const policy = /Content-Security-Policy: ([^\n]+)/u.exec(
    readFileSync(join(packageDir, 'public/_headers'), 'utf8'),
  )?.[1];
  const directives = (policy ?? '')
    .split(';')
    .map(directive => directive.trim())
    .filter(directive => directive.startsWith('require-trusted-types-for') || directive.startsWith('trusted-types'));
  if (directives.length !== 2)
    fail('public/_headers no longer names its Trusted Types rule; the harness cannot enforce it');
  return directives.join('; ');
})();
/** The site's whole app-wide policy, read out of `public/_headers`, for the static pages served beside the app. */
const SITE_POLICY = (() => {
  const policy = /Content-Security-Policy: ([^\n]+)/u.exec(
    readFileSync(join(packageDir, 'public/_headers'), 'utf8'),
  )?.[1];
  if (policy === undefined) fail('public/_headers no longer names its app-wide policy');
  return policy;
})();
const trustedTypesViolations: string[] = [];
const watchTrustedTypes = (page: Page): void => {
  page.on('console', message => {
    if (message.type() === 'error' && /Trusted ?Type|TrustedHTML|TrustedScriptURL/u.test(message.text())) {
      trustedTypesViolations.push(message.text());
      process.stderr.write(`⛔ Trusted Types: ${message.text()}\n`);
    }
  });
  page.on('pageerror', error => {
    if (/Trusted ?Type|TrustedHTML|TrustedScriptURL/u.test(error.message)) {
      trustedTypesViolations.push(error.message);
      process.stderr.write(`⛔ Trusted Types: ${error.message}\n`);
    }
  });
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/')
      return new Response(Bun.file(join(harnessDir, 'index.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': TRUSTED_TYPES_POLICY },
      });
    // Served from `public/` rather than copied into `out/`: it is unbundled by design, so the shipped file IS the build.
    if (path === '/pre-paint.js') return new Response(Bun.file(join(packageDir, 'public/pre-paint.js')));
    // The MCP sign-in callback page, served as Pages serves it: the rewrite `public/_redirects` names, under
    // the site's whole app-wide policy, so its words on screen prove its same-origin script ran.
    if (path.startsWith('/oauth/mcp-callback/'))
      return new Response(Bun.file(join(packageDir, 'public/oauth/mcp-callback.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': SITE_POLICY },
      });
    if (path === '/icons/favicon.svg') return new Response(Bun.file(join(packageDir, 'public/icons/favicon.svg')));
    if (path === '/oauth/mcp-callback.js')
      return new Response(Bun.file(join(packageDir, 'public/oauth/mcp-callback.js')), {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    // A 404, never a Response over a file that is not there: Bun answers that with a 500 AND marks the
    // whole process failed, so a stray `/favicon.ico` from Chrome turned a fully green run red at exit.
    const file = Bun.file(join(outDir, path));
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});

try {
  if (process.argv.includes('--serve')) {
    process.stdout.write(`🌐 serving ${server.url} — Ctrl-C to stop\n`);
    await new Promise(() => {});
  }

  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) fail('no system Chrome or Chromium found');

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    for (const viewport of SESSION_LAYOUT_ONLY || SAFE_AREA_ONLY || SESSIONS_PAGE_ONLY || VIEWPORT_MATRIX_ONLY
      ? []
      : SELECTED_VIEWPORTS) {
      const context = await browser.newContext({
        ...(viewport.name === 'mobile'
          ? PHONE_CONTEXT
          : { viewport: { width: viewport.width, height: viewport.height } }),
        colorScheme: SCHEME,
        reducedMotion: 'reduce',
      });
      // Every capture below runs against this one context and page. Closing them
      // in `finally` keeps a single failed locator from leaking a Chromium context
      // for the rest of the run; the browser and the server have the same
      // guarantee one level up, so nothing here can survive a thrown capture.
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) {
            await route.abort();
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        watchTrustedTypes(page);
        try {
          await page.goto(server.url.toString());
          if (SEARCH_ONLY) {
            await captureSessionSearchEvidence(page, viewport, server.url.toString());
            continue;
          }
          if (ATTENTION_ONLY) {
            // Pressing the real strip is the point — this proves the journey (folded line → open
            // panel), not just that the component renders.
            const panel = page.locator('#harness-attention-panel');
            const strip = panel.locator('[data-attention-strip]');
            await strip.scrollIntoViewIfNeeded();
            await strip.click();
            await panel.locator('[data-attention-panel]').waitFor({ state: 'visible' });
            const target = join(outDir, `attention-panel-${viewport.name}.png`);
            await captureElement(page, panel, target);
            process.stdout.write(
              `📸 attention panel ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`,
            );
            continue;
          }
          if (WARDEN_ONLY) {
            // The settings card that carries Jev's per-act bars, then the page whose Recent actions show Jev's own.
            const settings = page.locator('[data-testid="warden-config-card"]:has([data-warden-jev-act])').first();
            await settings.waitFor({ state: 'attached' });
            await settings.scrollIntoViewIfNeeded();
            const settingsTarget = join(outDir, `warden-settings-${SCHEME}-${viewport.name}.png`);
            await captureElement(page, settings, settingsTarget);
            process.stdout.write(`📸 Warden settings ${viewport.name} -> ${settingsTarget}\n`);
            const overview = page.locator('[data-harness="warden-overview"]');
            await overview.scrollIntoViewIfNeeded();
            const pageTarget = join(outDir, `warden-page-${SCHEME}-${viewport.name}.png`);
            await captureElement(page, overview, pageTarget);
            process.stdout.write(`📸 Warden page ${viewport.name} -> ${pageTarget}\n`);
            const overflow = await overview.evaluate(el => el.scrollWidth - el.clientWidth);
            if (overflow > 0) throw new Error(`Warden page scrolls sideways by ${overflow}px on ${viewport.name}`);
            continue;
          }
          if (FILES_ONLY) {
            await captureFiles(page, viewport.name);
            continue;
          }
          if (PAIRING_FAILURES_ONLY) {
            await capturePairingFailures(page, viewport.name);
            continue;
          }
          if (MCP_SIGN_IN_ONLY) {
            await captureMcpSignIn(page, viewport.name);
            continue;
          }
          if (CONTEXT_TOOLS_ONLY) {
            await captureContextTools(page, viewport.name);
            continue;
          }
          if (PAIR_FROM_MENU_ONLY) {
            await capturePairFromMenu(page, viewport.name);
            continue;
          }
          if (WHATS_NEW_ONLY) {
            await captureWhatsNew(page, viewport.name);
            continue;
          }
          if (SESSION_CONTEXT_MENU_ONLY) {
            await captureSessionContextMenu(page, viewport.name);
            continue;
          }
          if (ABOUT_ONLY) {
            await captureAbout(page, viewport.name);
            continue;
          }
          if (AGENT_CLIS_ONLY) {
            await captureAgentClis(page, viewport.name);
            continue;
          }
          if (TASK_BOARD_ONLY) {
            const target = join(outDir, `task-board-${viewport.name}.png`);
            const taskBoard = page.locator('#harness-task-board');
            await taskBoard.scrollIntoViewIfNeeded();
            await captureElement(page, taskBoard, target);
            process.stdout.write(`📸 task board ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);
            continue;
          }
          if (PROJECTS_ONLY) {
            for (const frame of PROJECTS_FRAMES) {
              await page.goto(`${server.url}#projects-${frame}`);
              await page.reload();
              await page.locator(`#harness-projects-${frame}-page`).waitFor({ state: 'visible' });
              // The refusal lives INSIDE the form, beside the entries it promises
              // are still there — so a capture of the closed hub would show none of
              // it. Reproduce the state a reader is actually in: the form open, the
              // draft they typed still in the field, and the daemon's own sentence
              // under it.
              if (frame === 'refused') {
                await page.getByRole('button', { name: 'Add project' }).click();
                await page.locator('[data-add-project-form]').waitFor({ state: 'visible' });
                await page.locator('[data-project-mode="new-folder"]').click();
                await page.getByLabel('Folder to create').fill('/home/pilot/work/deep/nested');
                await page.locator('[data-project-draft-problem]').waitFor({ state: 'hidden' });
              }
              const viewportTarget = join(outDir, `${viewport.name}-projects-${frame}-viewport.png`);
              await page.screenshot({ path: viewportTarget });
              // Production locks html/body to one viewport, which is what the
              // required evidence above must be taken under. Release it only on
              // this standalone document before the supplemental full-page shot,
              // or Chromium measures the whole height and paints one screen.
              const fullTarget = join(outDir, `${viewport.name}-projects-${frame}.png`);
              await page.evaluate(() => {
                document.documentElement.style.height = 'auto';
                document.documentElement.style.overflow = 'auto';
                document.body.style.height = 'auto';
                document.body.style.overflow = 'auto';
              });
              await page.screenshot({ path: fullTarget, fullPage: true });
              process.stdout.write(`📸 ${viewport.name} projects ${frame} -> ${viewportTarget} + ${fullTarget}\n`);
            }

            /**
             * THE FORM, REACHED BY DRIVING IT.
             *
             * Every state below comes from the real controls — the disclosure, the
             * mode radios, the git checkbox — because a posed form proves nothing
             * about the one a reader has to operate, and because the disclosure
             * moving focus into the path field is itself part of what is under
             * review. The two assertions are the point of the pass: a screenshot
             * cannot tell a form that fits from one whose controls are below the
             * thumb floor, and it cannot tell a page that fits from one scrolling
             * sideways off a phone.
             */
            await page.goto(`${server.url}#projects-hub`);
            await page.reload();
            await page.locator('#harness-projects-hub-page').waitFor({ state: 'visible' });
            await page.getByRole('button', { name: 'Add project' }).click();
            await page.locator('[data-add-project-form]').waitFor({ state: 'visible' });

            /**
             * The floor is a POINTER fact, not a viewport fact.
             *
             * `h-control` composes the touch floor itself — `themes.css` resolves
             * it as max(theme height, --target-floor) on a coarse pointer — so the
             * same class is 44px on the phone context above and the theme's own
             * dense 28px on a mouse-driven desktop. Asserting 44px at both widths
             * would therefore fail the design system rather than this form, and
             * hardcoding 44px in the component would delete the density every
             * other panel keeps. WCAG 2.5.8's 24px minimum still applies with a
             * fine pointer, and that is what is checked there.
             */
            const controlFloor = viewport.name === 'mobile' ? TOUCH_TARGET_MINIMUM : 24;

            for (const mode of ['existing-folder', 'new-folder', 'clone'] as const) {
              if (mode !== 'existing-folder') {
                // The LABEL, not the input: the radios are `sr-only`, so the
                // label is the thing with a hit area and the only thing a reader
                // can actually press.
                await page.locator(`[data-project-mode="${mode}"]`).click();
                await page.locator(`[data-project-mode="${mode}"][data-project-mode-selected="true"]`).waitFor();
              }
              // The one destructive option a reader has to opt into, captured
              // CHECKED: an unchecked box proves nothing about the state that
              // runs `git init` on their disk.
              if (mode === 'new-folder') await page.locator('input[type="checkbox"]').check();
              const formTarget = join(outDir, `${viewport.name}-projects-form-${mode}.png`);
              await page.screenshot({ path: formTarget });
              process.stdout.write(`📸 ${viewport.name} projects form ${mode} -> ${formTarget}\n`);

              const geometry = await page.evaluate(minimum => {
                const root = document.documentElement;
                // WHAT IS MEASURED IS THE HIT AREA, not the painted box. An input
                // WRAPPED by its label is pressed anywhere in that label — the
                // `sr-only` radios have no box at all and the git checkbox paints
                // a 16px square — so the label is the control and it is in this
                // set. An input associated only by `for=` has no such stand-in and
                // is measured on its own.
                const controls = [
                  ...document.querySelectorAll<HTMLElement>(
                    '[data-add-project-form] button, [data-add-project-form] label',
                  ),
                  ...[...document.querySelectorAll<HTMLElement>('[data-add-project-form] input')].filter(
                    input => input.closest('label') === null,
                  ),
                ];
                return {
                  scrollWidth: root.scrollWidth,
                  clientWidth: root.clientWidth,
                  undersized: controls
                    .map(element => ({
                      what: element.tagName.toLowerCase() + (element.id === '' ? '' : `#${element.id}`),
                      height: Math.round(element.getBoundingClientRect().height),
                    }))
                    .filter(entry => entry.height > 0 && entry.height < minimum),
                  focused: document.activeElement?.tagName.toLowerCase() ?? null,
                };
              }, controlFloor);

              if (geometry.scrollWidth > geometry.clientWidth) {
                fail(
                  `the ${mode} form made the page scroll horizontally at ${viewport.name} ` +
                    `(${geometry.scrollWidth}px in ${geometry.clientWidth}px)`,
                );
              }
              if (geometry.undersized.length > 0) {
                fail(
                  `the ${mode} form has controls below ${controlFloor}px at ${viewport.name}: ` +
                    geometry.undersized.map(entry => `${entry.what} ${entry.height}px`).join(', '),
                );
              }
              process.stdout.write(
                `   projects form ${mode} @ ${viewport.name}: page scroll x=false focus=${geometry.focused ?? '(none)'}\n`,
              );
            }
            continue;
          }
          if (!SETTINGS_ONLY) {
            const target = join(outDir, `${viewport.name}.png`);
            await page.screenshot({ path: target });
            process.stdout.write(`📸 ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);

            // The gallery bar carries BOTH transient states (reconnecting and an
            // available update). It complements the at-rest workspace bar below
            // and proves that 390px gets a breathing row instead of dropped state.
            const statusTopBarTarget = join(outDir, `top-bar-status-${viewport.name}.png`);
            await captureElement(page, page.locator('[data-density-region="app-bar"]').first(), statusTopBarTarget);
            process.stdout.write(`📸 top bar status ${viewport.name} -> ${statusTopBarTarget}\n`);

            if (viewport.name === 'desktop') {
              const fleetRailTarget = join(outDir, `fleet-navigation-rail-${viewport.name}.png`);
              await captureElement(page, page.getByLabel('Fleet navigation rail preview'), fleetRailTarget);
              process.stdout.write(`📸 fleet navigation rail -> ${fleetRailTarget}\n`);
            }

            // Scoped to its own card: the unified browser surface renders the SAME
            // pane, display and live frame, so a page-wide locator for any of them
            // is ambiguous by design rather than by accident.
            const remoteBrowserCard = page.locator('[data-harness="remote-browser"]');
            const browserTarget = join(outDir, `remote-browser-${viewport.name}.png`);
            await remoteBrowserCard.getByAltText('Live remote browser frame').waitFor({ state: 'visible' });
            await captureElement(page, remoteBrowserCard.getByLabel('Remote browser display'), browserTarget);
            process.stdout.write(`📸 remote browser -> ${browserTarget}\n`);
            // The whole pane, not just the display: the tab strip, address bar and
            // lifecycle controls are the part that has to match the original.
            const browserPaneTarget = join(outDir, `remote-browser-pane-${viewport.name}.png`);
            await captureElement(page, remoteBrowserCard, browserPaneTarget);
            process.stdout.write(`📸 remote browser pane -> ${browserPaneTarget}\n`);

            // The unified surface is captured HERE, beside the standalone pane it
            // embeds and while its display is still live. The harness stream socket
            // is one-shot by design, so a shot taken later in the run would show
            // the honest "stream stalled" state instead of the composition under
            // review.
            const unifiedPreviewTarget = join(outDir, `unified-browser-preview-${viewport.name}.png`);
            await captureElement(page, page.locator('[data-harness="unified-browser-preview"]'), unifiedPreviewTarget);
            process.stdout.write(`📸 Unified browser preview -> ${unifiedPreviewTarget}\n`);

            const unifiedRealCard = page.locator('[data-harness="unified-browser-real"]');
            const unifiedRealTarget = join(outDir, `unified-browser-real-${viewport.name}.png`);
            await unifiedRealCard.getByAltText('Live remote browser frame').waitFor({ state: 'visible' });
            await captureElement(page, unifiedRealCard, unifiedRealTarget);
            process.stdout.write(`📸 Unified browser real engine -> ${unifiedRealTarget}\n`);

            // The engine selector and the escape actions live behind the one ⋯
            // menu, so opening it is the only way to review them. Escape closes it
            // again and returns focus to the trigger, leaving the page as the rest
            // of this pass expects to find it.
            const unifiedMenuTarget = join(outDir, `unified-browser-menu-${viewport.name}.png`);
            await unifiedRealCard.getByLabel('Browser controls').click();
            await unifiedRealCard.getByRole('dialog', { name: 'Browser controls' }).waitFor({ state: 'visible' });
            await captureElement(page, unifiedRealCard, unifiedMenuTarget);
            await page.keyboard.press('Escape');
            await unifiedRealCard.getByRole('dialog', { name: 'Browser controls' }).waitFor({ state: 'hidden' });
            process.stdout.write(`📸 Unified browser controls menu -> ${unifiedMenuTarget}\n`);

            const learningTarget = join(outDir, `learning-${viewport.name}.png`);
            await captureElement(page, page.getByLabel('Learning proposals'), learningTarget);
            process.stdout.write(`📸 learning -> ${learningTarget}\n`);
            const analyticsTarget = join(outDir, `analytics-${viewport.name}.png`);
            await captureElement(page, page.getByLabel('Analytics cost ledger'), analyticsTarget);
            process.stdout.write(`📸 analytics -> ${analyticsTarget}\n`);
            const analyticsResponseTarget = join(outDir, `analytics-response-${viewport.name}.png`);
            await captureElement(page, page.getByLabel('Analytics raw query result'), analyticsResponseTarget);
            process.stdout.write(`📸 analytics response -> ${analyticsResponseTarget}\n`);
            const analyticsSeriesTarget = join(outDir, `analytics-cost-chart-${viewport.name}.png`);
            await captureElement(page, page.getByLabel('Analytics cost chart'), analyticsSeriesTarget);
            process.stdout.write(`📸 analytics cost chart -> ${analyticsSeriesTarget}\n`);
            const globalAnalyticsTarget = join(outDir, `global-analytics-${viewport.name}.png`);
            const globalAnalytics = page.getByRole('main', { name: 'Global analytics' });
            // The production shell correctly locks html/body to one viewport and
            // gives route pages their own scroller. In this harness the route is far
            // down a stacked review page, so Chrome cannot stitch its full scroll
            // area in place on a phone: the top is blank and the tail is clipped.
            // Clone the already-rendered route into the viewport for this one shot.
            // It keeps the exact component DOM/styles while removing only the
            // harness stacking context that no production route has.
            await globalAnalytics.evaluate(element => {
              document.documentElement.style.height = 'auto';
              document.documentElement.style.overflow = 'auto';
              document.body.style.height = 'auto';
              document.body.style.overflow = 'auto';
              document.body.replaceChildren(element.cloneNode(true));
            });
            await captureElement(page, page.getByRole('main', { name: 'Global analytics' }), globalAnalyticsTarget);
            process.stdout.write(`📸 global analytics -> ${globalAnalyticsTarget}\n`);
            // Restore the live React fixture after the static clone; later shots
            // still exercise their real components, refs and async state.
            await page.goto(server.url.toString());
            const sessionAnalyticsTarget = join(outDir, `session-analytics-${viewport.name}.png`);
            const sessionAnalytics = page.getByLabel('Session analytics', { exact: true });
            await sessionAnalytics.locator('[data-session-cost="ready"]').waitFor({ state: 'visible' });
            await captureElement(page, sessionAnalytics, sessionAnalyticsTarget);
            process.stdout.write(`📸 session analytics -> ${sessionAnalyticsTarget}\n`);
            const composerSettingsTarget = join(outDir, `markdown-composer-settings-${viewport.name}.png`);
            await captureElement(page, page.getByLabel('Markdown composer settings'), composerSettingsTarget);
            process.stdout.write(`📸 Markdown composer settings -> ${composerSettingsTarget}\n`);
            const dictationShortcutTarget = join(outDir, `dictation-shortcut-${viewport.name}.png`);
            await captureElement(page, page.getByLabel('Dictation shortcut settings'), dictationShortcutTarget);
            process.stdout.write(`📸 Dictation shortcut settings -> ${dictationShortcutTarget}\n`);
            const dictationPanelTarget = join(outDir, `dictation-panel-${viewport.name}.png`);
            await captureElement(page, page.locator('#harness-dictation-panel'), dictationPanelTarget);
            process.stdout.write(`📸 Dictation panel -> ${dictationPanelTarget}\n`);
            // The input meter fills at 20 fps, one bar per frame, so give a full-width row of bars
            // time to scroll in before the shot; a silent meter is flat from its first frame.
            // The harness runs under reduced motion, which swaps the bars for one level bar: shoot that
            // as it is, then switch to no-preference (the meter follows the media query live) for the bars.
            await page.locator('#harness-dictation-meter').scrollIntoViewIfNeeded();
            const meterReducedTarget = join(outDir, `dictation-input-meter-reduced-motion-${viewport.name}.png`);
            await captureElement(page, page.locator('#harness-dictation-meter'), meterReducedTarget);
            process.stdout.write(`📸 Dictation input meter, reduced motion -> ${meterReducedTarget}\n`);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await page.waitForTimeout(4_000);
            const meterTarget = join(outDir, `dictation-input-meter-${viewport.name}.png`);
            await captureElement(page, page.locator('#harness-dictation-meter'), meterTarget);
            process.stdout.write(`📸 Dictation input meter -> ${meterTarget}\n`);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const liveWordsCard = page.locator('#harness-dictation-live-words');
            const liveWordsSection = liveWordsCard.getByLabel('Live words (experimental)');
            const liveWordsOffTarget = join(outDir, `dictation-live-words-off-${viewport.name}.png`);
            await captureElement(page, liveWordsSection, liveWordsOffTarget);
            process.stdout.write(`📸 Live words (experimental), off by default -> ${liveWordsOffTarget}\n`);
            await liveWordsSection.getByRole('switch').click();
            const liveWordsOnTarget = join(outDir, `dictation-live-words-on-${viewport.name}.png`);
            await captureElement(page, liveWordsSection, liveWordsOnTarget);
            process.stdout.write(`📸 Live words (experimental), switched on -> ${liveWordsOnTarget}\n`);
            await liveWordsSection.getByRole('switch').click();
            const nearLiveTarget = join(outDir, `dictation-near-live-${viewport.name}.png`);
            await captureElement(page, page.locator('#harness-dictation-near-live'), nearLiveTarget);
            process.stdout.write(`📸 Dictation near-live words -> ${nearLiveTarget}\n`);
            // The dictation settings surface is several viewports tall; growing the
            // viewport to fit it is `captureElement`'s job now, and it measures the
            // card rather than guessing a number.
            const dictationSettingsTarget = join(outDir, `dictation-settings-${viewport.name}.png`);
            await captureElement(page, page.locator('#harness-dictation-settings'), dictationSettingsTarget);
            process.stdout.write(`📸 Dictation settings -> ${dictationSettingsTarget}\n`);
            const dictationMicTarget = join(outDir, `dictation-mic-${viewport.name}.png`);
            await captureElement(page, page.locator('#harness-dictation-mic'), dictationMicTarget);
            process.stdout.write(`📸 Dictation mic button -> ${dictationMicTarget}\n`);
            // The live recognition states. Each card opens its own flow at mount
            // against a scripted recognition object, so there is nothing to click
            // and nothing to wait for beyond the stage the card settled into.
            for (const [id, name] of [
              ['harness-dictation-live', 'Dictation live recognition'],
              ['harness-dictation-unavailable', 'Dictation unavailable'],
              ['harness-dictation-permission-denied', 'Dictation permission denied'],
            ] as const) {
              const target = join(outDir, `${id.replace('harness-', '')}-${viewport.name}.png`);
              const card = page.locator(`#${id}`);
              await card.locator('[data-dictation-panel="non-modal"]').first().waitFor({ state: 'visible' });
              await screenshotDictationCard(page, card, target);
              process.stdout.write(`📸 ${name} -> ${target}\n`);
            }
            const notificationSettingsTarget = join(outDir, `notification-settings-${viewport.name}.png`);
            await captureElement(page, page.getByLabel('Notification settings').first(), notificationSettingsTarget);
            process.stdout.write(`📸 Notification settings -> ${notificationSettingsTarget}\n`);
          }

          // Settings gets a production-sized canvas of its own. The gallery card
          // above uses the same SettingsPageHarness component, but the standalone
          // query removes the gallery gutters so these are true 390×844 and
          // 1440×900 responsive captures rather than close approximations.
          const settingsUrl = new URL(server.url);
          settingsUrl.searchParams.set('settings-harness', '1');
          await page.goto(settingsUrl.toString());
          let settingsPage = page.getByLabel('Settings page preview', { exact: true });
          const phone = viewport.name === 'mobile';

          // ONE LEVEL PER SCREEN ON A PHONE: Settings opens on its grouped cards, and each card opens a
          // screen of its own with "‹ Settings" back. A desktop opens on Appearance beside the sidebar.
          const settingsHome = settingsPage.locator('[data-settings-home]');
          const settingsSidebar = settingsPage.locator('[data-settings-sidebar]');
          if (phone) {
            await settingsHome.waitFor({ state: 'visible' });
            // The first screen is a layout of its own — two groups of inset cards on a recessed ground,
            // with machine names as long as a reader cares to type.
            await assertNoSidewaysScroll(page, `the Settings home at ${viewport.name}`);
            const homeTarget = join(outDir, 'settings-home-mobile.png');
            await page.screenshot({ path: homeTarget, animations: 'disabled' });
            process.stdout.write(`📸 Settings home -> ${homeTarget}\n`);
          }
          /** On a phone, back to the grouped cards from whatever screen is open. */
          const settingsBack = async (): Promise<void> => {
            if (!phone || (await settingsHome.isVisible())) return;
            await settingsPage.locator('[data-settings-back]').click();
            await settingsHome.waitFor({ state: 'visible' });
          };
          const settingsNavigation = (): Locator => (phone ? settingsHome : settingsSidebar);
          const selectSettingsSection = async (id: 'appearance' | 'behaviour') => {
            const label = { appearance: 'Appearance', behaviour: 'Behaviour' }[id];
            await settingsBack();
            await settingsNavigation().locator(`[data-settings-section-choice="${id}"]`).click();
            await settingsPage.locator(`[data-settings-section="${id}"]`).waitFor({ state: 'visible' });
            // Rows fade their colours; capture the settled state so the row just left cannot read as selected.
            await settleTransitions(page);
            await assertNoSidewaysScroll(page, `the ${label} section at ${viewport.name}`);
          };
          /** Open one paired machine from the sidebar or the Machines card: the only machine picker now. */
          const openMachine = async (daemonId: string): Promise<Locator> => {
            await settingsBack();
            await settingsNavigation().locator(`[data-settings-machine="${daemonId}"]`).click();
            const surface = settingsPage.locator(`[data-machines-surface="${daemonId}"]`);
            await surface.waitFor({ state: 'visible' });
            await settleTransitions(page);
            return surface;
          };

          if (phone) await selectSettingsSection('appearance');
          else await settingsPage.locator('[data-settings-section="appearance"]').waitFor({ state: 'visible' });

          // Appearance is the section Settings OPENS ON at a desktop, which is the one reason it once went
          // unchecked. It is also the section carrying the theme-family cards, so it has more ways to widen
          // a phone than any other.
          await assertNoSidewaysScroll(page, `the Appearance section at ${viewport.name}`);

          const appearanceTarget = join(outDir, `settings-appearance-${viewport.name}.png`);
          await page.screenshot({ path: appearanceTarget });
          process.stdout.write(`📸 Settings Appearance ${viewport.name} -> ${appearanceTarget}\n`);

          for (const family of ['phosphor', 'blueprint', 'broadsheet', 'wayfinding', 'ledger', 'ma']) {
            const card = settingsPage.locator(`[data-family-card="${family}"]`);
            const target = join(outDir, `theme-${family}-${viewport.name}.png`);
            await captureElement(page, card, target);
            process.stdout.write(`📸 Theme ${family} ${viewport.name} -> ${target}\n`);
          }

          await selectSettingsSection('behaviour');
          const behaviourTarget = join(outDir, `settings-behaviour-${viewport.name}.png`);
          await page.screenshot({ path: behaviourTarget });
          process.stdout.write(`📸 Settings Behaviour ${viewport.name} -> ${behaviourTarget}\n`);

          const composerEnterTarget = join(outDir, `settings-composer-enter-key-${viewport.name}.png`);
          await captureElement(page, settingsPage.locator('#settings-composer-enter-key'), composerEnterTarget);
          process.stdout.write(`📸 Settings composer Enter key ${viewport.name} -> ${composerEnterTarget}\n`);

          // EVERY PAIRED MACHINE IS LISTED BY NAME with its status line, in the sidebar or on the Machines
          // card — Daemons is no longer a section of its own, so this list is where a machine is chosen.
          await settingsBack();
          const listedMachines = await settingsNavigation().locator('[data-settings-machine]').count();
          if (listedMachines !== 4) fail(`settings many-daemon fixture listed ${listedMachines} machines instead of 4`);

          /**
           * One of the machine's connection and security panels — what the Daemons section used to hold —
           * opened from its Machine tab. The list is one card of rows; a row opens its panel as a page of
           * its own with "‹ Machine" back.
           */
          const openDaemonPanel = async (frame: Locator, slug: string): Promise<void> => {
            await frame.locator(`[data-daemon-panel="${slug}"]`).click();
            await frame.locator(`[data-daemon-panel-open="${slug}"]`).waitFor({ state: 'visible' });
          };
          const closeDaemonPanel = async (frame: Locator): Promise<void> => {
            await frame.locator('[data-daemon-panel-back]').click();
            await frame.locator('[data-daemon-panel]').first().waitFor({ state: 'visible' });
          };
          const openMachineTab = async (surface: Locator): Promise<void> => {
            await surface.locator('[data-machine-tab="machine"]').click();
            await surface.locator('[data-machine-tab-panel="machine"]').waitFor({ state: 'visible' });
          };

          const studioMachine = await openMachine('harness-daemon');
          await openMachineTab(studioMachine);
          const wardenFrame = settingsPage.locator('[data-daemon-settings-frame="harness-daemon"]');
          await wardenFrame.locator('[data-daemon-panel]').first().waitFor({ state: 'visible' });
          // The fixture is only evidence about the real frame if it carries the panels the composition
          // root supplies: every app panel but Model pricing, Speed-ups and Learning, which it has never mounted.
          const daemonPanels = await wardenFrame.locator('[data-daemon-panel]').count();
          if (daemonPanels !== 14)
            fail(`settings fixture listed ${daemonPanels} connection and security panels instead of the 14 it mounts`);
          await wardenFrame.scrollIntoViewIfNeeded();
          // Ten rows with a sentence each is the longest list in Settings; if one row widens a phone, it is here.
          await assertNoSidewaysScroll(page, `the connection and security list at ${viewport.name}`);
          const panelListTarget = join(outDir, `settings-machine-panels-${viewport.name}.png`);
          await page.screenshot({ path: panelListTarget, animations: 'disabled' });
          process.stdout.write(`📸 Settings connection and security ${viewport.name} -> ${panelListTarget}\n`);

          // Every panel the daemon owns, in the order the list shows them.
          for (const [label, slug, ready] of [
            // Each waits for SETTLED content, not for a spinner or a refusal:
            // the harness daemon answers `/v1/secrets` in the page, so a capture
            // that still showed "Reading…" or "Failed to fetch" would be a
            // regression to review, not a state to accept.
            // Warden first: it is the first panel the list offers, and its widest content (supervision status,
            // account failover and policy) is exactly what could widen a phone.
            ['Warden', 'warden', '[data-daemon-panel-open="warden"] > *'],
            ['Secrets', 'secrets', '[data-testid="secrets-card"]'],
            // The live panel, inside the frame, because that is where a reader meets it. The gallery
            // cards prove the individual states; this proves it is reachable and fits both widths.
            ['What devices may do', 'grants', '[data-grant-surface="harness-daemon"]'],
            // Adding a device, in the frame, where a reader meets it. The gallery cards below prove the
            // individual states; this proves it is reachable, daemon-scoped and fits both widths.
            ['Add a device', 'devices', '[data-add-device-surface="harness-daemon"]'],
            // Passkeys, daemon-scoped like the panels around it. The fixture answers GET /v1/passkeys with two
            // frozen entries, so the capture shows a real list and the Add control, never a prompt.
            ['Security', 'security', '[data-security-card]'],
            ['Resource limits', 'resource-limits', '[data-testid="cgroup-config-card"]'],
            ['Doctor', 'doctor', '[data-doctor-daemon="harness-daemon"]'],
            // The performance report, recorded: the broken budget first, then both reports as text.
            ['Performance', 'performance', '[data-performance]'],
            // The security log, with a gap warning, both badges and "Show older" on it: its widest rows.
            ['Security log', 'security-log', '[data-security-log-panel]'],
            // The configuration files: an invalid file, a held loosening and a login naming its key by reference.
            ['Files', 'files', '[data-config-files-panel]'],
            // About & updates: the version pair, the install method, the Update button and its changelog.
            ['About & updates', 'about', '#about-machine-heading'],
            // Agent CLIs: each harness's path, install method, verification badge and Update buttons.
            ['Agent CLIs', 'agent-clis', '#agent-clis-heading'],
            ['Carrier', 'carrier', '[data-active-carrier]'],
            ['Host checks', 'host-checks', '[data-daemon-host-checks="harness-daemon"]'],
          ] as const) {
            await openDaemonPanel(wardenFrame, slug);
            const readySurface = wardenFrame.locator(ready).first();
            await readySurface.waitFor({ state: 'visible' });
            // Every panel, at both widths, with its real values on it — this is the one check that
            // catches the widest value in a panel widening the whole page instead of scrolling itself.
            await assertNoSidewaysScroll(page, `the ${label} panel at ${viewport.name}`);
            if (slug === 'security') {
              // THE SETTINGS BLOCK'S TWO SENTENCES, DRIVEN: a loosening a remote phone may not make, and a number
              // past its bounds. Each is the longest unbroken text the block can show, so each is measured.
              const block = wardenFrame.locator('[data-security-settings]');
              await block.scrollIntoViewIfNeeded();
              for (const [field, value, sentence, slugPart] of [
                ['idleExpiryDays', '60', 'Loosening this can only be done at the machine', 'loosen'],
                ['idleExpiryDays', '999', 'Enter a whole number from 1 to 90.', 'bounds'],
              ] as const) {
                await block.locator(`[data-security-input="${field}"]`).fill(value);
                await block.getByText(sentence, { exact: false }).first().waitFor({ state: 'visible' });
                await assertNoSidewaysScroll(page, `the Security settings (${slugPart}) at ${viewport.name}`);
                const settingsTarget = join(outDir, `settings-daemon-security-${slugPart}-${viewport.name}.png`);
                await page.screenshot({ path: settingsTarget });
                process.stdout.write(
                  `📸 Settings daemon Security settings ${slugPart} ${viewport.name} -> ${settingsTarget}\n`,
                );
              }
              await block.locator('[data-security-input="idleExpiryDays"]').fill('30');
            }
            if (slug === 'resource-limits') {
              // Keep a top frame as navigation context, then compose the acceptance frame at the
              // native viewport. The compact two-column mobile editors leave enough room between
              // the enforcement toggle and final warning for BOTH endpoints (and every control
              // between them) to remain in one honest 390x844 screenshot.
              const toggle = readySurface.getByRole('checkbox');
              await toggle.scrollIntoViewIfNeeded();
              const toggleTarget = join(outDir, `settings-daemon-resource-limits-toggle-${viewport.name}.png`);
              await page.screenshot({ path: toggleTarget });
              process.stdout.write(`📸 Settings daemon Resource limits toggle ${viewport.name} -> ${toggleTarget}\n`);

              // Bring the final warning into view, then minimally restore the toggle. If the two
              // endpoints do not fit together, fail instead of silently emitting incomplete proof.
              const warning = readySurface.getByRole('alert').last();
              await warning.waitFor({ state: 'visible' });
              await warning.scrollIntoViewIfNeeded();
              await toggle.scrollIntoViewIfNeeded();
              const [toggleBox, warningBox] = await Promise.all([toggle.boundingBox(), warning.boundingBox()]);
              const frameHeight = page.viewportSize()?.height;
              if (
                toggleBox === null ||
                warningBox === null ||
                frameHeight === undefined ||
                toggleBox.y < 0 ||
                warningBox.y + warningBox.height > frameHeight
              )
                throw new Error(`resource-limit evidence does not fit in the ${viewport.name} viewport`);
            }
            if (slug === 'performance') {
              // Idle first (the one button), then a recording run to its report: the report text is the widest
              // thing the panel shows, and it must scroll inside its box rather than widen a phone.
              const idleTarget = join(outDir, `settings-daemon-performance-idle-${viewport.name}.png`);
              await page.screenshot({ path: idleTarget });
              process.stdout.write(`📸 Settings daemon Performance idle ${viewport.name} -> ${idleTarget}\n`);
              await readySurface.locator('[data-performance-record]').click();
              const report = readySurface.locator('[data-performance-report]');
              await report.waitFor({ state: 'visible' });
              await assertNoSidewaysScroll(page, `the Performance report at ${viewport.name}`);
              await readySurface.evaluate(element => element.scrollIntoView({ block: 'start' }));
            }
            // The Files panel's evidence is its head — where the files are, what waits and what is wrong — so
            // its frame starts there rather than wherever the previous panel left the page scrolled.
            if (slug === 'files') await readySurface.evaluate(element => element.scrollIntoView({ block: 'start' }));
            const target = join(outDir, `settings-daemon-${slug}-${viewport.name}.png`);
            await page.screenshot({ path: target });
            process.stdout.write(`📸 Settings daemon ${label} ${viewport.name} -> ${target}\n`);
            if (slug === 'files') {
              // EDIT AS YAML, SAVED AND REFUSED: the invalid file's located issues inline under the editor,
              // reached by pressing Save, because the issue rows are the widest thing the sheet can show.
              await readySurface.locator('[data-config-edit="warden.yaml"]').click();
              const editor = page.locator('[data-bottom-sheet="config-file-editor"]');
              await editor.locator('[data-config-editor-text]').waitFor({ state: 'visible' });
              await editor.locator('[data-config-submit]').click();
              const refused = editor.locator('[data-config-save="invalid"]');
              await refused.waitFor({ state: 'visible' });
              await refused.scrollIntoViewIfNeeded();
              await assertNoSidewaysScroll(page, `the Edit as YAML sheet at ${viewport.name}`);
              const editTarget = join(outDir, `settings-daemon-files-edit-${viewport.name}.png`);
              await page.screenshot({ path: editTarget, animations: 'disabled' });
              process.stdout.write(`📸 Settings daemon Files edit ${viewport.name} -> ${editTarget}\n`);
              await editor.locator('[data-config-cancel]').click();
              await editor.waitFor({ state: 'detached' });
            }
            if (slug === 'devices') {
              // The per-device capability switches: seven rows by two axes, the longest block this panel
              // can grow, with a blocked widen's reason and host command beside its switch. Opened on the
              // first device (the browser doing the looking, holding fleet.use alone), because a closed
              // disclosure hides exactly the content that could widen a phone.
              const disclosure = readySurface.locator('[data-device-capabilities]').first();
              await disclosure.locator('summary').click();
              await disclosure.locator('[data-device-capability="secrets"]').waitFor({ state: 'visible' });
              await disclosure.locator('[data-device-grant-reason]').first().waitFor({ state: 'visible' });
              await assertNoSidewaysScroll(page, `the open device capabilities at ${viewport.name}`);
              const capabilitiesTarget = join(outDir, `settings-daemon-devices-capabilities-${viewport.name}.png`);
              await disclosure.scrollIntoViewIfNeeded();
              await page.screenshot({ path: capabilitiesTarget });
              process.stdout.write(
                `📸 Settings daemon device capabilities ${viewport.name} -> ${capabilitiesTarget}\n`,
              );
            }
            await closeDaemonPanel(wardenFrame);
          }

          const unreachableMachine = await openMachine('unreachable-daemon');
          await openMachineTab(unreachableMachine);
          const unavailableWardenFrame = settingsPage.locator('[data-daemon-settings-frame="unreachable-daemon"]');
          await openDaemonPanel(unavailableWardenFrame, 'warden');
          await unavailableWardenFrame.getByLabel('Warden settings unavailable').waitFor({ state: 'visible' });
          // A FAILURE STATE IS A LAYOUT, not an absence of one. These two frames explain why a panel
          // could not be read, and the sentences that do the explaining are the longest unbroken text
          // in Settings — an unwrapped URL or daemon id in one of them widens the page exactly as a
          // healthy panel's widest value would, and it does it on the screen a reader is already
          // having a bad time on.
          await assertNoSidewaysScroll(page, `the unavailable daemon's Warden panel at ${viewport.name}`);
          const unavailableWardenTarget = join(outDir, `settings-daemon-warden-unavailable-${viewport.name}.png`);
          await page.screenshot({ path: unavailableWardenTarget });
          process.stdout.write(
            `📸 Settings unavailable daemon Warden ${viewport.name} -> ${unavailableWardenTarget}\n`,
          );
          await closeDaemonPanel(unavailableWardenFrame);

          // The unavailable pairing must not borrow the healthy daemon's
          // measured relay. Capture its own failed direct + relay evidence so
          // that daemon scoping is reviewable in pixels, not only in fixture code.
          await openDaemonPanel(unavailableWardenFrame, 'carrier');
          await unavailableWardenFrame.locator('[data-active-carrier]').waitFor({ state: 'visible' });
          await assertNoSidewaysScroll(page, `the unavailable daemon's Carrier panel at ${viewport.name}`);
          const unavailableCarrierTarget = join(outDir, `settings-daemon-carrier-unavailable-${viewport.name}.png`);
          await page.screenshot({ path: unavailableCarrierTarget });
          process.stdout.write(
            `📸 Settings unavailable daemon Carrier ${viewport.name} -> ${unavailableCarrierTarget}\n`,
          );

          const currentMachine = await openMachine('harness-daemon');
          await openMachineTab(currentMachine);
          const currentFrame = settingsPage.locator('[data-daemon-settings-frame="harness-daemon"]');
          await openDaemonPanel(currentFrame, 'host-checks');
          const currentDaemon = currentFrame.locator('[data-daemon-host-checks="harness-daemon"]');
          await currentDaemon.locator('[data-daemon-reachability="reachable"]').waitFor({ state: 'visible' });
          await currentDaemon.getByText('Manage daemon', { exact: true }).click();
          await currentDaemon.getByText('Removing this pairing only forgets it in this browser.').waitFor({
            state: 'visible',
          });
          const removalTarget = join(outDir, `settings-removal-disclosure-${viewport.name}.png`);
          await page.screenshot({ path: removalTarget });
          process.stdout.write(`📸 Settings removal disclosure ${viewport.name} -> ${removalTarget}\n`);

          // MACHINES (account model, O1): the section, each of its five tabs, and the Machines list the
          // switcher opens. The tab row is five equal columns, which is the
          // shape most likely to widen a 390px phone once a label is longer than its cell. A tab is waited
          // for by its PANEL, so a tab that a unit has filled is walked exactly like an empty frame.
          //
          // EVERY MACHINES FRAME IS ALSO A GEOMETRY CHECK (`assertMachinesGeometry`), and every capture here
          // is taken with transitions finished. The tabs fade their colours, and a capture taken the instant
          // a tab is clicked shows the one just left still selected: measured, 12 of 12 such captures carried
          // the old tab's accent label, and 0 of 12 with `animations: 'disabled'`.
          const settledShot = (target: string) => page.screenshot({ path: target, animations: 'disabled' });
          const machinesSurface = await openMachine('harness-daemon');
          await machinesSurface.locator('[data-machine-tab-panel="runtimes"]').waitFor({ state: 'visible' });
          await assertMachinesGeometry(page, `the Machines runtimes tab at ${viewport.name}`);
          for (const tab of ['credentials', 'profiles', 'components', 'machine'] as const) {
            await machinesSurface.locator(`[data-machine-tab="${tab}"]`).click();
            await machinesSurface.locator(`[data-machine-tab-panel="${tab}"]`).waitFor({ state: 'visible' });
            await assertNoSidewaysScroll(page, `the Machines ${tab} tab at ${viewport.name}`);
            await assertMachinesGeometry(page, `the Machines ${tab} tab at ${viewport.name}`);
          }
          await machinesSurface.locator('[data-machine-settings]').waitFor({ state: 'visible' });
          const machinesTarget = join(outDir, `settings-machines-${viewport.name}.png`);
          await settledShot(machinesTarget);
          process.stdout.write(`📸 Settings Machines ${viewport.name} -> ${machinesTarget}\n`);

          // THE SETTINGS TAB'S FLOWS (U19): five more checks per viewport, one per layout that differs —
          // Import again's "Found on" list with its long values, its Name step with a duplicate card, the
          // Clone source list with both disabled reasons (E27), the Clone preview's "Runs on" review, and
          // Install with its exact command.
          const machineFrame = async (what: string, file: string): Promise<void> => {
            await assertMachinesGeometry(page, `the Machines ${what} at ${viewport.name}`);
            const target = join(outDir, `settings-machines-${file}-${viewport.name}.png`);
            await settledShot(target);
            process.stdout.write(`📸 Settings Machines ${what} ${viewport.name} -> ${target}\n`);
            await assertNoSidewaysScroll(page, `the Machines ${what} at ${viewport.name}`);
          };
          const backToSettingsTab = async (): Promise<void> => {
            await machinesSurface.locator('[data-machine-tab="machine"]').click();
            await machinesSurface.locator('[data-machine-settings]').waitFor({ state: 'visible' });
          };
          // Import again is New machine setup's Claude Code step, full screen: it is walked with the setup below.
          await machinesSurface.locator('[data-settings-action="clone"]').click();
          await machinesSurface.locator('[data-clone-source-reason]').nth(1).waitFor({ state: 'visible' });
          await machineFrame('Clone source', 'clone-source');
          {
            const target = join(outDir, `settings-machines-clone-source-step-${SCHEME}-${viewport.name}.png`);
            await captureElement(page, machinesSurface.locator('[data-clone-step="source"]'), target);
            process.stdout.write(`📸 Settings Machines clone source step ${viewport.name} -> ${target}\n`);
          }
          // The Preview from a machine that can be copied: every command the copy would run here, in words,
          // each with its box (docs/cross-daemon.md §3a). Its long command lines are the 390px risk.
          await machinesSurface.locator('[data-setup-choice="clone-source-daemon"]').click();
          await machinesSurface.locator('[data-clone-step="source"] [data-step-next]').click();
          await machinesSurface.locator('[data-setup-section="runs"]').waitFor({ state: 'visible' });
          await machineFrame('Clone preview', 'clone-preview');
          // The "Runs on" review and the source step's sentence, as elements: both run below the fold.
          // One panel at a time: the whole review is taller than a phone screen.
          for (const [selector, file] of [
            ['[data-setup-note="runs-warning"]', 'clone-runs-warning'],
            ['[data-clone-runnable="mcp/notes"]', 'clone-runs-mcp'],
            ['[data-clone-runnable="hooks/guard"]', 'clone-runs-hook'],
            ['[data-clone-runnable="settings/claude"]', 'clone-runs-settings'],
          ] as const) {
            const element = machinesSurface.locator(selector);
            if (selector.includes('hooks/guard')) await element.locator('summary').click();
            const target = join(outDir, `settings-machines-${file}-${SCHEME}-${viewport.name}.png`);
            await captureElement(page, element, target);
            process.stdout.write(`📸 Settings Machines ${file} ${viewport.name} -> ${target}\n`);
          }
          await backToSettingsTab();
          // By its address: the shared machine data lists only Claude Code, and the flow is linkable anyway.
          await page.evaluate(() => {
            window.location.hash = `#machines/${encodeURIComponent('Studio workstation')}/machine/install-codex`;
          });
          await machinesSurface.locator('[data-install-flow="codex"]').waitFor({ state: 'visible' });
          await machineFrame('Install Codex', 'install');
          await backToSettingsTab();
          // THE MACHINES LIST is the sidebar on a desktop and the Machines card on a phone — one picker, with
          // every machine's name and status line on it.
          await settingsBack();
          await assertNoSidewaysScroll(page, `the Machines list at ${viewport.name}`);
          // On a phone the list is its own screen, outside any machine, so there is no machine layout to measure.
          if (!phone) await assertMachinesGeometry(page, `the Machines list at ${viewport.name}`);
          const machinesListTarget = join(outDir, `settings-machines-list-${viewport.name}.png`);
          await settledShot(machinesListTarget);
          process.stdout.write(`📸 Settings Machines list ${viewport.name} -> ${machinesListTarget}\n`);

          // RUNTIMES AND CREDENTIALS (account model U17): ten pages per viewport — the two lists, a runtime
          // with its fixed layer, one whose model set has models this login cannot use, the three Add a
          // runtime decisions, a login that needs sign-in, its sign-in link, and a sign-out confirmation.
          // (The captures share the helper below.)
          // PROFILES AND COMPONENTS (account model U18): twelve pages per viewport, each one a different
          // layout — a layer stack, a conflict sentence with a dotted key, a delete card, a stepper with a
          // reorder list, a component's badges and a path long enough to wrap. Every one has to fit 390px.
          // `framed` runs after the checks and before the capture: the geometry check hovers a tab, which
          // scrolls the page back to it, so a frame that needs a lower part of the page in view says so here.
          /** One full-screen setup frame: it fits, its stepper and its pinned footer are where they belong. */
          const setupShot = async (name: string, label: string): Promise<void> => {
            await assertNoSidewaysScroll(page, `the setup ${label} at ${viewport.name}`);
            await assertSetupGeometry(page, `the setup ${label} at ${viewport.name}`);
            const target = join(outDir, `setup-${name}-${viewport.name}.png`);
            await settledShot(target);
            process.stdout.write(`📸 Setup ${label} ${viewport.name} -> ${target}\n`);
          };
          const accountShot = async (name: string, label: string, framed?: () => Promise<void>): Promise<void> => {
            await assertNoSidewaysScroll(page, `the Machines ${label} at ${viewport.name}`);
            await assertMachinesGeometry(page, `the Machines ${label} at ${viewport.name}`);
            await framed?.();
            const target = join(outDir, `settings-machines-${name}-${viewport.name}.png`);
            await settledShot(target);
            process.stdout.write(`📸 Settings Machines ${label} ${viewport.name} -> ${target}\n`);
          };
          // PROFILE SCOPE (P7) IN OTHER THEME FAMILIES: the list's scope badges and the Add runtime picker
          // below are the frames a new badge tone could make illegible, so they are also captured in two
          // more families. Evidence only: the geometry gate above already measured this layout.
          const themedShot = async (name: string): Promise<void> => {
            const initial = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
            for (const theme of PROFILE_SCOPE_THEMES) {
              await applyTheme(page, theme);
              const target = join(outDir, `settings-machines-${name}-${theme}-${viewport.name}.png`);
              await settledShot(target);
              process.stdout.write(`📸 Settings Machines ${name} ${theme} ${viewport.name} -> ${target}\n`);
            }
            // Settled, not just set: the step after this one clicks, and on the old layout it can miss.
            await applyTheme(page, initial);
          };
          await openMachine('harness-daemon');
          await machinesSurface.locator('[data-machine-tab="runtimes"]').click();
          const runtimesPanel = machinesSurface.locator('[data-machine-tab-panel="runtimes"]');
          await runtimesPanel.locator('[data-runtime-row="claude-agent"]').waitFor({ state: 'visible' });
          await accountShot('runtimes', 'Runtimes list');
          await runtimesPanel.locator('[data-runtime-row="claude-agent"]').click();
          await runtimesPanel.locator('[data-runtime-fixed-layer]').waitFor({ state: 'visible' });
          await accountShot('runtime-agent', 'agent runtime page');
          await runtimesPanel.locator('[data-page-back]').click();
          await runtimesPanel.locator('[data-runtime-row="codex-default"]').click();
          await runtimesPanel.locator('[data-runtime-models]').waitFor({ state: 'visible' });
          await accountShot('runtime-models', 'runtime page with unavailable models');
          await runtimesPanel.locator('[data-page-back]').click();
          // RENAME AND REMOVE (docs/account-model.md "Renaming and removing a runtime"): each row's buttons open a
          // dialog — a bottom sheet on a phone, centred on a desktop — that must fit with its confirm button in
          // view: Rename with a new name typed, Remove listing the ferrets on it with a move picked, and the
          // machine's default runtime, which asks for another default first.
          const dialogShot = async (name: string, label: string): Promise<void> => {
            await page.locator('[data-runtime-dialog]').waitFor({ state: 'visible' });
            await assertNoSidewaysScroll(page, `the ${label} dialog at ${viewport.name}`);
            await assertRuntimeDialogGeometry(page, `the ${label} dialog at ${viewport.name}`);
            const target = join(outDir, `settings-machines-${name}-${viewport.name}.png`);
            await settledShot(target);
            process.stdout.write(`📸 Settings Machines ${label} ${viewport.name} -> ${target}\n`);
            await page.locator('[data-runtime-dialog-cancel]').click();
            await page.locator('[data-runtime-dialog]').waitFor({ state: 'detached' });
          };
          await runtimesPanel.locator('[data-runtime-rename="claude-work"]').click();
          await page.locator('[data-runtime-rename-input]').fill('claude-office');
          await dialogShot('runtime-rename', 'Rename runtime');
          await runtimesPanel.locator('[data-runtime-remove="codex-default"]').click();
          await page.locator('[data-runtime-running]').waitFor({ state: 'visible' });
          await page.locator('[data-runtime-move-target]').selectOption('claude-agent');
          await dialogShot('runtime-remove', 'Remove runtime');
          await runtimesPanel.locator('[data-runtime-remove="claude-default"]').click();
          await page.locator('[data-runtime-default-picker]').waitFor({ state: 'visible' });
          await dialogShot('runtime-remove-default', 'Remove the default runtime');
          // ADD A RUNTIME IS ONE FORM: login, profile and name on one page, each frame scrolled to its part.
          const toPart = (part: string) => async (): Promise<void> => {
            await runtimesPanel
              .locator(`[data-add-runtime-part="${part}"]`)
              .evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
          };
          await runtimesPanel.locator('[data-add-runtime]').click();
          await runtimesPanel.locator('[data-add-runtime-credential="claude-personal"]').click();
          await accountShot('add-runtime-credential', 'Add a runtime, login picked');
          await runtimesPanel.locator('[data-add-runtime-profile="Default"]').click();
          await runtimesPanel.locator('[data-add-runtime-duplicate]').waitFor({ state: 'visible' });
          await accountShot('add-runtime-profile', 'Add a runtime, profile with a duplicate', toPart('profile'));
          await themedShot('add-runtime-profile');
          await runtimesPanel.locator('[data-duplicate-ok]').check();
          await runtimesPanel.locator('#add-runtime-name').fill('claude-default');
          await runtimesPanel.locator('[data-runtime-name-problem]').waitFor({ state: 'visible' });
          await accountShot('add-runtime-name', 'Add a runtime, a name that clashes', toPart('name'));
          // "+ Add a new login" opens IN PLACE under the list: no stepper of its own.
          await runtimesPanel.locator('[data-add-row="login"]').click();
          await runtimesPanel.locator('[data-add-runtime-new-login]').waitFor({ state: 'visible' });
          await accountShot('add-runtime-new-login', 'Add a runtime, a new login in place', async () => {
            await runtimesPanel
              .locator('[data-add-runtime-new-login]')
              .evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
          });
          await runtimesPanel.locator('[data-add-runtime-new-login-close]').click();
          await runtimesPanel.locator('[data-page-back]').click();

          await machinesSurface.locator('[data-machine-tab="credentials"]').click();
          const credentialsPanel = machinesSurface.locator('[data-machine-tab-panel="credentials"]');
          await credentialsPanel.locator('[data-credential-row="claude-team"]').waitFor({ state: 'visible' });
          await accountShot('credentials', 'Credentials list');
          // An environment login's own page, with the quota its provider reported (docs/provider-quotas.md).
          await credentialsPanel.locator('[data-credential-row="glm-env"]').click();
          await credentialsPanel.locator('[data-provider-quota="endpoint"]').waitFor({ state: 'visible' });
          await accountShot('credential-provider-quota', 'environment login quota');
          await credentialsPanel.locator('[data-page-back]').click();
          await credentialsPanel.locator('[data-credential-row="claude-team"]').waitFor({ state: 'visible' });
          await credentialsPanel.locator('[data-credential-row="claude-team"]').click();
          await credentialsPanel.locator('[data-credential-sign-in="start"]').waitFor({ state: 'visible' });
          await accountShot('credential-slot', 'empty login page');
          await credentialsPanel.locator('[data-credential-sign-in="start"] [data-change-submit]').click();
          await credentialsPanel.locator('[data-credential-sign-in="awaiting-code"]').waitFor({ state: 'visible' });
          await accountShot('credential-sign-in', 'login sign-in link');
          await credentialsPanel.locator('[data-page-back]').click();
          // A SIGN-IN ALREADY RUNNING is picked up, never an error naming a flow: the second start lands
          // on the same link, says so, and offers Start over.
          await credentialsPanel.locator('[data-credential-row="claude-team"]').click();
          await credentialsPanel.locator('[data-credential-sign-in="start"] [data-change-submit]').click();
          await credentialsPanel.locator('[data-sign-in-resumed]').waitFor({ state: 'visible' });
          const resumedText = await credentialsPanel.locator('[data-credential-sign-in]').innerText();
          if (/flow|fy_daemon_/u.test(resumedText)) fail('the picked-up sign-in shows an internal id');
          await accountShot('credential-sign-in-resumed', 'login sign-in picked up');
          await credentialsPanel.locator('[data-sign-in-start-over]').click();
          await credentialsPanel.locator('[data-sign-in-resumed]').waitFor({ state: 'detached' });
          await credentialsPanel.locator('[data-page-back]').click();
          // CODEX'S TWO SIGN-INS (S2): the device code with its "didn't work?" way out, the link sign-in
          // that asks for the address a phone's browser could not load, and the wait after it is pasted.
          // Each frame starts at the Codex panel, because on a phone its steps sit below the fold.
          const codexPanelToTop = async (): Promise<void> => {
            await credentialsPanel
              .locator('[data-codex-login]')
              .evaluate(panel => panel.scrollIntoView({ block: 'start', behavior: 'instant' }));
          };
          await credentialsPanel.locator('[data-credential-row="codex-team"]').click();
          await credentialsPanel.locator('[data-credential-sign-in="start"] [data-change-submit]').click();
          await credentialsPanel.locator('[data-credential-sign-in="awaiting-approval"]').waitFor({ state: 'visible' });
          await accountShot('codex-device-code', 'Codex device code', codexPanelToTop);
          await credentialsPanel.locator('[data-codex-login-use-link] button').click();
          await credentialsPanel.locator('[data-credential-sign-in="awaiting-callback"]').waitFor({ state: 'visible' });
          await accountShot('codex-link', 'Codex link sign-in', codexPanelToTop);
          // START OVER with the callback port held by somebody else's program: named, and left alone.
          await credentialsPanel.locator('[data-sign-in-start-over]').click();
          await credentialsPanel.locator('[data-credential-sign-in="failed"]').waitFor({ state: 'visible' });
          await accountShot('codex-port-held', 'Codex callback port held', codexPanelToTop);
          await credentialsPanel
            .locator('[data-credential-sign-in="failed"] button:has-text("Start a new sign-in")')
            .click();
          await credentialsPanel.locator('[data-credential-sign-in="start"] [data-change-submit]').click();
          await credentialsPanel.locator('[data-credential-sign-in="awaiting-callback"]').waitFor({ state: 'visible' });
          await credentialsPanel
            .locator('textarea[name="codex-login-address"]')
            .fill('http://localhost:1455/auth/callback?code=harness-preview&state=harness-preview');
          await credentialsPanel.locator('[data-credential-sign-in="awaiting-callback"] button[type="submit"]').click();
          await credentialsPanel.locator('[data-credential-sign-in="finishing"]').waitFor({ state: 'visible' });
          await accountShot('codex-finishing', 'Codex finishing', codexPanelToTop);
          await credentialsPanel.locator('[data-credential-sign-in="finishing"] button:has-text("Cancel")').click();
          await credentialsPanel.locator('[data-page-back]').click();
          await credentialsPanel.locator('[data-credential-row="claude-personal"]').click();
          await credentialsPanel.locator('[data-credential-sign-out-ask]').click();
          await credentialsPanel.locator('[data-credential-sign-out]').scrollIntoViewIfNeeded();
          await accountShot('credential-sign-out', 'sign-out confirmation');
          await credentialsPanel.locator('[data-sign-out-keep]').click();
          await credentialsPanel.locator('[data-page-back]').click();
          // REMOVE A LOGIN: the Remove button on a row opens a dialog that shows its impact first — a login nobody
          // uses; one used by two runtimes with "switch to" chosen (the default); and the same with the
          // runtime removed too, which lists the ferrets on it with a move picker. Each must fit with its confirm
          // button whole and in view. The login's own page carries the same button beside the sign-out difference.
          const loginDialogShot = async (name: string, label: string): Promise<void> => {
            await page
              .locator('[data-runtime-dialog="remove-login"] [data-login-remove-impact]')
              .waitFor({ state: 'visible' });
            await assertNoSidewaysScroll(page, `the ${label} dialog at ${viewport.name}`);
            await assertRuntimeDialogGeometry(page, `the ${label} dialog at ${viewport.name}`);
            const target = join(outDir, `settings-machines-${name}-${viewport.name}.png`);
            await settledShot(target);
            process.stdout.write(`📸 Settings Machines ${label} ${viewport.name} -> ${target}\n`);
          };
          const closeLoginDialog = async (): Promise<void> => {
            await page.locator('[data-runtime-dialog-cancel]').click();
            await page.locator('[data-runtime-dialog]').waitFor({ state: 'detached' });
          };
          await credentialsPanel.locator('[data-credential-remove="codex-team"]').click();
          await loginDialogShot('login-remove-unused', 'Remove a login nobody uses');
          await closeLoginDialog();
          await credentialsPanel.locator('[data-credential-remove="claude-work"]').click();
          await loginDialogShot('login-remove-switch', 'Remove a login used by two runtimes, switching them');
          await page.locator('[data-login-remove-runtime-too="claude-review"]').click();
          await page.locator('[data-login-remove-ferrets]').waitFor({ state: 'visible' });
          await page.locator('[data-runtime-move-target]').selectOption('claude-default');
          await loginDialogShot('login-remove-runtime', 'Remove a login, removing a runtime too');
          await closeLoginDialog();
          await credentialsPanel.locator('[data-credential-row="claude-work"]').click();
          await credentialsPanel.locator('[data-credential-remove-zone]').waitFor({ state: 'visible' });
          await accountShot('credential-remove-zone', 'login page Remove', async () => {
            await credentialsPanel
              .locator('[data-credential-remove-zone]')
              .evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
          });
          await credentialsPanel.locator('[data-page-back]').click();
          // ADD A LOGIN (U21): ONE screen — every provider as tiles (the two sign-ins, then the API-key
          // providers under their headings, two to a row on a phone, with the search box thirteen providers
          // earn), then only what the one tapped needs: a provider's key, or a sign-in and its one button.
          await credentialsPanel.locator('[data-add-login]').first().click();
          await credentialsPanel.locator('[data-add-login-choices]').waitFor({ state: 'visible' });
          await credentialsPanel.locator('[data-provider-search]').waitFor({ state: 'visible' });
          await accountShot('add-login-tool', 'Add a login provider choice');
          // Each frame starts where the new part does, because on a phone the sign-in tiles fill the top.
          const toTop = (selector: string) => async (): Promise<void> => {
            await credentialsPanel
              .locator(selector)
              .evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
          };
          await accountShot('add-login-providers', 'Add a login provider tiles', toTop('[data-provider-grid]'));
          await themedShot('add-login-providers');
          await credentialsPanel.locator('[data-provider-tile="deepseek"]').click();
          await credentialsPanel.locator('[data-one-click="deepseek"]').waitFor({ state: 'visible' });
          await accountShot('add-login-provider-key', 'Add a login provider key', toTop('[data-add-login-chosen]'));
          await credentialsPanel.locator('[data-add-login-change]').click();
          await credentialsPanel.locator('[data-add-login-choice]:not([aria-disabled])').first().click();
          await credentialsPanel.locator('[data-add-login-fields]').waitFor({ state: 'visible' });
          await accountShot('add-login-start', 'Add a login sign-in');
          await credentialsPanel.locator('[data-add-login-back]').click();
          const stopAddLogin = credentialsPanel.locator('[data-add-login-stop]');
          if ((await stopAddLogin.count()) > 0) await stopAddLogin.click();
          await credentialsPanel.locator('[data-credential-row="claude-team"]').waitFor({ state: 'visible' });

          // THE PAIRING A RESET LEFT BEHIND: same name, same address. It is called the old pairing and
          // offers Remove; the live one keeps its plain name. No fingerprint is shown on either.
          const oldPairing = await openMachine('harness-daemon-before-reset');
          await oldPairing.locator('[data-machine-replaced]').waitFor({ state: 'visible' });
          const oldHeading = await oldPairing.locator('#settings-machine-heading').innerText();
          if (oldHeading !== 'Studio workstation (old pairing)') fail(`the old pairing reads "${oldHeading}"`);
          await accountShot('old-pairing', 'old pairing');
          await openMachine('harness-daemon');
          const liveHeading = await machinesSurface.locator('#settings-machine-heading').innerText();
          if (liveHeading !== 'Studio workstation') fail(`the live pairing reads "${liveHeading}"`);

          await machinesSurface.locator('[data-machine-tab="profiles"]').click();
          const profilesPanel = machinesSurface.locator('[data-machine-tab-panel="profiles"]');
          await profilesPanel.locator('[data-profile-row="Default"]').waitFor({ state: 'visible' });
          await accountShot('profiles', 'Profiles list');
          await themedShot('profiles');
          await profilesPanel.locator('[data-profile-row="Default"]').click();
          await profilesPanel
            .locator('[data-profile-editor="Default"] [data-profile-item]')
            .first()
            .waitFor({ state: 'visible' });
          await accountShot('profile', 'profile page');
          await themedShot('profile');
          await profilesPanel.locator('[data-profile-delete]').click();
          await profilesPanel.locator('[data-catalog-note="delete"]').scrollIntoViewIfNeeded();
          await accountShot('profile-delete', 'profile delete card');
          await profilesPanel.locator('[data-profile-keep]').click();
          // Mixing tools is refused on drop (or on Add), naming the items to blame (R5).
          if (viewport.name === 'mobile') {
            await profilesPanel.locator('[data-profile-pick]').click();
            const picker = page.locator('[data-profile-picker]');
            await picker.locator('[data-library-add="profile/Codex"]').click();
            await picker.locator('[data-catalog-note="picker-refused"]').waitFor({ state: 'visible' });
            await accountShot('profile-refused', 'profile refusing a mix in the picker');
            await picker.locator('[data-picker-done]').click();
            await picker.waitFor({ state: 'detached' });
          } else {
            await profilesPanel.locator('[data-library-add="profile/Codex"]').click();
            await profilesPanel.locator('[data-catalog-note="refused"]').waitFor({ state: 'visible' });
            await accountShot('profile-refused', 'profile refusing a mix');
            await profilesPanel.locator('[data-refusal-dismiss]').click();
          }
          await profilesPanel.locator('[data-catalog-back]').click();
          // Agent work: Agent comes later than Default, so it overrides one key — the chip and Resolved.
          await profilesPanel.locator('[data-profile-row="Agent work"]').click();
          await profilesPanel.locator('[data-override-chip]').first().waitFor({ state: 'visible' });
          await accountShot('profile-overrides', 'profile contents with an override chip');
          await themedShot('profile-overrides');
          await profilesPanel.locator('[data-profile-view="resolved"]').click();
          await profilesPanel.locator('[data-resolved-overridden]').first().waitFor({ state: 'visible' });
          await accountShot('profile-resolved', 'profile Resolved view');
          await themedShot('profile-resolved');
          await profilesPanel.locator('[data-profile-yaml]').click();
          await page.locator('[data-config-editor-text]').waitFor({ state: 'visible' });
          await accountShot('profile-yaml', 'profile Edit as YAML');
          await page.locator('[data-config-cancel]').click();
          await page.locator('[data-config-editor]').waitFor({ state: 'detached' });
          await profilesPanel.locator('[data-catalog-back]').click();
          await profilesPanel.locator('[data-profile-row="Old mix"]').click();
          await profilesPanel.locator('[data-catalog-note="mixed"]').waitFor({ state: 'visible' });
          await accountShot('profile-mixed', 'mixed profile page');
          await profilesPanel.locator('[data-catalog-back]').click();
          await profilesPanel.locator('[data-profile-new]').click();
          await profilesPanel.locator('[data-profile-name]').fill('Docs');
          if (viewport.name === 'mobile') {
            await profilesPanel.locator('[data-profile-pick]').click();
            const picker = page.locator('[data-profile-picker]');
            await picker.locator('[data-library-add="profile/Shared"]').click();
            await picker.locator('[data-library-add="mcp/notes"]').click();
            await accountShot('profile-picker', 'new profile Add picker');
            await picker.locator('[data-picker-done]').click();
            await picker.waitFor({ state: 'detached' });
          } else {
            await profilesPanel
              .locator('[data-library-item="profile/Shared"]')
              .dragTo(profilesPanel.locator('[data-profile-contents]'));
            await profilesPanel
              .locator('[data-library-item="mcp/notes"]')
              .dragTo(profilesPanel.locator('[data-profile-item="profile/Shared"]'));
            await profilesPanel.locator('[data-profile-item="mcp/notes"]').waitFor({ state: 'visible' });
          }
          await accountShot('profile-new', 'new profile built by drag and drop');
          await profilesPanel.locator('[data-profile-cancel]').click();

          await machinesSurface.locator('[data-machine-tab="components"]').click();
          const componentsPanel = machinesSurface.locator('[data-machine-tab-panel="components"]');
          await componentsPanel.locator('[data-component-kind="mcp"]').waitFor({ state: 'visible' });
          await accountShot('components', 'Components kinds');
          await componentsPanel.locator('[data-component-kind="mcp"]').click();
          await componentsPanel.locator('[data-component-row="mcp/notes"]').waitFor({ state: 'visible' });
          await accountShot('component-list', 'MCP servers list');
          await componentsPanel.locator('[data-component-row="mcp/notes"]').click();
          await componentsPanel.locator('[data-catalog-note="path"]').waitFor({ state: 'visible' });
          await accountShot('component', 'component page with warnings');
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-component-kind="settings"]').click();
          await componentsPanel.locator('[data-component-row="settings/Codex settings"]').waitFor({ state: 'visible' });
          await accountShot('component-list-settings', 'Settings list with scope badges');
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-component-kind="instructions"]').click();
          await componentsPanel.locator('[data-component-row="instructions/Main instructions"]').click();
          await componentsPanel.locator('[data-component-rendered] h1').waitFor({ state: 'visible' });
          await accountShot('component-markdown', 'instructions rendered as Markdown');
          await themedShot('component-markdown');
          await componentsPanel.locator('[data-component-view-source]').click();
          await componentsPanel.locator('[data-component-source]').waitFor({ state: 'visible' });
          await accountShot('component-markdown-source', 'instructions as source');
          await componentsPanel.locator('[data-component-edit]').click();
          await componentsPanel.locator('[data-catalog-note="used"]').waitFor({ state: 'visible' });
          await accountShot('component-edit', 'component edit used everywhere');
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-component-kind="skills"]').click();
          await componentsPanel.locator('[data-component-row="skills/My skills"]').click();
          await componentsPanel.locator('[data-catalog-note="partial"]').waitFor({ state: 'visible' });
          await accountShot('component-partial', 'component partly supported');
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-catalog-back]').click();
          await componentsPanel.locator('[data-component-kind="settings"]').click();
          await componentsPanel.locator('[data-component-row="settings/Claude settings"]').click();
          await componentsPanel.locator('[data-component-edit]').click();
          await componentsPanel.locator('[data-component-hidden]').waitFor({ state: 'visible' });
          await accountShot('component-settings-edit', 'settings edit with a hidden value');

          // THE OTHER MACHINES (U21): one asleep or offline, and one not set up with the first run it
          // links to. These are the states a person meets on a second machine, and each is its own
          // layout — a status card above the tab panel, a set-up card instead of a list, and a stepper.
          const offlineSurface = await openMachine('unreachable-daemon');
          await offlineSurface.locator('[data-machine-offline]').waitFor({ state: 'visible' });
          await accountShot('offline', 'offline machine');
          // A machine that is not set up SAYS SO above its tabs, with the one button that resumes it; the
          // first run itself is a FULL SCREEN of its own, outside Settings and with no app chrome.
          const newMachine = await openMachine('checking-daemon');
          await newMachine.locator('[data-machine-finish-setup]').waitFor({ state: 'visible' });
          await accountShot('not-set-up', 'machine not set up');
          await newMachine.locator('[data-machine-finish-setup-open]').click();
          // New machine setup: ONE rail, no stepper inside any step. The whole journey, every step a frame
          // measured for the rail and the pinned footer: Start from, Claude Code (its runtime renamed and
          // imported in place), Codex (imported to sign in later), Speed-ups, Voice (skipped), the Warden,
          // Learning, Agent controls, and Done naming both runtimes and the skipped step's "Set up later".
          const setupScreen = page.locator('#harness-machine-setup [data-machine-onboarding]');
          const setupStep = async (step: string): Promise<void> =>
            setupScreen.locator(`[data-onboarding-step-body="${step}"]`).waitFor({ state: 'visible' });
          const setupNext = async (): Promise<void> => setupScreen.locator('[data-onboarding-next]').click();
          await setupStep('start');
          await setupShot('start', 'Start from');
          await setupNext();
          await setupScreen.locator('[data-harness-name="claude"]').waitFor({ state: 'visible' });
          await setupShot('claude', 'Claude Code, its runtime named in place');
          await setupScreen.locator('[data-harness-name="claude"]').fill('claude-main');
          await setupScreen.locator('[data-onboarding-step-body="claude"] [data-change-submit]').click();
          await setupScreen.locator('[data-harness-imported="claude"]').waitFor({ state: 'visible' });
          await setupShot('claude-imported', 'Claude Code imported, claude-main made');
          await setupNext();
          await setupScreen.locator('[data-harness-name="codex"]').waitFor({ state: 'visible' });
          await setupShot('codex', 'Codex, not signed in');
          await setupScreen.locator('[data-onboarding-step-body="codex"] [data-change-submit]').click();
          await setupScreen.locator('[data-harness-imported="codex"]').waitFor({ state: 'visible' });
          await setupNext();
          for (const [step, label] of [
            ['speedups', 'Speed-ups'],
            ['voice', 'Voice'],
            ['warden', 'Warden'],
            ['learning', 'Learning'],
            ['controls', 'Agent controls'],
          ] as const) {
            await setupStep(step);
            await setupShot(step, label);
            if (step === 'voice') await setupScreen.locator('[data-onboarding-skip]').click();
            else await setupNext();
          }
          await setupStep('done');
          await setupScreen
            .locator('[data-onboarding-summary-row="codex"]')
            .filter({ hasText: 'codex-default' })
            .waitFor();
          const claudeRow = await setupScreen.locator('[data-onboarding-summary-row="claude"]').innerText();
          if (!claudeRow.includes('claude-main')) fail(`Done does not name the runtime Claude Code made: ${claudeRow}`);
          await setupShot('done', 'Done naming both runtimes, Voice skipped');
          // Leaving lands back on the machine in Settings, banner and all.
          await setupScreen.locator('[data-onboarding-restart]').click();
          await setupScreen.locator('[data-onboarding-later-all]').click();
          await page
            .locator('[data-machines-surface="checking-daemon"] [data-machine-finish-setup]')
            .waitFor({ state: 'visible' });
          // IMPORT AGAIN is the same Claude Code step on a machine that is set up: what changed, a runtime
          // that already uses this login and profile, and Codex to install — the widest layouts at 390px.
          {
            const importUrl = new URL(server.url);
            importUrl.searchParams.set('machine-setup', 'harness-daemon');
            importUrl.searchParams.set('setup-step', 'claude');
            await page.goto(importUrl.toString());
            await setupScreen.locator('[data-harness-add-another]').waitFor({ state: 'visible' });
            await setupScreen.locator('[data-harness-add-another]').check();
            await setupScreen.locator('[data-harness-name="claude"]').fill('claude-default');
            await setupScreen.locator('[data-harness-name-problem="claude"]').waitFor({ state: 'visible' });
            await setupShot('import-again-claude', 'Import again on Claude Code');
            await setupNext();
            await setupScreen.locator('[data-onboarding-step-body="codex"] [data-tool-install]').first().waitFor();
            await setupShot('import-again-codex', 'Import again, Codex to install');
          }
          settingsPage = page.getByLabel('Settings page preview', { exact: true });

          // The compact registry is a separate deterministic route rather than a
          // DOM mutation: it remounts the reachability hooks exactly as a fresh
          // one-daemon browser would and proves the empty space is intentional.
          settingsUrl.searchParams.set('settings-daemons', 'one');
          await page.goto(settingsUrl.toString());
          settingsPage = page.getByLabel('Settings page preview', { exact: true });
          // The single machine is still LISTED, by name with its status — one row, never a hidden list.
          if (phone) await settingsHome.waitFor({ state: 'visible' });
          const oneMachineRows = await settingsNavigation().locator('[data-settings-machine]').count();
          if (oneMachineRows !== 1) fail(`settings one-daemon fixture listed ${oneMachineRows} machines instead of 1`);
          const oneMachine = await openMachine('harness-daemon');
          await openMachineTab(oneMachine);
          const oneDaemonFrame = settingsPage.locator('[data-daemon-settings-frame="harness-daemon"]');
          await openDaemonPanel(oneDaemonFrame, 'host-checks');
          await settingsPage.locator('[data-daemon-reachability="reachable"]').waitFor({ state: 'visible' });
          // The one-daemon route is a DIFFERENT MOUNT, not the many-daemon page with rows hidden: it
          // remounts the frame with no daemon switcher above it, so the panel gets width the checked
          // page never gave it. A layout that only breaks when it is given more room is not a strange
          // failure — it is what an element sized from a container rather than the viewport does.
          await assertNoSidewaysScroll(page, `the one-daemon Settings route at ${viewport.name}`);
          const oneDaemonTarget = join(outDir, `settings-daemons-one-${viewport.name}.png`);
          await page.screenshot({ path: oneDaemonTarget });
          process.stdout.write(`📸 Settings Daemons (one) ${viewport.name} -> ${oneDaemonTarget}\n`);

          // THE UNLOCK SCREEN, the first thing a locked machine shows: one sentence, one line on how long
          // it stays, one button. It is a viewport shot because the dialog is fixed to the viewport.
          const unlockPromptTarget = join(outDir, `unlock-prompt-${viewport.name}.png`);
          await page.goto(`${server.url}?unlock-prompt`);
          const unlockPrompt = page.getByRole('dialog', { name: 'Unlock' });
          await unlockPrompt.getByText('It stays unlocked on this device for 8 hours.').waitFor({ state: 'visible' });
          await unlockPrompt.getByRole('button', { name: 'Unlock' }).waitFor({ state: 'visible' });
          await assertNoSidewaysScroll(page, `the unlock screen at ${viewport.name}`);
          await page.screenshot({ path: unlockPromptTarget, animations: 'disabled' });
          process.stdout.write(`📸 unlock screen ${viewport.name} -> ${unlockPromptTarget}\n`);
          await page.goto(settingsUrl.toString());

          // EVERY THEME FAMILY'S TERMINAL, measured: one cell per character, in a monospace face.
          for (const family of THEME_FAMILIES)
            await assertTerminalGeometry(page, server.url.toString(), family.id, viewport.name);
          await page.evaluate(() => localStorage.removeItem('fy-theme-v1'));
          await page.goto(settingsUrl.toString());

          // The rest of this pass belongs to the full gallery.
          if (SETTINGS_ONLY) continue;
          await page.goto(server.url.toString());
          // A four-kind ledger is taller than a phone viewport. Chrome may cull
          // unpainted rows during an element screenshot, so temporarily borrow
          // a tall viewport to capture the full, real phone-width board.
          const attentionTarget = join(outDir, `attention-${viewport.name}.png`);
          await page.setViewportSize({ width: viewport.width, height: 2_400 });
          const attention = page.getByLabel('Attention ledger');
          await attention.locator('summary').filter({ hasText: 'Resolution audit' }).click();
          await captureElement(page, attention, attentionTarget);
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          process.stdout.write(`📸 Attention ledger -> ${attentionTarget}\n`);
          const pinsTriggerTarget = join(outDir, `pins-trigger-${viewport.name}.png`);
          await captureElement(page, page.getByLabel('Pins trigger'), pinsTriggerTarget);
          process.stdout.write(`📸 Pins trigger -> ${pinsTriggerTarget}\n`);
          const pinsTarget = join(outDir, `pins-${viewport.name}.png`);
          await captureElement(page, page.getByLabel('Pins ledger'), pinsTarget);
          process.stdout.write(`📸 Pins ledger -> ${pinsTarget}\n`);
          // Three pairing screens, because they are three different screens: the
          // cold open a first-timer sees, the confirmation a scanned QR lands
          // on, and what the surface becomes once a daemon is connected.
          for (const [label, slug] of [
            ['Daemon pairing', 'pairing'],
            ['Pairing confirmation', 'pairing-confirm'],
            ['Paired daemon list', 'pairing-list'],
          ] as const) {
            const pairingTarget = join(outDir, `${slug}-${viewport.name}.png`);
            await captureElement(page, page.getByLabel(label, { exact: true }), pairingTarget);
            process.stdout.write(`📸 ${label} ${viewport.name} -> ${pairingTarget}\n`);
          }

          // AND IN LIGHT. Pairing is the first screen a new reader ever sees,
          // and half of them are not in dark mode. The rest of this harness page
          // is captured dark only; this one surface is worth both.
          await applyTheme(page, 'studio-light');
          for (const [label, slug] of [
            ['Daemon pairing', 'pairing'],
            ['Pairing confirmation', 'pairing-confirm'],
            ['Paired daemon list', 'pairing-list'],
          ] as const) {
            const lightTarget = join(outDir, `${slug}-light-${viewport.name}.png`);
            await captureElement(page, page.getByLabel(label, { exact: true }), lightTarget);
            process.stdout.write(`📸 ${label} light ${viewport.name} -> ${lightTarget}\n`);
          }
          await applyTheme(page, 'studio-dark');

          await capturePairingFailures(page, viewport.name);
          const wardenOverviewTarget = join(outDir, `warden-overview-${viewport.name}.png`);
          await captureElement(page, page.locator('[data-harness="warden-overview"]'), wardenOverviewTarget);
          process.stdout.write(`📸 Warden page -> ${wardenOverviewTarget}\n`);
          const wardenStripTarget = join(outDir, `warden-strip-${viewport.name}.png`);
          await captureElement(page, page.locator('[data-harness="warden-strip"]'), wardenStripTarget);
          process.stdout.write(`📸 Warden strip -> ${wardenStripTarget}\n`);
          // The secret store, in the three states a person actually meets: one that exists
          // (masked, with a configured reference that does not resolve), a damaged store that says
          // so rather than reporting empty, and a read this browser could not make.
          for (const [name, selector] of [
            [`secrets`, `[data-harness="secrets-card"]`],
            [`secrets-damaged`, `[data-harness="secrets-damaged"]`],
            [`secrets-unreachable`, `[data-harness="secrets-unreachable"]`],
          ] as const) {
            const target = join(outDir, `${name}-${viewport.name}.png`);
            await captureElement(page, page.locator(selector), target);
            process.stdout.write(`📸 Secrets ${name} ${viewport.name} -> ${target}\n`);
          }
          // The operator's limits, in the four states a paired browser actually meets. Every one of
          // them is a frame where a control is refused, so every one has to show the reason beside it
          // — that is the thing being reviewed, not the switches.
          //
          // A TALL VIEWPORT IS BORROWED, for the reason the attention ledger borrows one: five
          // capabilities × two axes × a reason under each is far taller than a phone, and Chrome may
          // cull unpainted rows during an element screenshot. Captured at 390 wide and 844 high, the
          // card came out clipped at the second row and the desktop shot stitched the NEXT card's
          // content under this one's name — an element capture that is confidently wrong rather than
          // obviously short, which is the worse of the two failures.
          await page.setViewportSize({ width: viewport.width, height: 4_000 });
          for (const [name, selector] of [
            [`grants-step-up-needed`, `[data-harness="grants-step-up-needed"]`],
            [`grants-step-up-held`, `[data-harness="grants-step-up-held"]`],
            [`grants-undetermined`, `[data-harness="grants-undetermined"]`],
            [`grants-unreachable`, `[data-harness="grants-unreachable"]`],
            // The capability list in both postures that exist. The governed one is the frame that matters:
            // the harness daemon's address is loopback, so a capture claiming the limits do not apply
            // there would be the old direct-local reading, visible in a PNG.
            [`capability-list-governed`, `[data-harness="capability-list-governed"]`],
            [`capability-list-unknown`, `[data-harness="capability-list-unknown"]`],
          ] as const) {
            const frame = page.locator(selector);
            await frame.scrollIntoViewIfNeeded();
            // Settled content, not a spinner: every one of these frames is rendered from a fixture, so
            // a capture still showing "Reading…" would be a regression to review rather than a state.
            await frame
              .locator('[data-grant-surface], [aria-label="Capability grants unavailable"], [data-capability-list]')
              .first()
              .waitFor({ state: 'visible' });
            const target = join(outDir, `${name}-${viewport.name}.png`);
            await captureElement(page, frame, target);
            process.stdout.write(`📸 Capability limits ${name} ${viewport.name} -> ${target}\n`);
          }
          // AND THE PASSKEY FRAMES IN LIGHT. The warn tone of a row waiting on a confirmation is the last
          // place to lose contrast, so it has to be legible in both themes rather than designed in dark and
          // inverted — a hairline that vanishes on `surface-2` takes a boundary with it.
          await applyTheme(page, 'studio-light');
          for (const name of ['grants-step-up-needed', 'grants-step-up-held'] as const) {
            const frame = page.locator(`[data-harness="${name}"]`);
            await frame.scrollIntoViewIfNeeded();
            const target = join(outDir, `${name}-light-${viewport.name}.png`);
            await captureElement(page, frame, target);
            process.stdout.write(`📸 Capability limits ${name} light ${viewport.name} -> ${target}\n`);
          }
          await applyTheme(page, 'studio-dark');
          // Adding a device, in the states somebody actually meets. THE CODE IN THESE FRAMES IS FAKE —
          // see `HARNESS_INVITE`. A committed PNG of a real minted code would be a live credential in
          // the repository, and a QR is a machine-readable label rather than obfuscation.
          //
          // The tall viewport is still borrowed, for the reason the grant frames borrow one: a QR, a
          // countdown, a selectable link and a device list are taller than a phone, and Chrome may cull
          // unpainted rows during an element screenshot.
          for (const [name, selector] of [
            [`pair-devices`, `[data-harness="pair-devices"]`],
            [`pair-invite`, `[data-harness="pair-invite"]`],
            [`pair-expired`, `[data-harness="pair-expired"]`],
            [`pair-empty`, `[data-harness="pair-empty"]`],
            [`pair-refused`, `[data-harness="pair-refused"]`],
          ] as const) {
            const frame = page.locator(selector);
            await frame.scrollIntoViewIfNeeded();
            // Settled content, not a spinner: every frame is rendered from a fixture, so a capture still
            // showing "Reading…" would be a regression to review rather than a state.
            await frame
              .locator('[data-add-device-surface], [aria-label="Adding a device unavailable"]')
              .first()
              .waitFor({ state: 'visible' });
            const target = join(outDir, `${name}-${viewport.name}.png`);
            await captureElement(page, frame, target);
            process.stdout.write(`📸 Add a device ${name} ${viewport.name} -> ${target}\n`);
          }
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          const taskDagTarget = join(outDir, `task-dag-${viewport.name}.png`);
          await captureElement(page, page.locator('[data-task-graph]'), taskDagTarget);
          process.stdout.write(`📸 Task dependency graph -> ${taskDagTarget}\n`);
          const sessionTasksTarget = join(outDir, `session-tasks-${viewport.name}.png`);
          await captureElement(page, page.getByLabel('Session task board'), sessionTasksTarget);
          process.stdout.write(`📸 Session task board -> ${sessionTasksTarget}\n`);
          const taskNameTarget = join(outDir, `task-name-${viewport.name}.png`);
          await captureElement(page, page.getByLabel('Task name'), taskNameTarget);
          process.stdout.write(`📸 Task name -> ${taskNameTarget}\n`);

          const inAppTarget = join(outDir, `in-app-browser-${viewport.name}.png`);
          await page.locator('#harness-in-app-browser').scrollIntoViewIfNeeded();
          await captureElement(page, page.getByLabel('In-app link preview'), inAppTarget);
          process.stdout.write(`📸 In-app link preview -> ${inAppTarget}\n`);

          await captureFiles(page, viewport.name);

          const attachmentsTarget = join(outDir, `attachments-${viewport.name}.png`);
          // The thumbnail is `loading="lazy"` and the harness stacks it thousands
          // of pixels below the fold, so Chrome has not started decoding it yet.
          // Scroll first: capturing before it lands gives a 0x0 box and a card
          // screenshot that is silently missing its image.
          await page.locator('#harness-attachments').scrollIntoViewIfNeeded();
          await page.getByAltText('Coverage by tier').waitFor({ state: 'visible' });
          await captureElement(page, page.getByLabel('Transcript attachments'), attachmentsTarget);
          process.stdout.write(`📸 Transcript attachments -> ${attachmentsTarget}\n`);
          const terminalTarget = join(outDir, `terminal-snapshot-${viewport.name}.png`);
          await captureElement(page, page.getByLabel('Terminal snapshot'), terminalTarget);
          process.stdout.write(`📸 Terminal snapshot -> ${terminalTarget}\n`);

          const sidePaneTabsTarget = join(outDir, `side-pane-tabs-${viewport.name}.png`);
          await captureElement(page, page.locator('[data-harness="side-pane-tabs"]'), sidePaneTabsTarget);
          process.stdout.write(`📸 Side pane tabs -> ${sidePaneTabsTarget}\n`);

          for (const [label, slug] of [
            ['Session dashboard full table', 'session-dashboard-table'],
            ['Session dashboard full cards', 'session-dashboard-cards'],
            ['Session dashboard compact panel', 'session-dashboard-compact'],
            ['Session dashboard scoped', 'session-dashboard-scoped'],
            ['Session dashboard minimal panel', 'session-dashboard-minimal'],
            ['Session dashboard lean table', 'session-dashboard-lean-table'],
            ['Sessions page connected', 'sessions-page-connected'],
          ] as const) {
            const dashboardTarget = join(outDir, `${slug}-${viewport.name}.png`);
            await captureElement(page, page.getByLabel(label, { exact: true }), dashboardTarget);
            process.stdout.write(`📸 ${label} -> ${dashboardTarget}\n`);
          }

          // Four stacked dashboards are taller than a phone viewport. `captureElement`
          // grows the viewport to fit them and puts it back, so the hand-rolled
          // borrow that used to live here — and the identical one at the dictation
          // settings card — is gone rather than duplicated.
          const dashboardStatesTarget = join(outDir, `session-dashboard-states-${viewport.name}.png`);
          await captureElement(
            page,
            page.getByLabel('Session dashboard states', { exact: true }),
            dashboardStatesTarget,
          );
          process.stdout.write(`📸 Session dashboard states -> ${dashboardStatesTarget}\n`);

          const unlockTarget = join(outDir, `attachment-unlock-${viewport.name}.png`);
          await page.goto(`${server.url}?attachment-unlock`);
          await captureElement(page, page.getByRole('dialog', { name: 'Unlock encrypted PDF' }), unlockTarget);
          process.stdout.write(`📸 attachment unlock -> ${unlockTarget}\n`);
          await page.goto(server.url.toString());

          // The harness stacks every ported surface down one column, so most of it
          // is below the fold. A full-page stitch cannot prove those: the app bar
          // is sticky, and Chrome repaints a fixed layer into every stitched tile.
          // So each surface below the fold is captured as ITS OWN element shot,
          // which is both immune to that and easier to compare against the
          // original screen by screen.
          for (const section of SECTIONS) {
            const element = page.locator(`#${section}`);
            await element.scrollIntoViewIfNeeded();
            const sectionTarget = join(outDir, `${viewport.name}-${section}.png`);
            await captureElement(page, element, sectionTarget);
            process.stdout.write(`📸 ${viewport.name} ${section} -> ${sectionTarget}\n`);
          }

          // #43: a Skills row carries two actions, and the second one's whole
          // point is a state the resting frame cannot show. Expand one detail
          // and capture the section again, so a reviewer sees the disclosed
          // content and the primary/secondary hierarchy beside it rather than
          // two buttons and a promise.
          const skills = page.locator('#harness-skills');
          await skills.scrollIntoViewIfNeeded();
          await skills
            .getByRole('button', { name: /^View full detail for/u })
            .first()
            .click();
          const skillsDetailTarget = join(outDir, `${viewport.name}-harness-skills-detail.png`);
          await captureElement(page, skills, skillsDetailTarget);
          process.stdout.write(`📸 ${viewport.name} skills detail -> ${skillsDetailTarget}\n`);

          const ledgerTarget = join(outDir, `send-ledger-${viewport.name}.png`);
          await captureElement(page, page.getByLabel('Send ledger rows'), ledgerTarget);
          process.stdout.write(`📸 send ledger -> ${ledgerTarget}
    `);

          // A tool run's EXPANDED state is the other half of its design — the slim
          // chrome line is what it looks like at rest, and the code surfaces only
          // exist after a deliberate click — so it gets its own pass.
          const toolGroup = page.locator('[data-transcript-kind="tool"]').first();
          await toolGroup.scrollIntoViewIfNeeded();
          await toolGroup.getByRole('button').first().click();
          await toolGroup.getByRole('button').nth(1).click();
          const toolGroupTarget = join(outDir, `tool-group-${viewport.name}.png`);
          await captureElement(page, toolGroup, toolGroupTarget);
          process.stdout.write(`📸 tool group -> ${toolGroupTarget}\n`);

          // The context menu is anchored and `fixed`, which is exactly what a
          // full-page stitch cannot capture — so it gets its own viewport-sized
          // pass behind a fragment.
          const menuTarget = join(outDir, `${viewport.name}-menu.png`);
          await page.goto(`${server.url}#menu`);
          await page.reload();
          // Wait for the rows, not just for load: the menu paints hidden and is
          // revealed by a layout effect once it has been measured and clamped.
          await page.locator('[role="menuitem"]').last().waitFor({ state: 'visible' });
          await page.screenshot({ path: menuTarget });
          process.stdout.write(`📸 ${viewport.name} context menu -> ${menuTarget}\n`);

          const paletteTarget = join(outDir, `${viewport.name}-palette.png`);
          await page.goto(`${server.url}#palette`);
          await page.reload();
          await page.locator('[role="option"]').last().waitFor({ state: 'visible' });
          await page.screenshot({ path: paletteTarget });
          process.stdout.write(`📸 ${viewport.name} command palette -> ${paletteTarget}\n`);

          const rowMenuTarget = join(outDir, `${viewport.name}-row-menu.png`);
          await page.goto(`${server.url}#row-menu`);
          await page.reload();
          await page.locator('[role="menuitem"]').last().waitFor({ state: 'visible' });
          await page.screenshot({ path: rowMenuTarget });
          process.stdout.write(`📸 ${viewport.name} session row menu -> ${rowMenuTarget}\n`);

          // The bulk-stop confirmation is a fixed overlay like the menu and the
          // palette, and its two states are different screens: what will die, and
          // what did.
          for (const [fragment, name] of [
            ['#stop', 'stop-confirm'],
            ['#stop-results', 'stop-results'],
          ] as const) {
            const stopTarget = join(outDir, `${viewport.name}-${name}.png`);
            await page.goto(`${server.url}${fragment}`);
            await page.reload();
            await page.getByRole('dialog', { name: /confirm|results/ }).waitFor({ state: 'visible' });
            await page.screenshot({ path: stopTarget });
            process.stdout.write(`📸 ${viewport.name} ${name} -> ${stopTarget}\n`);
          }

          // The fleet drawer only exists below the drawer breakpoint, and only while
          // it is open, so a page-flow capture at 390px correctly shows nothing.
          const drawerTarget = join(outDir, `${viewport.name}-fleet-drawer.png`);
          await page.goto(`${server.url}#fleet-drawer`);
          await page.reload();
          const drawer = page.getByRole('dialog', { name: 'Fleet sessions' });
          if (await drawer.isVisible().catch(() => false)) {
            await page.screenshot({ path: drawerTarget });
            process.stdout.write(`📸 ${viewport.name} fleet drawer -> ${drawerTarget}\n`);
          }

          const renameTarget = join(outDir, `${viewport.name}-rename.png`);
          await page.goto(`${server.url}#rename`);
          await page.reload();
          await page.getByRole('dialog', { name: 'Rename session' }).waitFor({ state: 'visible' });
          await page.screenshot({ path: renameTarget });
          process.stdout.write(`📸 ${viewport.name} rename sheet -> ${renameTarget}\n`);

          const migrateTarget = join(outDir, `${viewport.name}-migrate.png`);
          await page.goto(`${server.url}#migrate`);
          await page.reload();
          await page.getByRole('dialog', { name: 'Change model or account' }).waitFor({ state: 'visible' });
          await page.screenshot({ path: migrateTarget });
          process.stdout.write(`📸 ${viewport.name} migrate sheet -> ${migrateTarget}\n`);

          // THE ASSEMBLED SESSION WORKSPACE, on a page of its own.
          //
          // It is `h-full` with a single scroller of its own, so an element shot
          // inside the stacked gallery would be clipped by the gallery's
          // scroller and would prove nothing about where the composer sits. The
          // alternate root mounts the production shell and the production
          // viewport producer, and derives pane-vs-sheet from the layout regime
          // exactly as `src/App.tsx` does — so this loop's two viewports are the
          // two presentations, with nothing to switch by hand.
          //
          // Captured at rest FIRST: the pane starts closed in production, so the
          // full-width chat column is the state a reader actually opens on, and
          // it is the only frame that shows the transcript and the composer with
          // nothing over them.
          const workspaceTarget = join(outDir, `${viewport.name}-session-workspace.png`);
          await page.goto(`${server.url}#session-workspace`);
          await page.reload();
          await page.locator('#harness-session-workspace-page').waitFor({ state: 'visible' });
          // The transcript follows its tail on mount; wait for the LAST row
          // rather than for load, or the shot catches a scroller mid-pin.
          await page.locator('[data-transcript-kind]').last().waitFor({ state: 'visible' });
          await page.screenshot({ path: workspaceTarget });
          process.stdout.write(`📸 ${viewport.name} session workspace -> ${workspaceTarget}\n`);

          // THE SESSION BAR AS ITS OWN REVIEW SURFACE. The workspace capture proves the bar's share of
          // the viewport; this tighter image makes its spacing legible. It is ONE row now — the agent's
          // name, project and status, the lifecycle buttons, ⓘ Info and Actions ▾ — and the height is printed so a
          // regression back to two rows of chrome is a number, not an impression.
          const sessionBar = page.locator('[data-session-bar]');
          const sessionBarTarget = join(outDir, `session-bar-${viewport.name}.png`);
          await captureElement(page, sessionBar, sessionBarTarget);
          process.stdout.write(`📸 session bar ${viewport.name} -> ${sessionBarTarget}\n`);
          const sessionBarHeight = await sessionBar.evaluate(bar => Math.round(bar.getBoundingClientRect().height));
          process.stdout.write(`   session bar height=${sessionBarHeight}px\n`);
          if (sessionBarHeight > 64)
            fail(`the session bar is ${sessionBarHeight}px tall at ${viewport.name}: one row, please`);

          // Geometry, printed rather than eyeballed. A screenshot cannot tell a
          // pinned tail apart from a transcript that happens to be short, and it
          // cannot show that the page itself never scrolls — which is the one
          // invariant the whole shell exists to hold (`html, body { overflow:
          // hidden }` plus one scroller per page).
          const workspaceGeometry = await page.evaluate(() => {
            const root = document.documentElement;
            const scrollers = [...document.querySelectorAll<HTMLElement>('*')].filter(element => {
              const style = getComputedStyle(element);
              const scrolls = /auto|scroll/u.test(`${style.overflowY}${style.overflowX}`);
              return scrolls && element.scrollHeight - element.clientHeight > 1;
            });
            const composer = document.querySelector<HTMLElement>('[data-session-input] form');
            const transcript = document.querySelector<HTMLElement>('.fy-transcript');
            const box = composer?.getBoundingClientRect();
            return {
              appHeight: root.style.getPropertyValue('--app-h'),
              pageScrollsX: root.scrollWidth > root.clientWidth,
              pageScrollsY: root.scrollHeight > root.clientHeight,
              scrollers: scrollers.map(element => element.className.split(/\s+/u)[0] || element.tagName),
              transcriptPinned:
                transcript === null
                  ? null
                  : transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 2,
              composerBottom: box === undefined ? null : Math.round(box.bottom),
              composerVisible: box === undefined ? null : Math.round(box.bottom) <= window.innerHeight,
              pane: document.querySelector('aside') !== null,
            };
          });
          process.stdout.write(
            `   workspace geometry: --app-h=${workspaceGeometry.appHeight || '(unset)'} ` +
              `page scroll x/y=${workspaceGeometry.pageScrollsX}/${workspaceGeometry.pageScrollsY} ` +
              `scrollers=[${workspaceGeometry.scrollers.join(', ')}] ` +
              `transcript pinned=${String(workspaceGeometry.transcriptPinned)} ` +
              `composer bottom=${String(workspaceGeometry.composerBottom)}px ` +
              `visible=${String(workspaceGeometry.composerVisible)} pane mounted=${workspaceGeometry.pane}\n`,
          );
          if (workspaceGeometry.pageScrollsX) {
            fail('the session workspace made the page scroll horizontally');
          }
          if (workspaceGeometry.composerVisible === false) {
            fail(`the composer sits below the viewport at ${viewport.name}`);
          }

          // THEN the Console — the agent's own pane — shown through the agent pane's own Console tab, the
          // control a reader clicks. It resolves entirely from the harness snapshot reader, so the
          // capture is the agent pane's second tab rather than a network error.
          const workspacePaneTarget = join(outDir, `${viewport.name}-session-workspace-pane.png`);
          await page.getByRole('tab', { name: 'Console' }).first().click();
          await page.locator('[data-workspace-console]').waitFor({ state: 'visible' });
          await page.screenshot({ path: workspacePaneTarget });
          process.stdout.write(`📸 ${viewport.name} session workspace, Console shown -> ${workspacePaneTarget}\n`);

          // The real remote browser gets this route of its own so this is the
          // production side-pane layout taking the whole screen, not a gallery
          // card sized to look like one. The visible Exit control is the phone
          // escape hatch; Escape then proves the keyboard route returns to the
          // exact pane/sheet it started from.
          const fullBrowserTarget = join(outDir, `${viewport.name}-browser-full-viewport.png`);
          await page.goto(`${server.url}#browser-full-viewport`);
          await page.reload();
          await page.locator('#harness-browser-full-viewport-page').waitFor({ state: 'visible' });
          await page.getByLabel('Expand browser to fill the viewport').click();
          const exitBrowser = page.getByLabel('Exit full-screen browser');
          await exitBrowser.waitFor({ state: 'visible' });
          const fullBrowserGeometry = await measureFullBrowserFrame(exitBrowser);
          if (
            !fullBrowserGeometry.fixed ||
            fullBrowserGeometry.width !== fullBrowserGeometry.viewportWidth ||
            fullBrowserGeometry.height !== fullBrowserGeometry.viewportHeight
          ) {
            fail(
              `the full browser does not occupy the ${viewport.name} viewport: ${JSON.stringify(fullBrowserGeometry)}`,
            );
          }
          await page.screenshot({ path: fullBrowserTarget });
          process.stdout.write(`📸 ${viewport.name} browser full viewport -> ${fullBrowserTarget}\n`);
          await page.keyboard.press('Escape');
          await page.getByLabel('Expand browser to fill the viewport').waitFor({ state: 'visible' });

          /**
           * THE PICKERS, EACH ON ITS OWN PAGE, WITH THE LIST ACTUALLY OPEN.
           *
           * Every state here is reached by driving the real control — click the field, type into it,
           * arrow through it — because the list only exists while the field has focus and a posed
           * popover would prove nothing about the component that has to produce one.
           *
           * The three assertions below are the point of the pass, and they are assertions rather
           * than pictures because a screenshot cannot tell a list that fits from one that is being
           * clipped by an ancestor: both look like a list.
           */
          for (const frame of PICKER_FRAMES) {
            await page.goto(`${server.url}#picker-${frame}`);
            await page.reload();
            const pickerPage = page.locator(`#harness-picker-${frame}-page`);
            await pickerPage.waitFor({ state: 'visible' });

            const field = page.locator('input[role="combobox"]');
            await field.click();
            const expectsList = frame !== 'account-failed';
            if (expectsList) {
              await page.locator('[role="listbox"]').waitFor({ state: 'visible' });
              // Move the cursor with the keyboard, so the capture carries a real active row and
              // `aria-activedescendant` is pointing at something.
              await page.keyboard.press('ArrowDown');
              await page.keyboard.press('ArrowDown');
            } else {
              // The whole claim of this frame: the roster failed and the field still works.
              await page.locator('[data-picker-state="failed"]').waitFor({ state: 'visible' });
              await field.type('claude-auto-typed-by-hand');
              const typed = await field.inputValue();
              if (typed !== 'claude-auto-typed-by-hand') {
                fail(`the failed-roster field did not accept a typed value (got ${JSON.stringify(typed)})`);
              }
            }

            const geometry = await page.evaluate(
              ([wantsList, minimum]) => {
                const root = document.documentElement;
                const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
                const box = (element: Element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    top: Math.round(rect.top),
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    bottom: Math.round(rect.bottom),
                    height: Math.round(rect.height),
                  };
                };
                // Every ancestor that can scroll, and therefore can clip. A popover that leaves one
                // of these rectangles is painted where nobody can see it.
                const clippers: Array<{ readonly at: string; readonly box: ReturnType<typeof box> }> = [];
                if (listbox !== null) {
                  for (let node = listbox.parentElement; node !== null; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    if (/auto|scroll|hidden|clip/u.test(`${style.overflowY}${style.overflowX}`)) {
                      clippers.push({
                        at: node.tagName.toLowerCase() + (node.id ? `#${node.id}` : ''),
                        box: box(node),
                      });
                    }
                  }
                }
                const controls = [...document.querySelectorAll<HTMLElement>('input[role="combobox"], button')];
                const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
                const measured = [...controls, ...options]
                  .filter(element => element.getBoundingClientRect().height > 0)
                  .map(element => ({
                    what: element.getAttribute('role') ?? element.tagName.toLowerCase(),
                    height: Math.round(element.getBoundingClientRect().height),
                  }));
                return {
                  viewport: { width: window.innerWidth, height: window.innerHeight },
                  pageScrollsX: root.scrollWidth > root.clientWidth,
                  scrollWidth: root.scrollWidth,
                  listbox: listbox === null ? null : box(listbox),
                  optionCount: options.length,
                  activeDescendant:
                    document.querySelector('input[role="combobox"]')?.getAttribute('aria-activedescendant') ?? null,
                  // What is actually on the glass at the list's own centre. A rectangle in the right
                  // place that something else paints over is still an invisible list.
                  centreOwnedByList:
                    listbox === null
                      ? null
                      : (() => {
                          const rect = listbox.getBoundingClientRect();
                          const hit = document.elementFromPoint(
                            Math.round(rect.left + rect.width / 2),
                            Math.round(rect.top + Math.min(rect.height / 2, 20)),
                          );
                          return hit !== null && listbox.contains(hit);
                        })(),
                  clippers,
                  wantsList,
                  undersized: measured.filter(entry => entry.height < minimum),
                  smallest: measured.reduce((low, entry) => Math.min(low, entry.height), Number.POSITIVE_INFINITY),
                };
              },
              [expectsList, TOUCH_TARGET_MINIMUM] as const,
            );

            process.stdout.write(
              `   picker ${frame} @ ${viewport.name}: page scroll x=${geometry.pageScrollsX} ` +
                `(scrollWidth=${geometry.scrollWidth} vs ${geometry.viewport.width}) ` +
                `options=${geometry.optionCount} active=${geometry.activeDescendant ?? '(none)'} ` +
                `list=${geometry.listbox === null ? '(none)' : `${geometry.listbox.top}-${geometry.listbox.bottom}px`} ` +
                `centre owned by list=${String(geometry.centreOwnedByList)} ` +
                `smallest control=${geometry.smallest}px clippers=${geometry.clippers.length}\n`,
            );

            // 1. No horizontal overflow. Asserted at BOTH widths but it is 390px that has ever
            //    failed it, and a picker whose list forces a sideways scroll is unusable on a phone.
            if (geometry.pageScrollsX) {
              fail(
                `the ${frame} picker made the page scroll horizontally at ${viewport.name} ` +
                  `(${geometry.scrollWidth}px in a ${geometry.viewport.width}px viewport)`,
              );
            }

            // 2. Every visible control and every offered row is at least a thumb tall.
            if (geometry.undersized.length > 0) {
              fail(
                `the ${frame} picker has controls below ${TOUCH_TARGET_MINIMUM}px at ${viewport.name}: ` +
                  geometry.undersized.map(entry => `${entry.what} ${entry.height}px`).join(', '),
              );
            }

            // 3. The open list is inside the viewport, on the glass, and inside every ancestor that
            //    could clip it. This is the one a picture cannot make for us.
            if (geometry.wantsList) {
              const list = geometry.listbox;
              if (list === null) fail(`the ${frame} picker rendered no listbox to measure at ${viewport.name}`);
              if (geometry.optionCount === 0) fail(`the ${frame} picker opened an empty list at ${viewport.name}`);
              if (geometry.activeDescendant === null) {
                fail(`the ${frame} picker points aria-activedescendant at nothing after two ArrowDowns`);
              }
              if (
                list.top < 0 ||
                list.bottom > geometry.viewport.height ||
                list.left < 0 ||
                list.right > geometry.viewport.width
              ) {
                fail(
                  `the ${frame} picker's list leaves the ${viewport.name} viewport: ` +
                    `${list.left},${list.top} → ${list.right},${list.bottom} in ` +
                    `${geometry.viewport.width}x${geometry.viewport.height}`,
                );
              }
              for (const clipper of geometry.clippers) {
                if (
                  list.top < clipper.box.top ||
                  list.bottom > clipper.box.bottom ||
                  list.left < clipper.box.left ||
                  list.right > clipper.box.right
                ) {
                  fail(
                    `the ${frame} picker's list is clipped by ${clipper.at} at ${viewport.name}: ` +
                      `list ${list.top}-${list.bottom}px vs clipper ${clipper.box.top}-${clipper.box.bottom}px`,
                  );
                }
              }
              if (geometry.centreOwnedByList !== true) {
                fail(`something is painted over the ${frame} picker's list at ${viewport.name}`);
              }
            }

            const pickerTarget = join(outDir, `${viewport.name}-picker-${frame}.png`);
            await page.screenshot({ path: pickerTarget });
            process.stdout.write(`📸 ${viewport.name} picker ${frame} -> ${pickerTarget}\n`);
          }

          await captureSessionSearchEvidence(page, viewport, server.url.toString());

          // Back to the gallery: every capture after this one expects the shell, and a page left on a
          // fleet fragment made the next locator wait for an app bar that is not on it.
          await page.goto(server.url.toString());
          await page.reload();
          await page.locator('[data-density-region="app-bar"]').first().waitFor({ state: 'visible' });

          // The install stage on a page of its own, so the capture starts at
          // the real top of the screen rather than wherever the gallery's
          // scroller happened to clip it.
          const installTarget = join(outDir, `${viewport.name}-onboarding-install-page.png`);
          await page.goto(`${server.url}#onboarding-install`);
          await page.reload();
          await page.locator('#harness-onboarding-install-page').waitFor({ state: 'visible' });
          await page.screenshot({ path: installTarget, fullPage: true });
          process.stdout.write(`📸 ${viewport.name} setup install page -> ${installTarget}\n`);

          // The pairing stage with the keyboard up: the state the reader
          // reported as broken. Phone only — a desktop has no software keyboard
          // to model, and pretending otherwise would be a made-up screenshot.
          //
          // Supplementary, not authoritative: this gallery context is 390px wide
          // but not touch-emulated, so it proves the layout and the focus, not
          // the coarse-pointer branches. The real-app driver owns that.
          if (viewport.name === 'mobile') {
            await page.addInitScript(VISUAL_VIEWPORT_SHIM);
            // A real document navigation, not a fragment jump: the alternate
            // root only mounts on load, and an init script only runs on one.
            await page.goto(`${server.url}#onboarding-keyboard`);
            await page.reload();
            await page.locator('#harness-onboarding-scan-page').waitFor({ state: 'visible' });

            // The keyboard is only up because a FIELD has focus, so the shot has
            // to start there — an unfocused capture would look identical and
            // prove nothing about the state that was reported broken.
            await page.getByRole('button', { name: 'Paste a link instead' }).click();
            const field = page.locator('#pairing-link');
            await field.waitFor({ state: 'visible' });
            await field.focus();

            const before = await page.evaluate(() => ({
              innerHeight: window.innerHeight,
              screenHeight: window.screen.height,
              visual: window.visualViewport?.height ?? null,
              focused: document.activeElement?.id ?? null,
            }));
            if (before.focused !== 'pairing-link') fail(`the pairing field never took focus (got ${before.focused})`);

            await page.evaluate(() => {
              (window as unknown as { __harnessKeyboard: (height: number) => void }).__harnessKeyboard(430);
            });
            // The producer schedules through requestAnimationFrame, so the
            // attribute lands a frame after the resize, not with it.
            await page
              .waitForFunction(() => document.documentElement.getAttribute('data-keyboard') === 'open')
              .catch(() => fail('the production viewport producer never reported an open keyboard'));

            // The keyboard is only handled if the field it belongs to is still
            // on screen. A shot of the stage with the input somewhere below the
            // fold is a picture of the bug, not of the fix.
            await page
              .waitForFunction(() => {
                const input = document.getElementById('pairing-link');
                const limit = window.visualViewport?.height ?? window.innerHeight;
                if (input === null) return false;
                const rect = input.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= limit;
              })
              .catch(async () => {
                const state = await page.evaluate(() => {
                  const input = document.getElementById('pairing-link');
                  const rect = input?.getBoundingClientRect();
                  return {
                    keyboard: document.documentElement.getAttribute('data-keyboard'),
                    appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-h'),
                    visual: window.visualViewport?.height ?? null,
                    focused: document.activeElement?.id ?? null,
                    top: Math.round(rect?.top ?? -1),
                    bottom: Math.round(rect?.bottom ?? -1),
                  };
                });
                fail(`the focused pairing field never came back into view: ${JSON.stringify(state)}`);
              });

            const after = await page.evaluate(() => {
              const rect = document.getElementById('pairing-link')?.getBoundingClientRect();
              return {
                innerHeight: window.innerHeight,
                screenHeight: window.screen.height,
                visual: window.visualViewport?.height ?? null,
                focused: document.activeElement?.id ?? null,
                keyboard: document.documentElement.getAttribute('data-keyboard'),
                fieldTop: Math.round(rect?.top ?? -1),
                fieldBottom: Math.round(rect?.bottom ?? -1),
                gate: document.getElementById('fy-portrait-gate') !== null,
              };
            });
            if (after.focused !== 'pairing-link') fail('the pairing field lost focus before the capture');
            if (after.gate) fail('the portrait gate mounted over an upright phone with its keyboard open');

            const keyboardTarget = join(outDir, `${viewport.name}-onboarding-keyboard.png`);
            await page.screenshot({ path: keyboardTarget });
            // Printed, not assumed: a shot that silently failed to open the
            // keyboard looks exactly like one that did.
            process.stdout.write(
              `📸 ${viewport.name} setup pairing, keyboard open -> ${keyboardTarget}\n` +
                `   screen ${before.screenHeight}px and layout ${before.innerHeight}px unchanged at ` +
                `${after.screenHeight}px / ${after.innerHeight}px; visual viewport ${before.visual}px -> ` +
                `${after.visual}px; data-keyboard=${after.keyboard}; focus=#${after.focused} visible at ` +
                `${after.fieldTop}-${after.fieldBottom}px; portrait gate mounted=${after.gate}\n`,
            );
          }
        } catch (cause) {
          // The screen a wait gave up on, which the log alone cannot show: a timed-out wait names the
          // element it wanted, never what was there instead. Best effort — a crashed page has no frame.
          const target = join(outDir, `failure-${viewport.name}.png`);
          await page
            .screenshot({ path: target, timeout: 5_000 })
            .then(() => process.stderr.write(`📸 the screen at the failure -> ${target}\n`))
            .catch(() => undefined);
          throw cause;
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    }

    // THE SESSION PAGE'S LAYOUT — conversation width, the tab strip, nothing under a split pane — in
    // every theme family. Its own contexts and viewports, so it runs after the viewport passes.
    const owesSessionLayout = (WALKS_SETTINGS && walks(PASS_OWNER.sessionLayout)) || SESSION_LAYOUT_ONLY;
    const sessionLayoutChecks = owesSessionLayout
      ? await runSessionLayoutGeometry({
          browser,
          rootUrl: server.url.toString(),
          scheme: SCHEME,
          phone: PHONE_CONTEXT,
          fail,
          ...(SESSION_LAYOUT_ONLY ? { captureDir: outDir, captureFamilies: ['studio', 'neo', 'wayfinding'] } : {}),
        })
      : 0;
    if (owesSessionLayout && sessionLayoutChecks !== SESSION_LAYOUT_GEOMETRY_CHECKS)
      fail(
        `the run made ${sessionLayoutChecks} session layout geometry checks instead of the ` +
          `${SESSION_LAYOUT_GEOMETRY_CHECKS} it owes — a theme family or a mode was skipped`,
      );
    if (owesSessionLayout)
      process.stdout.write(
        `✅ session layout geometry checks: ${sessionLayoutChecks}/${SESSION_LAYOUT_GEOMETRY_CHECKS} in ${SCHEME}\n`,
      );
    else if (WALKS_SETTINGS) process.stdout.write(notOwedHere('session layout geometry', PASS_OWNER.sessionLayout));

    // THE BOTTOM SAFE-AREA INSET'S ONE OWNER, on a simulated home-indicator phone: at rest, keyboard up and
    // down, and rotated. Its own contexts, so it runs after the viewport passes.
    const owesSafeArea = (WALKS_SETTINGS && walks(PASS_OWNER.safeArea)) || SAFE_AREA_ONLY;
    const safeAreaChecks = owesSafeArea
      ? await runSafeAreaGeometry({
          browser,
          rootUrl: server.url.toString(),
          scheme: SCHEME,
          fail,
          keyboardShim: VISUAL_VIEWPORT_SHIM,
          ...(SAFE_AREA_ONLY ? { captureDir: outDir } : {}),
        })
      : 0;
    if (owesSafeArea && safeAreaChecks !== SAFE_AREA_GEOMETRY_CHECKS)
      fail(
        `the run made ${safeAreaChecks} safe-area geometry checks instead of the ` +
          `${SAFE_AREA_GEOMETRY_CHECKS} it owes — a screen or a scenario was skipped`,
      );
    if (owesSafeArea)
      process.stdout.write(
        `✅ safe-area geometry checks: ${safeAreaChecks}/${SAFE_AREA_GEOMETRY_CHECKS} in ${SCHEME}\n`,
      );
    else if (WALKS_SETTINGS) process.stdout.write(notOwedHere('safe-area geometry', PASS_OWNER.safeArea));

    // THE BOTTOM OF THE APP ACROSS THE DEVICE MATRIX, each in its own engine. A WebKit row with no WebKit on
    // this machine is reported as skipped, never counted as passed.
    if (VIEWPORT_MATRIX_ONLY) {
      const webkitPath = process.env.FY_WEBKIT;
      const engine: Browser | undefined =
        webkitPath === undefined || webkitPath === ''
          ? undefined
          : await webkit.launch({ executablePath: webkitPath, headless: true });
      try {
        const matrix = await runViewportMatrix({
          browsers: engine === undefined ? { chromium: browser } : { chromium: browser, webkit: engine },
          rootUrl: server.url.toString(),
          scheme: SCHEME,
          fail,
          keyboardShim: VISUAL_VIEWPORT_SHIM,
          captureDir: outDir,
        });
        if (matrix.checks !== matrix.owed)
          fail(`the viewport matrix made ${matrix.checks} checks instead of the ${matrix.owed} it owes`);
        process.stdout.write(`✅ viewport matrix checks: ${matrix.checks}/${matrix.owed} in ${SCHEME}\n`);
      } finally {
        await engine?.close();
      }
    }

    // THE SESSIONS PAGE'S SIDEWAYS SCROLL, on a phone at four widths and every density, with the worst text.
    const owesSessionsPage = (WALKS_SETTINGS && walks(PASS_OWNER.sessionsPage)) || SESSIONS_PAGE_ONLY;
    const sessionsPageChecks = owesSessionsPage
      ? await runSessionsPageGeometry({ browser, rootUrl: server.url.toString(), scheme: SCHEME, fail })
      : 0;
    if (owesSessionsPage && sessionsPageChecks !== SESSIONS_PAGE_GEOMETRY_CHECKS)
      fail(
        `the run made ${sessionsPageChecks} sessions page geometry checks instead of the ` +
          `${SESSIONS_PAGE_GEOMETRY_CHECKS} it owes — a width or a density was skipped`,
      );
    if (owesSessionsPage)
      process.stdout.write(
        `✅ sessions page geometry checks: ${sessionsPageChecks}/${SESSIONS_PAGE_GEOMETRY_CHECKS} in ${SCHEME}\n`,
      );
    else if (WALKS_SETTINGS) process.stdout.write(notOwedHere('sessions page geometry', PASS_OWNER.sessionsPage));

    // THE CLOSING LINE, and the only one the CI script insists on. It is reached after every viewport
    // this run walks has completed, so a run that died halfway prints nothing here and the job goes red on a
    // missing sentinel rather than on a green summary nobody re-reads. A tally that is short is the
    // same failure as an assertion that broke: in both cases a surface this gate is supposed to be
    // measuring was not measured.
    const owed = WALKS_SETTINGS ? owedOver(SETTINGS_SIDEWAYS_CHECKS) : 0;
    if (sidewaysChecks !== owed)
      fail(
        `the run made ${sidewaysChecks} sideways-scroll checks instead of the ${owed} this mode owes — ` +
          (WALKS_SETTINGS
            ? `a Settings surface was added, removed or skipped, so either restore the call site or ` +
              `update SETTINGS_SIDEWAYS_CHECKS and say in the pull request which frames the gate ` +
              `covers now`
            : `a narrow mode reached the Settings block and left it part-way, which means it no longer ` +
              `skips Settings cleanly`),
      );
    const owedGeometry = WALKS_SETTINGS ? owedOver(MACHINES_GEOMETRY_CHECKS) : 0;
    if (machinesGeometryChecks !== owedGeometry)
      fail(
        `the run made ${machinesGeometryChecks} Machines geometry checks instead of the ${owedGeometry} this mode ` +
          `owes — a Machines frame was added, removed or skipped, so either restore the call site or update ` +
          `MACHINES_GEOMETRY_CHECKS and say in the pull request which frames the gate covers now`,
      );
    if (WALKS_SETTINGS)
      process.stdout.write(
        `✅ settings sideways-scroll checks: ${sidewaysChecks}/${owed} in ${SCHEME} at ${VIEWPORT_LABEL}\n`,
      );
    const owedTerminal = WALKS_SETTINGS ? owedOver(TERMINAL_GEOMETRY_CHECKS) : 0;
    if (terminalGeometryChecks !== owedTerminal)
      fail(
        `the run made ${terminalGeometryChecks} terminal geometry checks instead of the ${owedTerminal} this mode ` +
          `owes — a theme family was skipped or the loop ended early`,
      );
    if (WALKS_SETTINGS)
      process.stdout.write(
        `✅ machines geometry checks: ${machinesGeometryChecks}/${owedGeometry} in ${SCHEME} at ${VIEWPORT_LABEL}\n`,
      );
    if (WALKS_SETTINGS)
      process.stdout.write(
        `✅ terminal geometry checks: ${terminalGeometryChecks}/${owedTerminal} in ${SCHEME} at ${VIEWPORT_LABEL}\n`,
      );
    if (trustedTypesViolations.length > 0)
      fail(`Trusted Types refused ${trustedTypesViolations.length} write(s):\n${trustedTypesViolations.join('\n')}`);
    process.stdout.write(`✅ no Trusted Types violation under "${TRUSTED_TYPES_POLICY}"\n`);
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
}
