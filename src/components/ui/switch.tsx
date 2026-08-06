import * as React from "react";
import { cn } from "../../lib/utils";

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "role"> {
  checked: boolean;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn("bx-switch", checked && "bx-switch-checked", className)}
      {...props}
    >
      <span className="bx-switch-thumb" />
    </button>
  )
);

Switch.displayName = "Switch";
