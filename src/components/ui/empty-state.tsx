import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function EmptyState({
  title,
  description,
  icon,
  className,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ui-empty-state", className)}>
      {icon ? <div className="ui-empty-state__icon">{icon}</div> : null}
      <p className="ui-empty-state__title">{title}</p>
      <p className="ui-empty-state__description">{description}</p>
    </div>
  );
}
