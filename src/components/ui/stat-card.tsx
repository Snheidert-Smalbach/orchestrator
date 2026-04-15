import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function StatCard({
  label,
  value,
  icon,
  description,
  className,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn("ui-stat-card", className)}>
      <div className="ui-stat-card__header">
        <span className="ui-stat-card__label">{label}</span>
        {icon ? <span className="ui-stat-card__icon">{icon}</span> : null}
      </div>
      <div className={cn("ui-stat-card__value", valueClassName)}>{value}</div>
      {description ? <p className="ui-stat-card__description">{description}</p> : null}
    </div>
  );
}
