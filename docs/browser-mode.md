# Browser mode

The machine's one agent browser — the Chrome the browser pane streams and the agents' browser tools
drive — runs in one of two modes, set per machine in `machine.yaml` (`browserMode`) or in the app under
Settings › a machine › **Browser** › **Browser mode**:

| Mode                     | What runs                                                                                                                              | For                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `headless` (the default) | Chrome with no window (`--headless=new`)                                                                                               | agents, and any server with no screen                   |
| `window` ("Real window") | a real, headed Chrome window: on **Linux** inside a private Xvfb display the daemon starts; on **macOS** a real window on your desktop | an owner who browses and signs in through it themselves |

The mode is read **every time the browser starts**, so a switch applies the next time it starts; a browser
already running keeps its mode until it stops (it stops on its own after 15 idle minutes, or with
`fy browser stop`). It is not a loosening ([config-files.md](config-files.md)): it changes how the one
browser draws, not what an agent may do with it, so it applies at once.

## What Real window changes

- **No `--headless`.** A site sees Chrome's own user agent, not `HeadlessChrome`, and the page renders
  the way a desktop Chrome does. (A headless browser is given the same honest user agent — see
  [browser-proxy.md](browser-proxy.md).)
- **The installed Google Chrome first.** In either mode the daemon prefers a real Google Chrome over a
  Chromium wherever each was found (`/usr/bin`, `/opt/google/chrome`, `PATH`, `~/Applications`).
- **Every window keeps painting.** Each page has its own window, and an agent may be driving, and a
  person watching, any of them at once — so the browser is told not to stop rendering a window that is
  not focused (`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`,
  `--disable-background-timer-throttling`).
- **Its own display, never yours.** On Linux the browser draws into an Xvfb this daemon starts on first
  use (`-nolisten tcp`) and stops with the daemon — never the host's `$DISPLAY`, and never the login
  window's display, which is served over VNC. A Linux host with no Xvfb refuses to start the browser with
  one sentence naming the install command (`sudo apt-get install -y xvfb`, or your manager's) or "set
  Browser mode back to Headless". The dev shell carries Xvfb on Linux.
- **Other users on the host cannot see it.** The display's unix socket is reachable by every local account,
  so the Xvfb is started with `-auth` and a random cookie kept in a `0600` file under the daemon's own
  `0700` state directory (`browser/x11/`); the browser and the login window's x11vnc are handed it through
  `XAUTHORITY`, and the file is removed when the daemon stops. Without the cookie another user could
  screenshot the window or type into it.
- **The same profile.** Both modes use the machine's one persistent agent profile, so what you sign in to
  in a Real window stays signed in, for you and for your agents, until you sign out.

Both modes keep Chrome's loopback debugging port, because that is what the view streams through and the
agent tools drive. (A DevTools pipe transport, `--remote-debugging-pipe`, also exists; it is not on by default.)
On Linux the daemon talks to that port only once the kernel shows it is held by the Chrome it just started
— the same proof the login window's x11vnc port passes before its port, password and ssh line are shown —
so a program another account bound there first is refused with one sentence naming the port and its uid
("port N is held by another program (uid U), not this browser — …"). macOS has no `/proc` to prove it from
and starts as before. **Neither mode passes an automation switch** — no `--enable-automation`, and no
`--disable-blink-features=AutomationControlled` either: Ferretry does not announce automation and does
not hide it — **unless stealth is in effect** ([Stealth](#stealth)). In a Real window `navigator.webdriver` is `false` because nothing about the browser is
automated until an agent acts on a page.

## Your input is your own

When you take a page over, your pointer and keyboard reach Chrome the moment they arrive, as trusted
input with your own timing — nothing is batched, smoothed or delayed. One thing is added: a tap or click
that arrives at a point the pointer never moved to (a phone tap, typically) is preceded by a single move
to that point, because a real pointer is always somewhere before it presses. No curve, jitter or delay
is ever invented.

## Typing something sensitive from the command line

`fy browser page type <page> <target> [text…]` (and `fy browser type`) take the text as words, as they always did. **A word on
the command line is not private**: every user of the machine can read it in `ps` and `/proc`, and it lands in shell
history. For anything sensitive give the text another way:

- `--stdin` reads it from standard input (one trailing newline is dropped): `pass show site | fy browser page type app '#pw' --stdin`.
  Leave the text off the command line when you use it.
- `--secret NAME` names a stored secret instead of carrying a value. **This is a declared gap, not a feature yet**: the
  Vault runs a command with a secret in that child's environment but has no way to hand one to a page act, and
  Ferretry never reads a secret back, so the verb says so and types nothing. Until the Vault grows a use that
  reaches a page, ask the owner to type it (`browser_request_input`) or use `--stdin`.

Whatever the source, the typed text is never printed back: the answer, an error and `--json` show `[typed text]` where the
daemon echoed it, however it spelled it (as it is, as JSON writes it with `\"`, `\\`, `\n` and `\/`, as `\uXXXX`, or
percent-encoded in a URL). A value too short to hide without hiding the words around it (under three characters) is not
masked: an answer that repeats it is withheld whole, and says so.

## Where `--ferret` goes, and the older spellings

`--ferret <id>` (also `-s` and `--session`) may be written before the verb, between its words or after it
(`fy browser --session f1 page click app '#go'`); the one nearest the end wins. `browser close`, `browser goto` and
`browser login close` still work as `stop`, `navigate` and `login stop`.

A **ferret's own** whole-browser verbs (`fy browser click`, `navigate`, `status`, …) pass the same checks as its page
verbs: the owner's Browsers switch, its own browser only, a page that is its own, and nobody holding the page.

## Captchas and "checking your browser" pages

With stealth off (the default) Ferretry **never solves, skips or works around** a captcha or a bot check; the switch under [Stealth](#stealth) has no solver behind it yet. What it does:

1. **Recognises** a page that appears to be asking for one, from what the browser already knows about the
   page — its address, title and frame addresses — without running anything inside it: Cloudflare's
   "Just a moment…" and Turnstile, a visible reCAPTCHA or hCaptcha checkbox, Google's "unusual traffic"
   page, DataDome, Arkose and HUMAN (PerimeterX) challenges, and titles like "Verify you are human". An
   invisible widget (reCAPTCHA v3) is not flagged — it asks nobody anything. Each page in the browser
   status carries the hint as `challenge: { provider }`.
2. **Tells the person.** The browser pane shows a strip over that page: it appears to be asking you to
   prove you're a person; take the page over, solve it yourself, then hand it back.
3. **Tells the agent to stop.** An agent whose act lands on such a page is told it appears to be a human
   check, that it must not try to solve or get around it, and to ask its owner to take the page over.

The recognition is a hint, not a verdict: a check in a shape it has not seen is not flagged, and a page
that merely embeds a widget can be.

## Stealth

`config/browsers.yaml` has **one** stealth switch:

```yaml
stealth: off # off (the default) | on
identities:
  work:
    stealth: false # optional: this identity opts out while the switch is on
```

`on` opts in every identity on this machine (all of them are the owner's); an identity can only opt **out**
(`stealth: false`), never in by itself. Settings › a machine › **Browser** › **Stealth** is the same switch.

- **Off → on is a loosening** ([config-files.md](config-files.md)): it spends money (a captcha solver) and
  changes what the browser does, so the daemon **holds** it until the owner confirms it, and the tighter
  setting (off) stays in effect meanwhile. Dropping an identity's opt-out while the switch is on is held the
  same way. **On → off, and a new opt-out, apply at once.**
- **The hygiene layer is the first thing behind it** — and only for an identity whose stealth is in effect (the
  switch on and the identity not opted out); every other launch is byte for byte what it was:
  - **A real window, always.** Whatever Browser mode says, a stealth identity runs headful (on Linux, on the private Xvfb): a
    headless Chrome is the first thing a bot check reads.
  - **`navigator.webdriver` is turned off** with `--disable-blink-features=AutomationControlled`.
  - **No `Runtime.enable` trace.** The worker drives Chrome through `patchright-core` — the same Playwright release as
    the stock worker (one test pins both to `PLAYWRIGHT_REACHED_VERSION`), so the private reach `fields.ts` makes into
    Playwright, and the sealed pages, work unchanged — instead of `playwright-core`, which enables the DevTools Runtime
    domain on every page, a thing a page can detect. The price: **the page's console is not captured** in a stealth
    browser (that needs the same domain), and its console log says so first rather than looking like a quiet page.
  - **Time zone and language follow the proxy.** With a proxy, the exit's country and zone are read through it
    (`ipinfo.io`, asked with the same sign-in as the proxy test, once per launch) and set as the browser's `TZ`, `--lang` and
    `--accept-lang`, so the page's clock and `navigator.languages` match where it appears to be. Only a country the daemon has a
    language for sets one; an answer it cannot read, or no proxy at all, leaves the machine's own zone and language.
  - **What it needs.** Linux needs Xvfb (a launch without it is refused with the one-line fix, never started headless); on macOS
    the window is visible on the desktop. The stealth worker is about 13 MB larger (it carries `patchright-core` beside `playwright-core`).
  - **Turning it off does not touch a running browser.** `on` → `off` applies to the next launch: a stealth Chrome that is
    already running keeps running as it was until it closes or the machine's browser is restarted.
  - **GAP: the per-identity opt-out has no target yet.** `identities.<key>.stealth: false` is read and held to its rules, but
    the machine has ONE agent browser and it carries no identity key, so nothing asks the question per identity until
    identities get a browser each (Group C of the browser rework).
  - **No patched engine.** One was measured (fingerprint-chromium 150, fetched by hash, three runs per layer, direct IP) and it did
    worse than the stock browser with this layer: 3 of 7 checks against 5 of 7 (it fails the user-agent test and Navia's Cloudflare
    check never cleared), and it is an extra binary to download. So there is no engine switch.
  - Still to come, each on its own: a stable fingerprint per identity, a proxy per identity, a captcha solver.
- **The audit log** ([audit.md](audit.md)) records metadata only: `browser.stealth.switched` (from, to) when the switch
  really changes — a held `on` leaves no record until it is confirmed — and, as the layers arrive,
  `browser.stealth.session`, `browser.captcha.solve` and `browser.captcha.cap-reached` (identity key, never an
  email; hosts, kinds, outcomes, times, estimated cost). **Never** a token, a site key, a page, a cookie or a
  secret: the shapes are closed and tested for that.
- **Site terms.** Hiding that a browser is automated, and solving captchas, can break a site's terms of use.
  It is your call, site by site. Ferretry never signs in anywhere on its own beyond what you set up, and a bank
  can lock an account for unusual access.

## Honest limits

- **Some sites challenge anyway.** Plenty of sites score the network, not the browser: a datacenter IP —
  an EC2 or any cloud VM — is challenged, rate-limited or refused however ordinary the browser is. Real
  window cannot change where your traffic comes from; only running the daemon on a residential connection
  (your own machine) does.
- **A virtual screen has no GPU.** On Linux, Chrome under Xvfb renders WebGL in software (SwiftShader),
  and a site that fingerprints graphics can see that. Ferretry does not disguise it.
- **macOS windows are real windows.** In Real window mode on a Mac, each page the browser opens is a
  Chrome window on your desktop. They are not hidden or moved off-screen.
- **Agents share what you sign in to.** The profile is the machine's agent profile; anything you sign in
  to there, your agents can use. Use an incognito page (its own throwaway cookies) for anything they
  should not.

## Loopback ports

The agent browser's DevTools port, the proxy sign-in relay and the sign-in window's screen share are
listeners on this machine's loopback. By default (`browserPorts: random`) each gets a free port every
time. On a host that other people also log in to, any of them can reach those ports, so a host admin can
fence **fixed** ports per user with a firewall rule, and each user pins theirs in `machine.yaml`:

```yaml
browserPorts: per-user # random (default) | per-user | { cdp: 20004, relay: 20005, vnc: 20006 }
```

- `per-user` derives the ports from your user id: `base + (uid − 1000) × 4` for `cdp`, then `+1` for `relay`
  and `+2` for `vnc`. The base is 20000 unless the admin's firewall file moves it. A uid below 1000, or a
  port past 32767, is refused with a sentence; set explicit ports or ask for another base.
- Explicit ports are three different numbers between 1024 and 65535.
- It is read when the browser or the sign-in window starts, like Browser mode. `random` behaves exactly as
  before.
- `fy browser firewall entry` prints the one line to give your host admin for
  `/etc/ferretry/loopback-firewall.conf` (`user <uid>`, or `user <uid> <cdp> <relay> <vnc>`). It says
  "set browserPorts first" when you are on `random`.

### The firewall is read, never trusted blindly

While `browserPorts` is not `random`, the daemon reads the host's marker (`/run/ferretry/loopback-firewall.json`)
when the browser starts and every five minutes, and shows one of these states. Several can hold at once; the
first in this list wins.

| State        | Means                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------ |
| `failed`     | the last check connected to one of your ports as another user: the rule did not protect it |
| `missing`    | no marker, or the last check did not find your rule                                        |
| `stale`      | the marker does not list your user, or lists other ports for it                            |
| `unverified` | no check for 15 minutes: the 5-minute firewall check is not running                        |
| `applied`    | your ports are listed and a recent check agrees                                            |

Anything but `applied` is a warning: a note on the Browser tab, a line in `fy daemon status`, a row in
`fy doctor`, and a daemon notice each time the state **changes** (not every five minutes). Each says what to
ask the host admin. It never stops the browser by itself.

```yaml
browserFirewallFailure: warn # warn (default) | refuse
```

With `refuse`, a browser start on a fixed port is declined, with one sentence naming the remedy, while your own
user shows `failed`. A browser that is already running is not stopped. `unverified`, `missing` and `stale` only warn.
