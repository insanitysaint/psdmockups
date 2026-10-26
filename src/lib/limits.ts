export const MAX_FILES = 10;
/** Budget applies to what we keep (slimmed assets), not to the raw files dropped in. */
export const MAX_STORED_BYTES = 1024 * 1024 * 1024;
/** Largest single source file we try to open in the browser (ArrayBuffer ceiling). */
export const MAX_RAW_BYTES = 2 * 1024 * 1024 * 1024;
export const GUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const PREVIEW_MAX_EDGE = 1280;
export const ACCEPTED_EXT = ['.psd', '.psb'];
