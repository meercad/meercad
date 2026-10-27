import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}
export type MenuEntry = MenuItem | "sep";

let openMenu: ((m: { x: number; y: number; items: MenuEntry[] } | null) => void) | null = null;

/** Opens a context menu at screen coordinates. */
export function showMenu(x: number, y: number, items: MenuEntry[]): void {
  openMenu?.({ x, y, items });
}

export function closeMenu(): void {
  openMenu?.(null);
}

export function MenuHost() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useEffect(() => {
    openMenu = setMenu;
    return () => {
      openMenu = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, innerWidth - r.width - 8), top: Math.min(menu.y, innerHeight - r.height - 8) });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(
    <div className="menu" ref={ref} style={pos} role="menu">
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            style={it.danger ? { color: "var(--err)" } : undefined}
            onClick={() => {
              setMenu(null);
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
            {it.kbd ? <Kbd k={it.kbd} /> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
