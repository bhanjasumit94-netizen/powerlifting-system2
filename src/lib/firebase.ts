import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getDatabase, type Database } from "firebase/database";

const apiKey = (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined)?.trim() ?? "";
const authDomain = (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)?.trim() ?? "";
const databaseURL = (import.meta.env.VITE_FIREBASE_DATABASE_URL as string | undefined)?.trim() ?? "";
const projectId = (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined)?.trim() ?? "";
const storageBucket = (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined)?.trim() ?? "";
const messagingSenderId = (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined)?.trim() ?? "";
const appId = (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined)?.trim() ?? "";

const hasPlaceholder =
  apiKey.includes("your-api-key") ||
  databaseURL.includes("your-project") ||
  projectId.includes("your-project");

/** When false the app uses localStorage only; all Firebase calls are skipped. */
export const isFirebaseConfigured = Boolean(
  apiKey && databaseURL && projectId && !hasPlaceholder,
);

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Database | null = null;

if (isFirebaseConfigured) {
  _app =
    getApps().length === 0
      ? initializeApp({ apiKey, authDomain, databaseURL, projectId, storageBucket, messagingSenderId, appId })
      : getApps()[0];
  _auth = getAuth(_app);
  _db = getDatabase(_app);
}

export const firebaseApp = _app;
export const firebaseAuth = _auth;
export const firebaseDb = _db;
