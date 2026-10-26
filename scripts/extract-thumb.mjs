// Saves the JPEG thumbnail embedded in a PSD (decoded independently of the pixel-data path).
import { readFileSync, writeFileSync } from 'node:fs';
import { readPsd, initializeCanvas } from 'ag-psd';
let jpeg;
initializeCanvas((w, h) => ({ width: w, height: h, getContext: () => ({}) }), (data) => { jpeg = data; return { width: 1, height: 1, getContext: () => ({}) }; });
readPsd(readFileSync(process.argv[2]), { skipLayerImageData: true, skipCompositeImageData: true });
if (!jpeg) throw new Error('no thumbnail');
writeFileSync(process.argv[3], jpeg);
console.log('thumbnail', jpeg.length, 'bytes');
