import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Checkbox(
  { className, type, ...props },
  ref,
) {
  return <input ref={ref} type={type ?? "checkbox"} className={cn("ui-checkbox", className)} {...props} />;
});
