# Powerlifting Meet Manager

A real-time powerlifting competition management app. Handles lifter registration, group management, referee signaling, live scoring displays, and competition control across multiple devices.

## Architecture

- **Frontend**: React 18 + TypeScript + Vite SPA, styled with Tailwind CSS and Radix UI
- **Real-time sync**: Firebase Realtime Database (optional — app works offline with localStorage fallback)
- **Auth**: Firebase Email/Password (admin-only login; referee devices use QR session links)
- **Routing**: React Router with HashRouter (enables static hosting)

## Running the app

```bash
PORT=5000 npm run dev
```

The workflow "Start application" runs this automatically.

## Key files

- `src/App.tsx` — entire app state, routing, and business logic (~10k lines)
- `src/lib/firebase.ts` — Firebase init (gracefully disabled if env vars missing)
- `src/lib/db.ts` — Firebase RTDB read/write helpers
- `src/lib/useSupabaseSync.ts` — real-time competition sync hook (uses Firebase despite the name)
- `src/lib/types.ts` — TypeScript types for the competition data model
- `src/hooks/useRefereSessionValidation.ts` — QR session validation for referee devices

## Environment variables

| Variable | Purpose |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase project API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Auth domain |
| `VITE_FIREBASE_DATABASE_URL` | Firebase Realtime Database URL |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase Storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |

All are set as `VITE_*` env vars (safe for a Vite SPA — no server-side secrets).

## Offline mode

If Firebase env vars are missing or invalid, the app automatically falls back to localStorage. All competition data is stored locally; referee sync and multi-device features are disabled.

## User preferences

- Keep the single-file App.tsx structure (user's preference — do not split unless asked)
- The app is a pure SPA; no server-side backend needed beyond Firebase
