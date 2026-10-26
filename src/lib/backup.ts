import { hasLiveToken } from './auth';
import { driveLink, uploadBlob } from './drive';
import { setBackup } from './store';
import type { BackupInfo } from './types';

/**
 * Uploads the original PSD to the user's "Reskin Mockups" Drive folder and records it on the mockup.
 * Returns null if the mockup was removed while the upload ran (the Drive copy is left alone).
 */
export async function backupOriginal(file: File, mockupId: string, onProgress?: (sent: number) => void): Promise<BackupInfo | null> {
  // Refreshing a token opens Google's popup, which the browser blocks outside a click; fail with a clear message instead.
  if (!hasLiveToken()) throw new Error('Reconnect Google (top right) to back up this file.');
  const uploaded = await uploadBlob(file, file.name, onProgress);
  const info: BackupInfo = { fileId: uploaded.id, link: driveLink(uploaded), at: Date.now() };
  return (await setBackup(mockupId, info)) ? info : null;
}
