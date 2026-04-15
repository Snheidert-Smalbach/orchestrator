import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

type DialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  variant?: "modal" | "drawer";
  widthClassName?: string;
  contentClassName?: string;
  bodyClassName?: string;
};

export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  variant = "modal",
  widthClassName,
  contentClassName,
  bodyClassName,
}: DialogShellProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-overlay" />
        <Dialog.Content
          className={cn(
            "ui-dialog-content",
            variant === "drawer" ? "ui-dialog-content--drawer" : "ui-dialog-content--modal",
            widthClassName,
            contentClassName,
          )}
        >
          <div className="ui-dialog-header">
            <div className="ui-dialog-heading">
              <Dialog.Title className="ui-dialog-title">{title}</Dialog.Title>
              {description ? <Dialog.Description className="ui-dialog-description">{description}</Dialog.Description> : null}
            </div>
            <div className="ui-dialog-actions">
              {actions}
              <Dialog.Close className="ui-dialog-close" aria-label="Cerrar">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
          </div>
          <div className={cn("ui-dialog-body", bodyClassName)}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
