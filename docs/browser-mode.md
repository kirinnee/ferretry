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
- **The same profile.** Both modes use the machine's one persistent agent profile, so what you sign in to
  in a Real window stays signed in, for you and for your agents, until you sign out.

Both modes keep Chrome's loopback debugging port, because that is what the view streams through and the
agent tools drive. **Neither mode passes an automation switch** — no `--enable-automation`, and no
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
