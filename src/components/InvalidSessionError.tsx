import React from "react";
import { CircleAlert as AlertCircle } from "lucide-react";

interface InvalidSessionErrorProps {
  error: string;
  isLoading?: boolean;
}

export function InvalidSessionError({ error, isLoading = false }: InvalidSessionErrorProps) {
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#05070f] text-white">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-slate-600 border-t-cyan-500 rounded-full animate-spin" />
          <p className="mt-4 text-slate-400">Validating session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#05070f] px-4">
      <div className="max-w-md text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-6">
          <AlertCircle className="w-8 h-8 text-red-500" />
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">Invalid Session</h1>
        <p className="text-slate-400 mb-6">{error}</p>

        <div className="space-y-3">
          <button
            onClick={() => window.location.reload()}
            className="w-full rounded-lg bg-cyan-500 px-4 py-3 font-semibold text-black hover:bg-cyan-400 transition"
          >
            Try Again
          </button>
          <button
            onClick={() => window.close()}
            className="w-full rounded-lg bg-white/10 px-4 py-3 font-semibold text-white hover:bg-white/20 transition"
          >
            Close Window
          </button>
        </div>

        <p className="mt-6 text-xs text-slate-500">
          If you continue to experience issues, please contact the referee coordinator.
        </p>
      </div>
    </div>
  );
}
