/**
 * Browsers only give a page WebCrypto (which encryption is built on) and the microphone and
 * camera when it's a "secure context": opened over https://, or on localhost. A self-hosted
 * server opened as http://192.168.x.x:8080 isn't one, so those parts can't work there.
 */
export const isSecure = (): boolean => window.isSecureContext && !!globalThis.crypto?.subtle;

/** Where the HTTPS setup steps are. */
export const HTTPS_GUIDE = "https://github.com/Spacegoose02/dendrop/blob/main/docs/HTTPS.md";

export const INSECURE_ENCRYPTION =
  "Encryption needs a secure https:// address, and this page was opened over plain http://. Ask whoever runs the Dendrop server to set up HTTPS.";

export const INSECURE_MEDIA = "Calls need a secure https:// address, and this page was opened over plain http://, so the browser blocks the microphone and camera.";
