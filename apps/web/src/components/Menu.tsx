import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  /** Short text on the right, e.g. the current choice of a submenu ("mm"). */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  /** Opens these entries in place of the menu, with a back row on top (works the same with touch and mouse). */
  submenu?: MenuEntry[];
}
export type MenuEntry = MenuItem | "sep";

type OpenMenu = { x: number; y: number; items: MenuEntry[]; above?: boolean };
let openMenu: ((m: OpenMenu | null) => void) | null = null;

/** Opens a context menu at screen coordinates; `above` puts its bottom edge at `y` (bars at the bottom). */
export function showMenu(x: number, y: number, items: MenuEntry[], opts: { above?: boolean } = {}): void {
  openMenu?.({ x, y, items, ...opts });
}

export function closeMenu(): void {
  openMenu?.(null);
}

/** Leaves out separators at the ends and doubled ones, so optional entries can drop out freely. */
function tidy(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const it of items) if (it !== "sep" || (out.length && out[out.length - 1] !== "sep")) out.push(it);
  while (out[out.length - 1] === "sep") out.pop();
  return out;
}

export function MenuHost() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [stack, setStack] = useState<MenuItem[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  /** The top level's width: submenus keep it, so the menu doesn't shrink and jump sideways. */
  const rootWidth = useRef(0);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useEffect(() => {
    openMenu = (m) => {
      setStack([]);
      setMenu(m);
    };
    return () => {
      openMenu = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (!stack.length) rootWidth.current = r.width;
    const top = menu.above ? menu.y - r.height : menu.y;
    // A submenu keeps the top edge of its parent (bottom edge for menus that open upwards), so it doesn't jump.
    setPos({ left: Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(top, innerHeight - r.height - 8)) });
  }, [menu, stack]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if ((e.key === "Escape" || e.key === "ArrowLeft") && stack.length) {
          e.preventDefault();
          e.stopPropagation();
          setStack((s) => s.slice(0, -1));
          return;
        }
        if (e.key !== "Escape") return;
      }
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
  }, [menu, stack.length]);
  if (!menu) return null;
  const parent = stack[stack.length - 1];
  const items = tidy(parent ? parent.submenu! : menu.items);
  return createPortal(
    <div className="menu" ref={ref} style={{ ...pos, minWidth: parent ? rootWidth.current : undefined }} role="menu">
      {parent ? (
        <>
          <button className="menu-back" role="menuitem" onClick={() => setStack((s) => s.slice(0, -1))}>
            <ChevronLeft />
            {parent.label}
          </button>
          <hr />
        </>
      ) : null}
      {items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={`${stack.length}-${i}`}
            role="menuitem"
            aria-haspopup={it.submenu ? "menu" : undefined}
            disabled={it.disabled || (it.submenu && !tidy(it.submenu).length)}
            style={it.danger ? { color: "var(--err)" } : undefined}
            onClick={() => {
              if (it.submenu) return setStack((s) => [...s, it]);
              setMenu(null);
              it.onClick?.();
            }}
          >
            {it.icon}
            {it.label}
            {it.hint ? <span className="menu-hint">{it.hint}</span> : null}
            {it.kbd ? <Kbd k={it.kbd} /> : null}
            {it.submenu ? <ChevronRight className="menu-more" /> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
