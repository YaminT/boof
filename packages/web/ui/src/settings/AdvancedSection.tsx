import { useId, useState, type ReactNode } from "react";
import { Button } from "@/ui/button";

/**
 * A settings section that simple mode tucks behind a disclosure. `open` forces it open (expanded
 * mode, or unsaved edits on the page). Its fields stay mounted while hidden, so nothing is lost.
 */
export function AdvancedSection({
  title,
  open,
  className,
  children,
}: {
  title: string;
  open: boolean;
  className: string;
  children: ReactNode;
}) {
  const [disclosed, setDisclosed] = useState(false);
  const id = useId();
  const shown = open || disclosed;
  return (
    <section className={className}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[length:var(--text-section)] font-semibold">{title}</h2>
        {!open && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={shown}
            aria-controls={id}
            onClick={() => setDisclosed(!disclosed)}
          >
            {shown ? "Hide" : "Show"}
            <span className="sr-only"> {title}</span>
          </Button>
        )}
      </div>
      <div id={id} hidden={!shown} className="contents">
        {children}
      </div>
    </section>
  );
}
