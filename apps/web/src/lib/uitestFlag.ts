/**
 * Whether a UI test started the app (apps/ios/uitests): the iOS app then sets
 * `window.__meercadUITest` before the page loads. On its own here, so that asking does not bring
 * the probe and the store with it (see uitestProbe.ts).
 */
export const uiTesting = (): boolean => !!(window as unknown as { __meercadUITest?: boolean }).__meercadUITest;
