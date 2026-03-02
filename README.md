# Voice Sentinel – Web App (UI only)

A web UI version of the Voice Sentinel mobile app. Same look and flow; **no backend or recording APIs connected yet**.

## Stack

- **HTML** – structure and screens
- **CSS** – theme (colors, cards, buttons from the Flutter app), layout, responsive
- **Vanilla JS** – navigation, drawer, dark mode, mock “record” and “upload” behaviour

No build step, no framework. Easy to open and tweak; you can plug in APIs later with `fetch()` or any client library.

## Run locally

1. Open the folder in a terminal.
2. Serve the folder (so links work without file://):

   ```bash
   npx serve .
   ```
   or
   ```bash
   python3 -m http.server 8080
   ```
   then open `http://localhost:8080` (or the port shown).

   Or open `index.html` directly in a browser (some features may be limited under `file://`).

## Screens

- **Welcome** – Logo, “Sign In / Sign Up”, “Skip & Continue”; auth form (email, password, user type).
- **Home** – Deepfake Detection hero, Ready to Scan card, Audio Preview (mock waveform when “recording”), Upload Audio card, Recent Recordings list, “Analyze Audio” / “Stop Recording”, “View History”.
- **Settings** – Dark mode toggle, Audio (placeholder), Account (placeholder).
- **Change user type** – Dropdown + Save (stored in `localStorage`).
- **Audio breakdown** – Placeholder “No recording selected”.

## Theme

Matches the Flutter app:

- Primary blue: `#285BAE`, light blue: `#32B5E8`
- Light: background `#F8F9FA`, surface white
- Dark: background `#0D1321`, surface `#1A2332`
- Gradient buttons: light blue → primary blue

Dark mode is toggled in Settings and persisted in `localStorage`.

## Next steps (when you add APIs)

- Replace mock “Analyze Audio” / “Stop Recording” with real MediaRecorder or your backend flow.
- Replace “Upload Audio” with a file input and your upload endpoint.
- Replace “View History” and recording list with data from your API.
- Wire Sign In / Sign Up to your auth API.
