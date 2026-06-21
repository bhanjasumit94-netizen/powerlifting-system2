import React from "react";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import type { RefereSignalState } from "@/lib/types";

interface RefereConnectionStatusProps {
  signals: RefereSignalState[];
  connectedReferees: { [key: string]: boolean };
}

export function RefereConnectionStatus({
  signals,
  connectedReferees,
}: RefereConnectionStatusProps) {
  const connectedCount = Object.values(connectedReferees).filter(Boolean).length;
  const totalReferees = 3;
  const allConnected = connectedCount === totalReferees;

  const getConnectionColor = () => {
    if (allConnected) return "bg-emerald-50 border-emerald-300";
    if (connectedCount > 0) return "bg-yellow-50 border-yellow-300";
    return "bg-red-50 border-red-300";
  };

  return (
    <Card className={`p-4 border-2 transition-all ${getConnectionColor()}`}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Connection Status</h3>
          <Badge
            variant={allConnected ? "default" : "secondary"}
            className="text-xs"
          >
            {connectedCount}/{totalReferees} Connected
          </Badge>
        </div>

        <div className="space-y-2">
          {["left", "center", "right"].map((position, idx) => (
            <div key={position} className="flex items-center justify-between text-sm">
              <span className="capitalize text-gray-700">{position}</span>
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full transition-colors ${
                    connectedReferees[position as keyof typeof connectedReferees]
                      ? "bg-green-500"
                      : "bg-gray-400"
                  }`}
                />
                <span className="text-xs text-gray-600">
                  {connectedReferees[position as keyof typeof connectedReferees]
                    ? "Online"
                    : "Offline"}
                </span>
              </div>
            </div>
          ))}
        </div>

        {allConnected && (
          <div className="text-xs text-emerald-600 font-medium text-center py-2 bg-emerald-100 rounded">
            All referees connected and ready
          </div>
        )}
      </div>
    </Card>
  );
}
