# Vox Pre-Event Checklist

## Before Saturday

- Dry run the full flow on the deployed URL:
  - host joins on `/host`
  - at least two listeners join on `/`
  - comments and reactions appear for everyone
- Test on mobile data, not just Wi-Fi.
- Confirm the chosen mixer or audio interface appears in the host audio input dropdown.
- Leave music mode on and verify speech, singing, and instruments sound clean.
- Test pausing and going live again without refreshing the host page.
- Check the autoplay fallback on Safari iPhone and Chrome Android.
- Confirm the host laptop is plugged in, sleep is disabled, and browser updates are paused.

## During setup

- Close heavy apps and browser tabs on the host laptop.
- Use stable power for the mixer, interface, and host machine.
- Keep one extra phone in the room as a real listener monitor on mobile data.
- Keep the host passcode handy with the event lead only.

## Backup plan

- Have one second host device ready with the same Vercel URL and host passcode.
- Keep one backup audio path ready:
  - direct laptop mic if the mixer fails
  - or a second audio interface if available
- If listeners report silence, first check:
  - selected input
  - host live status
  - browser mic permission
  - laptop output accidentally chosen instead of the mixer input
