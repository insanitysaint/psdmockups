/**
 * Returns a plain-language reason this browser can't run the app, or null when everything needed is there.
 * The preview and every export are rendered with WebGL 2 on an OffscreenCanvas, and files are kept in IndexedDB.
 */
export function unsupportedReason(): string | null {
  try {
    if (typeof Worker === 'undefined' || typeof indexedDB === 'undefined' || typeof createImageBitmap === 'undefined') {
      return "This browser is missing features the app needs (web workers, storage or image decoding). Please use a current Chrome, Edge, Firefox or Safari.";
    }
    if (typeof OffscreenCanvas === 'undefined') {
      return 'This browser is too old to render previews (it has no OffscreenCanvas). Please update it, or use a current Chrome, Edge, Firefox or Safari.';
    }
    if (!new OffscreenCanvas(1, 1).getContext('webgl2')) {
      return "WebGL 2 is switched off or unavailable, so previews and exports can't be rendered. Turn on hardware acceleration in your browser settings, or try another browser.";
    }
    return null;
  } catch {
    return "This browser couldn't start the renderer. Please try a current Chrome, Edge, Firefox or Safari.";
  }
}
