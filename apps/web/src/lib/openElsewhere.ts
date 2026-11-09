import { useEffect, useState } from "react";
import { desktop } from "./persistence";

/**
 * The projects other windows of this app have open (id → the assistant's name, "" for another
 * window of the user's), kept current: a project is open in one window only (desktop app).
 */
export function useOpenElsewhere(): Record<string, string> {
  const [open, setOpen] = useState<Record<string, string>>({});
  useEffect(() => {
    const a = desktop?.assistant;
    if (!desktop || !a?.openElsewhere) return;
    let live = true;
    void a.openElsewhere().then((o) => live && setOpen(o));
    const off = desktop.on("open-elsewhere", setOpen);
    return () => {
      live = false;
      off();
    };
  }, []);
  return open;
}
