import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentPropsWithoutRef, ElementRef, Ref } from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export const ScrollArea = forwardRef<
  ElementRef<typeof ScrollAreaPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportClassName?: string;
    viewportProps?: ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>;
    viewportRef?: Ref<HTMLDivElement>;
  }
>(function ScrollArea({ className, children, viewportClassName, viewportProps, viewportRef, ...props }, ref) {
  return (
    <ScrollAreaPrimitive.Root ref={ref} className={cn("ui-scroll-area", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className={cn("ui-scroll-area__viewport", viewportClassName)}
        {...viewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="ui-scroll-area__scrollbar">
        <ScrollAreaPrimitive.Thumb className="ui-scroll-area__thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="ui-scroll-area__corner" />
    </ScrollAreaPrimitive.Root>
  );
});
