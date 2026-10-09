# Vox Live Server Test Setup

This guide shows the fastest way to put Vox on a live URL for testing before the event.

The recommended path is:

1. push the project to GitHub
2. deploy it on Vercel
3. add the environment variables in Vercel
4. test the host and listener flows on real phones

## Recommended option: Vercel

Vox is already built as a Next.js app, so Vercel is the simplest test hosting option.

## What you need

- a GitHub account
- a Vercel account
- your LiveKit Cloud project
- these environment values:
  - `LIVEKIT_URL`
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
  - `HOST_PASSCODE`
  - `ROOM_NAME`
  - `NEXT_PUBLIC_PROGRAMME_NAME`

## Step 1: prepare your environment values

Use `.env.local` on your machine as the source of truth.

Important:

- do not commit secrets to GitHub
- do not paste LiveKit secrets into client-side code
- only add secrets through Vercel Project Settings

Suggested values:

```env
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
HOST_PASSCODE=your-host-passcode
ROOM_NAME=vox-main-room
NEXT_PUBLIC_PROGRAMME_NAME=Your Programme Name
```

## Step 2: push the project to GitHub

If this project is not already on GitHub:

```bash
git init
git add .
git commit -m "Prepare Vox for deployment"
```

Create a GitHub repository, then push:

```bash
git remote add origin https://github.com/your-name/your-repo.git
git branch -M main
git push -u origin main
```

## Step 3: import the project into Vercel

1. Go to `https://vercel.com`
2. Click `Add New...` -> `Project`
3. Import the GitHub repository for Vox
4. Let Vercel detect it as a Next.js app
5. Do not deploy yet until the environment variables are added

## Step 4: add environment variables in Vercel

In the Vercel project:

1. open `Settings`
2. open `Environment Variables`
3. add all six values:
   - `LIVEKIT_URL`
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
   - `HOST_PASSCODE`
   - `ROOM_NAME`
   - `NEXT_PUBLIC_PROGRAMME_NAME`
4. make sure they are available to at least:
   - `Production`
   - `Preview`

Then redeploy or trigger the first deployment.

## Step 5: deploy

After the environment variables are saved:

1. go back to `Deployments`
2. deploy the project
3. wait for the Vercel URL, for example:
   - `https://vox-yourproject.vercel.app`

## Step 6: run a real-world test

Test both pages on the deployed URL:

- listener page: `https://your-url/`
- host page: `https://your-url/host`

Recommended test flow:

1. Open `/host` on the host laptop
2. Enter the host display name and `HOST_PASSCODE`
3. Allow microphone access
4. Select the real mixer/audio interface
5. Go live
6. Open `/` on at least one phone
7. Join as a listener
8. Confirm:
   - audio is heard clearly
   - live timer is visible
   - comments appear in real time
   - reactions appear in real time
   - pause and resume work
   - reconnecting works if you switch network briefly

## Step 7: optional custom domain

If you want a cleaner test link:

1. open the Vercel project
2. go to `Settings` -> `Domains`
3. add your domain or subdomain
4. follow the DNS instructions from Vercel

Example:

- `vox.yourchurch.org`

## If you want to use a VPS instead

This is possible, but Vercel is easier for testing.

Basic VPS flow:

1. copy the project to the server
2. install Node.js 20+
3. create a `.env.local` file on the server
4. run:

```bash
npm install
npm run build
npm start
```

5. reverse proxy the app with Nginx or Caddy
6. enable HTTPS

For a quick test, Vercel is still the better option.

## Troubleshooting

### Host passcode is rejected

- confirm `HOST_PASSCODE` is set in Vercel
- redeploy after changing env vars

### Listener joins but hears nothing

- confirm the host is actually live
- confirm the correct audio input is selected
- check phone media volume
- tap `Tap to turn on sound` if autoplay is blocked

### Token API says env vars are missing

- one or more Vercel environment variables are missing
- check spelling exactly
- redeploy after fixing them

### Comments or reactions do not appear

- confirm both users are in the same `ROOM_NAME`
- confirm the deployment uses the correct LiveKit project credentials

## Recommended final check before the real programme

- test on mobile data, not only Wi-Fi
- test with the actual mixer or audio interface
- keep the host laptop on power
- disable sleep on the host laptop
- keep a backup host device ready
- keep the Vercel project and LiveKit dashboard accessible
