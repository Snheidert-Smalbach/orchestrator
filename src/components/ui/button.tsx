import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type ButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "warning"
  | "success";

type ButtonSize = "sm" | "md" | "lg" | "icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
};

export const buttonVariants = {
  variant: {
    default: "ui-button--default",
    secondary: "ui-button--secondary",
    outline: "ui-button--outline",
    ghost: "ui-button--ghost",
    destructive: "ui-button--destructive",
    warning: "ui-button--warning",
    success: "ui-button--success",
  },
  size: {
    sm: "ui-button--sm",
    md: "ui-button--md",
    lg: "ui-button--lg",
    icon: "ui-button--icon",
  },
} as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "md", busy = false, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "ui-button",
        buttonVariants.variant[variant],
        buttonVariants.size[size],
        busy && "is-busy",
        className,
      )}
      disabled={disabled || busy}
      {...props}
    />
  );
});
