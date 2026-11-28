Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Discord says when the Mac sleeps and when it is back — (v1.41.0)

### Added

- **Each room followed on Discord is told when the Mac goes to sleep and when it wakes.** Until
  now a closed lid put the Mac to sleep with no word, and a sleeping Mac looked the same as a quiet
  room. Just before the system sleeps, each followed room gets one `💤 Mac is going to sleep` post;
  on waking, each room that was told and is still followed gets one `☀️ Back (asleep N min)`, in
  hours or days for a long sleep. Each notice is posted once.
- **A 💤 that could not reach Discord before the sleep is posted after waking, marked
  `(delayed)`, before the ☀️.** The app waits at most a moment for the notice to be saved, then
  lets the Mac sleep. If the app quits before the notice is saved or posted, that notice is lost.
