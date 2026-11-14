import type { CSSProperties } from "react";
import clsx from "clsx";
import { initials } from "../lib/format";

interface AgentAvatarProps {
  name: string;
  color?: string;
  size?: "sm" | "md";
}

export function AgentAvatar({ name, color = "#FFFFFF", size = "md" }: AgentAvatarProps) {
  return (
    <span
      className={clsx("agent-avatar", `agent-avatar-${size}`)}
      style={{ "--avatar": color } as CSSProperties}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
