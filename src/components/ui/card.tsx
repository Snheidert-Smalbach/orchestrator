import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Card({
  className,
  tone = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  tone?: "default" | "muted" | "accent" | "danger" | "warning";
}) {
  return <div className={cn("ui-card", `ui-card--${tone}`, className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-card__header", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("ui-card__title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("ui-card__description", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-card__content", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-card__footer", className)} {...props} />;
}
