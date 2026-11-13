/** In-app replacements for confirm()/prompt(): promise-based, styled like the rest of the UI. */
import { useEffect, useRef, useState } from "react";
import { Kbd } from "./Kbd";
import { t } from "../lib/i18n";

interface Request {
  title: string;
  message?: string;
  /** Present for text input requests. */
  value?: string;
  label?: string;
  confirmLabel: string;
  cancelLabel: string | null;
  danger: boolean;
  resolve: (v: string | null) => void;
}

let open: ((r: Request) => void) | null = null;

function ask(r: Omit<Request, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    if (!open) return resolve(null);

    open({ ...r, resolve });
  });
}

export async function askConfirm(o: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  const r = await ask({
    title: o.title,
    ...(o.message ? { message: o.message } : {}),
    confirmLabel: o.confirmLabel ?? t("OK"),
    cancelLabel: o.cancelLabel ?? t("Cancel"),
    danger: o.danger ?? false,
  });

  return r !== null;
}

export function askText(o: {
  title: string;
  label?: string;
  value?: string;
  message?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return ask({
    title: o.title,
    ...(o.message ? { message: o.message } : {}),
    ...(o.label ? { label: o.label } : {}),
    value: o.value ?? "",
    confirmLabel: o.confirmLabel ?? t("OK"),
    cancelLabel: t("Cancel"),
    danger: false,
  });
}

/** A notice with a single button, e.g. a link to copy. */
export async function showNotice(o: { title: string; message?: string; value?: string }): Promise<void> {
  await ask({
    title: o.title,
    ...(o.message ? { message: o.message } : {}),
    ...(o.value !== undefined ? { value: o.value } : {}),
    confirmLabel: t("Done"),
    cancelLabel: null,
    danger: false,
  });
}

export function AskHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    open = (r) => {
      setReq(r);
      setText(r.value ?? "");
    };

    return () => {
      open = null;
    };
  }, []);
  useEffect(() => {
    if (!req) return;

    setTimeout(
      () => (input.current ? (input.current.focus(), input.current.select()) : okBtn.current?.focus()),
      0,
    );
  }, [req]);
  if (!req) return null;

  const done = (v: string | null) => {
    setReq(null);
    req.resolve(v);
  };

  const ok = () => done(req.value !== undefined ? text : "");
  const cancel = () => done(req.cancelLabel === null ? "" : null);

  return (
    <div className="modal-backdrop ask-backdrop" onPointerDown={cancel}>
      <div
        className="ask"
        role="alertdialog"
        aria-modal="true"
        aria-label={req.title}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") cancel();
          if (e.key === "Enter") ok();
        }}
      >
        <h3>{req.title}</h3>
        {req.message ? req.message.split("\n\n").map((para, i) => <p key={i}>{para}</p>) : null}
        {req.value !== undefined ? (
          <label className="ask-field">
            {req.label ? <span>{req.label}</span> : null}
            <input
              ref={input}
              value={text}
              readOnly={req.cancelLabel === null}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        ) : null}
        <div className="ask-actions">
          {req.cancelLabel !== null ? (
            <button className="btn" onClick={cancel}>
              {req.cancelLabel} <Kbd k="Esc" />
            </button>
          ) : null}
          <button ref={okBtn} className={`btn ${req.danger ? "danger" : "primary"}`} onClick={ok}>
            {req.confirmLabel} <Kbd k="↵" />
          </button>
        </div>
      </div>
    </div>
  );
}
