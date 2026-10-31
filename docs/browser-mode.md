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
not hide it. In a Real window `navigator.webdriver` is `false` because nothing about the browser is
automated until an agent acts on a page.

## Your input is your own

When you take a page over, your pointer and keyboard reach Chrome the moment they arrive, as trusted
input with your own timing — nothing is batched, smoothed or delayed. One thing is added: a tap or click
that arrives at a point the pointer never moved to (a phone tap, typically) is preceded by a single move
to that point, because a real pointer is always somewhere before it presses. No curve, jitter or delay
is ever invented.

## Captchas and "checking your browser" pages

Ferretry **never solves, skips or works around** a captcha or a bot check. What it does:

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
