import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { dbRefereeSessions } from "@/lib/db";
import { isFirebaseConfigured } from "@/lib/firebase";

const LOG_SESSION = "[Session:Referee]";

interface UseRefereSessionValidationResult {
  sessionId: string | null;
  isValid: boolean;
  isLoading: boolean;
  error: string | null;
  competitionId: string | null;
}

export function useRefereSessionValidation(): UseRefereSessionValidationResult {
  const [searchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [competitionId, setCompetitionId] = useState<string | null>(null);

  useEffect(() => {
    const validateSessionFromUrl = async () => {
      try {
        const urlSessionId = searchParams.get("session") || searchParams.get("sid");
        const cidFromUrl = searchParams.get("cid") || searchParams.get("competition_id");
        setSessionId(urlSessionId);
        setCompetitionId(cidFromUrl);

        console.log(LOG_SESSION, "referee station validating", {
          urlSessionId,
          cidFromUrl,
          firebaseConfigured: isFirebaseConfigured,
          fullSearch: searchParams.toString(),
        });

        // Offline / unconfigured — allow access without DB session check.
        if (!isFirebaseConfigured) {
          console.log(LOG_SESSION, "offline mode — skipping session validation");
          setIsValid(true);
          setError(null);
          setIsLoading(false);
          return;
        }

        if (!urlSessionId) {
          console.warn(LOG_SESSION, "no session ID in URL");
          setIsValid(false);
          setError("No session provided. Generate a QR code from the admin panel first.");
          setIsLoading(false);
          return;
        }

        if (!cidFromUrl) {
          console.warn(LOG_SESSION, "no competition ID (cid) in URL");
          setIsValid(false);
          setError("No competition ID in link. Regenerate the QR code from the admin panel.");
          setIsLoading(false);
          return;
        }

        console.log(LOG_SESSION, "looking up session in Firebase", {
          path: `referee_sessions/${cidFromUrl}/${urlSessionId}`,
        });

        const session = await dbRefereeSessions.validate(urlSessionId, cidFromUrl);

        if (session) {
          console.log(LOG_SESSION, "session valid", {
            sessionId: session.id,
            competitionId: session.competition_id,
            expiresAt: session.expires_at,
          });
          setIsValid(true);
          setError(null);
        } else {
          console.warn(LOG_SESSION, "session invalid or not found", { urlSessionId, cidFromUrl });
          setIsValid(false);
          setError("Session expired or invalid. Please generate a new referee session from the admin panel.");
        }
      } catch (err) {
        console.error(LOG_SESSION, "session validation threw an error", err);
        setIsValid(false);
        setError("Failed to validate session. Check your connection and try again.");
      } finally {
        setIsLoading(false);
      }
    };

    validateSessionFromUrl();
  }, [searchParams]);

  return { sessionId, isValid, isLoading, error, competitionId };
}
