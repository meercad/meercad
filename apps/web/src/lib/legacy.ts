/**
 * Carries settings over from before the app was renamed (leocad → meerCAD). Imported first, before
 * any module reads its settings from localStorage.
 */
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith("leocad.")) continue;
    const next = `meercad.${key.slice(7)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
  }
} catch {
  // storage unavailable: nothing to carry over
}
