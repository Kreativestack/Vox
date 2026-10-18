# Vox

Vox is a simple live audio streaming web app for church youth programmes. One host broadcasts live audio, listeners join without logging in, and everyone can comment and react in real time.

This v1 is intentionally narrow: one room, no database, no recordings, no accounts, and no listener speaking.

## What it includes

- Listener page at `/` with:
  - name-only join flow
  - live status
  - listener count
  - live comments
  - reaction bar with floating reactions
  - autoplay fallback button for mobile browsers
- Host page at `/host` with:
  - passcode-protected entry
  - go live / pause controls
  - audio input selection
  - music mode toggle for mixer-friendly audio capture
  - listener moderation from the comment feed
- Server-minted LiveKit tokens
- No LiveKit secret exposed to the browser

## Tech stack

- Next.js App Router
- LiveKit Cloud
- `livekit-client`
- `@livekit/components-react`
- `livekit-server-sdk`

## Environment variables

Copy `.env.example` to `.env.local` and fill in the values:

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
HOST_PASSCODE=choose-a-strong-host-passcode
ROOM_NAME=vox-main-room
NEXT_PUBLIC_PROGRAMME_NAME=Youth Live Saturday
```

Notes:

- `LIVEKIT_URL` should use the WebSocket project URL from LiveKit Cloud.
- The moderation API converts that URL to HTTPS internally for server-side Room API calls.
- `NEXT_PUBLIC_PROGRAMME_NAME` is what shows inside the room. The app name stays `Vox`.

## LiveKit Cloud setup

1. Create a LiveKit Cloud project.
2. Copy the project URL into `LIVEKIT_URL`.
3. Create an API key and secret.
4. Put the key in `LIVEKIT_API_KEY` and the secret in `LIVEKIT_API_SECRET`.
5. Choose a room name for `ROOM_NAME`.
6. Choose a strong host-only passcode for `HOST_PASSCODE`.

## Run locally

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Then open:

- Listener view: `http://localhost:3000`
- Host view: `http://localhost:3000/host`

## Host studio mixer and audio interfaces

Vox now includes a host-only mixer panel in `/host` with device switching, channel strips, metering, loudness readout, sound check tools, and a single processed LiveKit track for listeners.

### Connecting a mixer or audio interface

1. Plug in the USB microphone, mixer, sound desk, or audio interface before opening `/host` when possible.
2. In the host studio, tap `Enable studio audio` and allow microphone access in the browser.
3. Choose the device from `Main input`.
4. If the interface sends the church mix on only one side, change the channel mode to `Left only` or `Right only`.
5. Speak or play programme audio during `Sound check` until the meter stays in green and the loudness status reads `Good`.
6. Use headphones before turning on `Headphone monitoring` so the host hears the same processed mix without feedback.

### Recommended presets

- `Laptop mic`
  - Best for a built-in laptop microphone or simple USB headset.
  - Turns off Music Mode, adds stronger speech processing, and enables RNNoise by default.
- `Mixer / Sound desk feed`
  - Best for a USB mixer or an audio interface connected to the church desk.
  - Keeps Music Mode on and leaves voice cleanup off so singing and instruments stay natural.
- `Podcast mic`
  - Best for a dedicated spoken-word microphone.
  - Uses speech compression and RNNoise for a tighter, cleaner vocal sound.
- `Worship music`
  - Best for full worship sessions, backing tracks, instruments, and choir-heavy feeds.
  - Keeps Music Mode on, leaves cleanup off, and uses gentler compression.

### Troubleshooting

- `Device not showing`
  - Tap `Refresh devices`.
  - Confirm the browser has microphone permission.
  - Reconnect the USB cable or interface power and wait a moment for the list to refresh.
- `Permission denied`
  - Use the browser address bar to allow microphone access for the site, then refresh devices.
  - In Chrome or Edge, reopen `/host` after granting permission if labels still look blank.
- `Echo or feedback`
  - Turn `Headphone monitoring` off unless the host is wearing headphones.
  - Use `Laptop mic` only for built-in microphones; use `Mixer / Sound desk feed` or `Worship music` for church desk feeds.
  - Keep speakers away from open microphones.
- `Audio too quiet`
  - Raise the channel gain a little and confirm the meter reaches green during sound check.
  - Check whether the interface feed is only on the left or right channel and select the matching channel mode.
  - Aim for the loudness status to read `Good`, around `-16 LUFS`.
- `Audio distorted or clipping`
  - Lower the channel gain first, then the master fader if needed.
  - Watch the clip light and true-peak readout in the master strip.
  - If the church mixer is already clipping before it reaches Vox, lower the send from the physical mixer.

## Deploy to Vercel

1. Push this project to GitHub.
2. Import it into Vercel as a Next.js project.
3. Add all environment variables from `.env.example` in the Vercel project settings.
4. Deploy.
5. Test both `/` and `/host` on the deployed URL before the event.

For a fuller step-by-step live server guide, see [LIVE_SERVER_TEST_SETUP.md](file:///c:/wamp64/www/mxlr-clone/LIVE_SERVER_TEST_SETUP.md).

## How Vox works

- Listeners join with only a display name.
- The host joins separately on `/host` with a passcode.
- Tokens are created in `app/api/token/route.ts`.
- Listener tokens can subscribe and send data messages, but cannot publish audio.
- Host tokens can publish audio.
- Identities are generated on the server so users cannot claim to be the host.
- Comments and reactions are real-time only for the current session. They are not stored anywhere in v1.

## Pre-event checklist

See [PRE_EVENT_CHECKLIST.md](file:///c:/wamp64/www/mxlr-clone/PRE_EVENT_CHECKLIST.md).

## Recommended dry run

- Test the host laptop with the actual mixer or audio interface you plan to use on Saturday.
- Join as a listener on Android and iPhone if possible.
- Verify listeners can hear clearly on mobile data, not only Wi-Fi.
- Confirm the host laptop will stay awake and plugged into power for the full programme.
- Keep one backup phone and one backup host device ready with the same environment values.

## Project structure

- `app/` - routes, layout, API routes
- `components/` - listener, host, and room UI
- `lib/` - shared LiveKit helpers and types

## Scope notes

This version does not include:

- user accounts
- recordings or replays
- multiple rooms
- listener speaking
- payments
- analytics
