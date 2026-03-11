# Voice Sentinel - Web App

Voice Sentinel is a browser-based audio forensics UI with live backend integration for authentication, prediction, history, comparison, exports, and account management.

The app now uses session-only in-memory state in the browser runtime and does not persist user/session data in localStorage.

## Stack

- HTML for structure and screens
- CSS for layout, theming, and responsive behavior
- Vanilla JavaScript for state, navigation, recording, uploads, and API integration

No build step is required.

## Run locally

1. Open the folder in a terminal.
2. Serve it with a static server:

```bash
npx serve .
```

or

```bash
python3 -m http.server 8080
```

3. Open the shown local URL (for example `http://localhost:8080`).

## Backend and API base

- Local/dev: `http://45.55.247.199/api`
- Vercel (`*.vercel.app`): `/api` (proxied by `vercel.json`)

## Supported audio formats

- WAV
- MP3

M4A is not supported.

## Key API flows

- `POST /auth/register`
- `POST /auth/login`
- `GET /user/me`
- `PATCH /user/update`
- `POST /auth/change-password`
- `DELETE /user/terminate`
- `GET /system/stats`
- `POST /forensics/predict`
- `GET /forensics/history`
- `DELETE /forensics/history/clear`
- `GET /forensics/compare`
- `GET /forensics/analysis/:sample_id`
- `GET /forensics/sample/:sample_id`
- `POST /forensics/feedback`
- `GET /export/results`
- `GET /export/csv`
- `POST /api/utility/uploads` (hidden upload page)

## Hidden Send to Server page

There is a hidden page called **Send to Server** for direct file uploads (any file type).

Open it via URL:

- `/#send-to-server`
- or `/?page=send-to-server`

It is intentionally not shown in the sidebar navigation.

## Forensics predict payload

`POST /forensics/predict` uses multipart form-data and sends:

- `file`
- `user_id` (when available)
- `recording_input_type`

`recording_input_type` values:

- `upload`
- `live_source`
- `live_user`

## Auth behavior

- Sign up does not auto-login.
- After successful registration, the UI switches back to sign-in mode and asks the user to log in.

## Prediction feedback payload

After a prediction is shown in Audio Breakdown, the UI asks the user to vote on whether the prediction was correct.

- The feedback prompt is shown as a modal popup immediately after prediction.
- The confidence percentage is displayed to users as **SentinelScore**.

`POST /forensics/feedback` sends JSON:

- `sample_id`
- `user_id` (nullable)
- `vote` (`correct` or `incorrect`)
- `predicted_verdict`
- `predicted_confidence`
- `corrected_verdict` (nullable, used when vote is `incorrect`)
- `feedback_notes` (nullable)
- `recording_input_type` (`upload`, `live_source`, or `live_user`)

## Deploy to Vercel

The app is static and can be deployed directly from the repository.

- `vercel.json` rewrites `/api/:path*` to `http://45.55.247.199/api/:path*`.
- This keeps browser API calls same-origin on Vercel.
