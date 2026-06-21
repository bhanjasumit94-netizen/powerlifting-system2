import React, { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Copy, RefreshCw, CircleCheck as CheckCircle, CircleAlert as AlertCircle, Loader as Loader2 } from "lucide-react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import type { DbRefereeSession } from "@/lib/types";
import { dbRefereeSessions } from "@/lib/db";

interface SessionManagerProps {
  competitionId: string;
  onSessionCreated?: (sessionId: string) => void;
  onSessionsRefreshed?: () => void;
}

export function SessionManager({
  competitionId,
  onSessionCreated,
  onSessionsRefreshed,
}: SessionManagerProps) {
  const [activeSessions, setActiveSessions] = useState<DbRefereeSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{type: 'success' | 'pending'; message: string} | null>(null);

  useEffect(() => {
    loadSessions();
  }, [competitionId]);

  const loadSessions = async () => {
    try {
      const sessions = await dbRefereeSessions.getActiveForCompetition(competitionId);
      setActiveSessions(Array.isArray(sessions) ? sessions : []);
      if (Array.isArray(sessions) && sessions.length > 0) {
        setCurrentSessionId(sessions[0].id);
      }
    } catch (error) {
      console.error("Failed to load sessions:", error);
    }
  };

  const createNewSession = async () => {
    setIsLoading(true);
    setActionFeedback({ type: 'pending', message: 'Creating new session...' });
    try {
      const session = await dbRefereeSessions.create(competitionId);
      setCurrentSessionId(session.id);
      setActiveSessions((prev) => [session, ...prev]);
      onSessionCreated?.(session.id);

      setActionFeedback({ type: 'success', message: 'Session created successfully!' });
      setTimeout(() => setActionFeedback(null), 3000);
      toast.success("New session created successfully");
    } catch (error) {
      console.error("Failed to create session:", error);
      setActionFeedback(null);
      toast.error("Failed to create session");
    } finally {
      setIsLoading(false);
    }
  };

  const refreshSessions = async () => {
    setIsLoading(true);
    setActionFeedback({ type: 'pending', message: 'Refreshing sessions...' });
    try {
      await dbRefereeSessions.invalidateAll(competitionId);
      setActiveSessions([]);
      setCurrentSessionId(null);
      onSessionsRefreshed?.();

      setActionFeedback({ type: 'success', message: 'All sessions cleared!' });
      setTimeout(() => setActionFeedback(null), 3000);
      toast.success("All sessions invalidated. Create a new session to continue.");
    } catch (error) {
      console.error("Failed to refresh sessions:", error);
      setActionFeedback(null);
      toast.error("Failed to refresh sessions");
    } finally {
      setIsLoading(false);
    }
  };

  const copySessionLink = async (sessionId: string) => {
    const baseUrl = window.location.origin;
    const link = `${baseUrl}/#/referee-session/${sessionId}?cid=${encodeURIComponent(competitionId)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Session link copied to clipboard");
    } catch (error) {
      console.error("Failed to copy:", error);
      toast.error("Failed to copy link");
    }
  };

  return (
    <Card className="p-6 border-2">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Referee Sessions</h3>
          <Badge variant="outline">
            {activeSessions.length} Active
          </Badge>
        </div>

        {actionFeedback && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={`flex items-center gap-2 p-3 rounded-lg ${
              actionFeedback.type === 'pending'
                ? 'bg-blue-50 text-blue-700 border border-blue-200'
                : 'bg-green-50 text-green-700 border border-green-200'
            }`}
          >
            {actionFeedback.type === 'pending' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle className="w-4 h-4" />
            )}
            <span className="text-sm font-medium">{actionFeedback.message}</span>
          </motion.div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={createNewSession}
            disabled={isLoading}
            className="flex-1"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create New Session'
            )}
          </Button>
          <Button
            onClick={refreshSessions}
            disabled={isLoading}
            variant="outline"
            size="icon"
            title="Refresh sessions"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {currentSessionId && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="p-4 bg-gradient-to-r from-blue-50 to-blue-100 border-2 border-blue-300 rounded-lg shadow-sm"
          >
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="w-4 h-4 text-blue-600" />
              <span className="text-xs font-semibold text-blue-900">Active Session</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm bg-white px-3 py-2 rounded border border-blue-200 font-mono overflow-auto text-gray-700">
                {currentSessionId}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copySessionLink(currentSessionId)}
                className="hover:bg-blue-200"
              >
                <Copy className="w-4 h-4" />
              </Button>
            </div>
          </motion.div>
        )}

        {activeSessions.length > 1 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-2 pt-2 border-t border-gray-200"
          >
            <h4 className="text-xs font-semibold text-gray-700">Other Active Sessions</h4>
            <div className="space-y-1 max-h-24 overflow-auto">
              {activeSessions.slice(1).map((session, idx) => (
                <motion.div
                  key={session.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="flex items-center justify-between text-xs p-2 bg-gray-50 hover:bg-gray-100 rounded border border-gray-200 transition-colors"
                >
                  <code className="font-mono text-gray-700">{session.id.slice(0, 8)}...</code>
                  <span className="text-gray-500">
                    {new Date(session.created_at).toLocaleTimeString()}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        <div className="text-xs text-gray-600 pt-2 border-t">
          <p>
            Click "Create New Session" to generate unique access links for referees. Each session
            expires after 24 hours.
          </p>
        </div>
      </div>
    </Card>
  );
}
