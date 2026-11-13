/** Constraint glyph icons in the lucide style (24px grid, stroke). */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const S = (props: P & { children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  />
);

export const Coincident = (p: P) => (
  <S {...p}>
    <path d="M4 20 11 13M20 4l-7 7" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" />
  </S>
);
export const Horizontal = (p: P) => (
  <S {...p}>
    <path d="M3 12h18" />
    <path d="M7 8h0M17 8h0" />
    <circle cx="6" cy="12" r="1.5" fill="currentColor" />
    <circle cx="18" cy="12" r="1.5" fill="currentColor" />
  </S>
);
export const Vertical = (p: P) => (
  <S {...p}>
    <path d="M12 3v18" />
    <circle cx="12" cy="6" r="1.5" fill="currentColor" />
    <circle cx="12" cy="18" r="1.5" fill="currentColor" />
  </S>
);
export const Parallel = (p: P) => (
  <S {...p}>
    <path d="M5 19 13 5M11 19l8-14" />
  </S>
);
export const Perpendicular = (p: P) => (
  <S {...p}>
    <path d="M5 19h14M12 19V5" />
    <path d="M12 15h4v4" />
  </S>
);
export const Tangent = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="14" r="5" />
    <path d="M3 9h18" />
  </S>
);
export const EqualIcon = (p: P) => (
  <S {...p}>
    <path d="M6 9h12M6 15h12" />
  </S>
);
export const Midpoint = (p: P) => (
  <S {...p}>
    <path d="M3 12h18" />
    <path d="M12 8v8" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
  </S>
);
export const Fix = (p: P) => (
  <S {...p}>
    <rect x="6" y="11" width="12" height="9" rx="2" />
    <path d="M9 11V8a3 3 0 0 1 6 0v3" />
  </S>
);
export const Symmetric = (p: P) => (
  <S {...p}>
    <path d="M12 3v18" strokeDasharray="2 2.5" />
    <circle cx="6" cy="12" r="2" fill="currentColor" />
    <circle cx="18" cy="12" r="2" fill="currentColor" />
  </S>
);
export const Concentric = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="0.8" fill="currentColor" />
  </S>
);
export const PointOn = (p: P) => (
  <S {...p}>
    <path d="M4 18c4-10 12-10 16 0" />
    <circle cx="12" cy="10.5" r="2" fill="currentColor" />
  </S>
);
export const Collinear = (p: P) => (
  <S {...p}>
    <path d="M3 17 9 13M15 9l6-4" />
    <path d="M10 12.5l4-3" strokeDasharray="1.5 2" />
  </S>
);

export const GLYPH: Record<string, string> = {
  horizontal: "H",
  vertical: "V",
  horizontal_points: "H",
  vertical_points: "V",
  parallel: "∥",
  perpendicular: "⊥",
  tangent: "T",
  equal: "=",
  midpoint: "M",
  fix: "⚓",
  symmetric: "⇹",
  collinear: "≡",
  point_on: "∈",
  coincident: "●",
};
