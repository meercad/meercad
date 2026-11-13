/** The design's fit (Spiel) at the top of the variables: its value, the test part, this printer's value. */
import { MoreHorizontal, Printer, RotateCcw, Save, Download } from "lucide-react";
import { DEFAULT_FIT, evaluate, FIT_VAR } from "@meercad/model";
import type { Expr } from "@meercad/schema";
import { t } from "../lib/i18n";
import { usePrefs, setPrefs } from "../lib/keymap";
import { openFitTest } from "../lib/fit";
import { docUnit, inUnit } from "../lib/units";
import { apply, toast, useApp } from "../store";
import { ExprInput } from "./ExprInput";
import { showMenu } from "./Menu";

const mmText = (v: number) => `${+v.toFixed(3)} mm`;

export function FitRow() {
  const fit = useApp((s) => s.doc.fit);
  const value = useApp((s) => s.output?.report.params[FIT_VAR]);
  const error = useApp((s) => s.output?.report.paramErrors[FIT_VAR]);
  // An own variable called "fit" from before the fit existed takes its place.
  const shadowed = useApp((s) => FIT_VAR in s.doc.params);
  const printer = usePrefs((s) => s.printerFit);
  if (shadowed) return null;

  const commit = (v: Expr) => {
    let mm: number;

    try {
      mm = evaluate(v, new Map(Object.entries(useApp.getState().output?.report.params ?? {})));
    } catch {
      mm = NaN;
    }

    if (!(mm >= 0 && mm <= 1)) return toast(t("A fit is between 0 and 1 mm"), "error");
    if (!apply({ type: "set_fit", fit: v })) return;

    // The first fit someone enters is their printer's: new designs start with it.
    if (printer === null) {
      setPrefs({ printerFit: +mm.toFixed(3) });
      toast(t("{value} is now your printer's fit for new designs (Settings)", { value: mmText(mm) }));
    }
  };

  const menu = (x: number, y: number) =>
    showMenu(x, y, [
      { label: t("Print the fit test part…"), icon: <Printer />, onClick: () => void openFitTest() },
      ...(printer !== null && value !== undefined && Math.abs(printer - value) > 1e-6
        ? [
            {
              label: t("Use my printer's fit ({value})", { value: mmText(printer) }),
              icon: <Download />,
              onClick: () => apply({ type: "set_fit", fit: `${printer} mm` }),
            },
          ]
        : []),
      ...(value !== undefined && (printer === null || Math.abs(printer - value) > 1e-6)
        ? [
            {
              label: t("Save as my printer's fit"),
              icon: <Save />,
              onClick: () => (
                setPrefs({ printerFit: +value.toFixed(3) }),
                toast(
                  t("{value} is now your printer's fit for new designs (Settings)", { value: mmText(value) }),
                )
              ),
            },
          ]
        : []),
      ...(fit !== undefined
        ? [
            {
              label: t("Back to the default ({value})", { value: mmText(DEFAULT_FIT) }),
              icon: <RotateCcw />,
              onClick: () => apply({ type: "set_fit", fit: null }),
            },
          ]
        : []),
    ]);
  const inch = docUnit() === "in";

  return (
    <div
      className="param-row fit-row"
      title={t(
        "Gap per side between parts that fit into each other, measured with the fit test part. Holes, bores, threads and moving parts use it as “fit”.",
      )}
      onContextMenu={(e) => (e.preventDefault(), menu(e.clientX, e.clientY))}
    >
      <span className="field name-input fit-name">{t("fit::Fit")}</span>
      <ExprInput value={fit} placeholder={String(DEFAULT_FIT)} quiet onCommit={commit} />
      <span className="val" style={error ? { color: "var(--err)" } : undefined} title={error ?? ""}>
        {error ? t("error") : value === undefined ? "" : inch ? inUnit(value, "in") : +value.toFixed(3)}
      </span>
      <button className="icon-btn sm" title={t("Fit options")} onClick={(e) => menu(e.clientX, e.clientY)}>
        <MoreHorizontal />
      </button>
    </div>
  );
}
