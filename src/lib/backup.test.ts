import { beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({ value: true }));
const setBackup = vi.hoisted(() => vi.fn());
const uploadBlob = vi.hoisted(() => vi.fn());

vi.mock('./auth', () => ({ hasLiveToken: () => live.value }));
vi.mock('./store', () => ({ setBackup }));
vi.mock('./drive', () => ({ uploadBlob, driveLink: (f: { id: string }) => `https://drive.test/${f.id}` }));

import { backupOriginal } from './backup';

const psd = new File([new Uint8Array(10)], 'tee.psd');

describe('backupOriginal', () => {
  beforeEach(() => {
    live.value = true;
    setBackup.mockReset().mockResolvedValue(true);
    uploadBlob.mockReset().mockResolvedValue({ id: 'f1', name: 'tee.psd' });
  });

  it('uploads the original under its own name and records the Drive link', async () => {
    const progress = vi.fn();
    const info = await backupOriginal(psd, 'm1', progress);
    expect(uploadBlob).toHaveBeenCalledWith(psd, 'tee.psd', progress);
    expect(info).toMatchObject({ fileId: 'f1', link: 'https://drive.test/f1' });
    expect(setBackup).toHaveBeenCalledWith('m1', info);
  });

  it('does not start without a live token, so no popup is attempted outside a click', async () => {
    live.value = false;
    await expect(backupOriginal(psd, 'm1')).rejects.toThrow(/Reconnect Google/);
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('returns null when the mockup was removed during the upload', async () => {
    setBackup.mockResolvedValue(false);
    expect(await backupOriginal(psd, 'gone')).toBeNull();
  });

  it('passes upload failures through unchanged', async () => {
    uploadBlob.mockRejectedValue(new Error('Drive returned 503'));
    await expect(backupOriginal(psd, 'm1')).rejects.toThrow('Drive returned 503');
    expect(setBackup).not.toHaveBeenCalled();
  });
});
