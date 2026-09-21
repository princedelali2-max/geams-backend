# GEAMS Real-Time Backend — Free Prototype Deployment

This gets the Civilian, LCR, Dispatch, Fire, Medical, and HQ apps talking to
each other across real devices and real networks — **without buying or
renting a server.** Two free services, no credit card for either:

| Piece | Free service | What it does |
|---|---|---|
| Real-time sync + call signaling | **Render.com** (free Web Service) | Hosts the Node.js server in this folder — incidents, chat, GPS positions, officer roster, all synced live between devices |
| Real camera/voice calls | **Open Relay Project** (metered.ca) | Free TURN relay — without this, calls will work on the same WiFi and silently fail to connect once people are on separate mobile networks, which defeats the point of testing across locations |

Both are genuinely free for this scale of use — this isn't a trial that
expires. Total setup time is about 15–20 minutes, done once.

---

## Part 1 — Deploy the sync server (Render, free)

### 1a. Put the code somewhere Render can see it

Render deploys from a GitHub repository. If you don't already have a GitHub
account, create one free at [github.com](https://github.com) — takes two
minutes, no card.

1. On GitHub, click **New repository**. Name it `geams-backend`. Keep it
   **Private** if you'd rather not make the code public (Render works with
   private repos too). Create it.
2. On the new repo's page, click **Add file → Upload files**, then drag in
   everything from this `backend/` folder (`server.js`, `package.json`,
   `README.md`, and the `public/` folder with `geams-client.js` inside it).
   Commit the upload.

### 1b. Create the free Web Service on Render

1. Sign up free at [render.com](https://render.com) (no card required for
   this).
2. Click **New → Web Service**, connect your GitHub account, and pick the
   `geams-backend` repo.
3. Fill in:
   - **Name**: `geams-backend` (or anything — this becomes part of your URL)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
4. Under **Environment Variables**, add one:
   - **Key**: `GEAMS_AUTH_TOKEN`
   - **Value**: a long random string — generate one by running this on any
     computer with Node installed, or just mash the keyboard for 30+
     random characters:
     ```
     node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
     ```
     Save this value somewhere — you'll paste it into all six apps in Part 3.
5. Click **Create Web Service**. Render will build and deploy — takes a
   couple of minutes the first time. When it's done, you'll have a URL like
   `https://geams-backend-xxxx.onrender.com`.

### 1c. What "free" means here, honestly

- **No card, no time limit, no trial** — this is Render's permanent free
  tier, not a countdown.
- **It sleeps after 15 minutes with no traffic**, and takes about a minute
  to wake back up on the next connection. During an active test — people
  actually using the apps — it stays awake the whole time, since every GPS
  update, chat message, and call keeps it busy. You'll only notice the wake
  delay if you leave everything alone for 15+ minutes and then start again;
  the apps already reconnect automatically once the server wakes, no manual
  action needed.
- **The filesystem is wiped on every sleep/restart** — this backend saves
  incident/chat state to a file so it survives normal restarts, but a free
  Render service's disk doesn't persist across a spin-down. In practice:
  during one continuous test session, everything stays intact; leave it
  overnight and come back, and stored incidents from the previous session
  will be gone (in-progress ones being actively synced won't be affected
  mid-session). Completely fine for testing the *real-time communication
  itself*, which is the point at this stage — worth knowing if you're
  also relying on it as a permanent incident log.
- **750 free hours/month** — more than enough for one service running
  continuously all month (a month has ~730 hours).

---

## Part 2 — Get free TURN for real camera/voice calls

Skip this if you're only testing incidents/chat/GPS right now — everything
in Part 1 works without it. Add this before testing calls between devices on
different networks (e.g. an officer on mobile data calling a civilian on
WiFi), because a public STUN server alone — what the apps fall back to
without this — only works when both sides have an unusually open network
path, which most real mobile connections don't.

1. Sign up free at [metered.ca](https://www.metered.ca) → **Open Relay**
   (no card required).
2. From your dashboard, find:
   - Your **app name** (the subdomain before `.metered.live`)
   - Your **TURN API key**

That's it — no server to run for this piece either. 20 GB/month of relayed
call traffic, free.

---

## Part 3 — Point every app at both services

Each of the six HTML apps has a config block near the top of `<head>`:

```html
<script>
window.GEAMS_BACKEND_URL = '';
window.GEAMS_AUTH_TOKEN  = '';
window.GEAMS_TURN_APP    = '';   // Civilian/Dispatch/Station only
window.GEAMS_TURN_KEY    = '';   // Civilian/Dispatch/Station only
</script>
```

Fill in:

```html
<script>
window.GEAMS_BACKEND_URL = 'wss://geams-backend-xxxx.onrender.com/ws';
window.GEAMS_AUTH_TOKEN  = '<the random token from step 1b>';
window.GEAMS_TURN_APP    = '<your app name from Part 2>';
window.GEAMS_TURN_KEY    = '<your TURN API key from Part 2>';
</script>
```

Note the URL uses **`wss://`**, not `https://` — same host, different
scheme, with `/ws` on the end.

**Every device needs the same `GEAMS_BACKEND_URL` and `GEAMS_AUTH_TOKEN`.**
`GEAMS_TURN_APP`/`GEAMS_TURN_KEY` only matter on Civilian, Dispatch, and
Station (the three with call features) — Fire, Ambulance, and HQ don't use
them.

Then distribute the six edited HTML files to each device the normal way —
email, a shared drive link, USB, whatever's easiest during testing. There's
no hosting step required for the HTML files themselves; each device just
opens its file in a browser.

---

## Checking it's actually working

```
https://geams-backend-xxxx.onrender.com/api/health
```

should return `{"ok":true,"keys":N,"clients":N}` in your browser.
`clients` goes up as real devices connect — open the Civilian app on your
phone and a different app on your laptop and watch that number move.

The real test: create an incident on the Civilian app on one device, and
watch it appear on a Station/LCR app open on a **completely different**
device on a **different network** (e.g. phone on mobile data, laptop on a
different WiFi) — without touching refresh. That's the thing this whole
setup exists to prove.

---

## When you're ready to move past the prototype

Nothing here needs to be thrown away — `server.js` is the same code either
way. Moving to production later is a matter of:
- Render's paid tier (or any VPS) instead of the free one, for no spin-down
  and a persistent disk.
- Metered's paid TURN tier (or self-hosted [coturn](https://github.com/coturn/coturn))
  once call volume exceeds 20 GB/month.
- Real per-user authentication instead of one shared token — see §6 of
  `geams-realtime-backend-spec.md` for the JWT-based upgrade path.
- A real SMS provider wired into `sendSms()` in `server.js` for emergency-
  contact alerts (see the comments there — Africa's Talking or Twilio, a
  few lines each).

None of that has to happen before you can start testing the real thing
today.
