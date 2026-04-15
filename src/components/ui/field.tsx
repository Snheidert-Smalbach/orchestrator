import type { HTMLAttributes, LabelHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function FieldGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-field-group", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("ui-field-label", className)} {...props} />;
}

export function FieldHint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("ui-field-hint", className)} {...props} />;
}

export function FieldRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-field-row", className)} {...props} />;
}

export function FieldLabelWrap({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("ui-field", className)} {...props} />;
}
