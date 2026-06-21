import React from "react";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import type { RefereSignalState } from "@/lib/types";

interface RefereSlotCardProps {
  label: string;
  signalState: RefereSignalState;
}

export function RefereSlotCard({ label, signalState }: RefereSlotCardProps) {
  const getStatusColor = () => {
    switch (signalState.state) {
      case "IDLE":
        return "bg-gray-100 border-gray-300";
      case "CONNECTED":
        return "bg-blue-50 border-blue-300";
      case "SUBMITTED":
        return signalState.signal === "GOOD"
          ? "bg-emerald-100 border-emerald-400"
          : "bg-red-100 border-red-400";
      case "DELIVERED":
        return signalState.signal === "GOOD"
          ? "bg-emerald-200 border-emerald-500"
          : "bg-red-200 border-red-500";
      default:
        return "bg-gray-100 border-gray-300";
    }
  };

  const getSignalBadge = () => {
    if (!signalState.signal) return null;
    return (
      <Badge
        variant={signalState.signal === "GOOD" ? "default" : "destructive"}
        className="text-lg px-4 py-2"
      >
        {signalState.signal === "GOOD" ? "✓ GOOD LIFT" : "✗ NO LIFT"}
      </Badge>
    );
  };

  const getStatusIndicator = () => {
    if (signalState.state === "CONNECTED") {
      return (
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
          <span className="text-sm text-green-600 font-medium">Connected</span>
        </div>
      );
    }
    if (signalState.state === "SUBMITTED" || signalState.state === "DELIVERED") {
      return (
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-blue-500 rounded-full" />
          <span className="text-sm text-blue-600 font-medium">Signal Received</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 bg-gray-400 rounded-full" />
        <span className="text-sm text-gray-600 font-medium">Waiting</span>
      </div>
    );
  };

  return (
    <Card className={`p-6 border-2 transition-all ${getStatusColor()}`}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{label}</h3>
          {getStatusIndicator()}
        </div>

        <div className="min-h-16 flex items-center justify-center">
          {getSignalBadge() || (
            <span className="text-gray-500 text-sm">Awaiting signal...</span>
          )}
        </div>

        {signalState.submittedAt && (
          <div className="text-xs text-gray-600 text-center">
            Submitted: {signalState.submittedAt.toLocaleTimeString()}
          </div>
        )}
      </div>
    </Card>
  );
}
