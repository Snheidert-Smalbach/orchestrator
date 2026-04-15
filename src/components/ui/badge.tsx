import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "secondary" | "info" | "success" | "warning" | "danger";

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
}) {
  return <span className={cn("ui-badge", `ui-badge--${variant}`, className)} {...props} />;
}
