"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useRouter } from "next/navigation";

interface SourceToggleProps {
  sourceId: number;
  isActive: boolean;
  identifier: string;
}

export function SourceToggle({ sourceId, isActive, identifier }: SourceToggleProps) {
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(isActive);
  const router = useRouter();

  async function toggleActive() {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/sources/${sourceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !active }),
      });

      if (response.ok) {
        setActive(!active);
        router.refresh();
      } else {
        const data = await response.json();
        alert(data.error || "Failed to update source");
      }
    } catch (error) {
      alert("Failed to update source");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={active}
        onCheckedChange={toggleActive}
        disabled={loading}
        aria-label={`Toggle ${identifier} active status`}
      />
      <span className="text-xs text-muted-foreground">
        {active ? "Active" : "Inactive"}
      </span>
    </div>
  );
}
