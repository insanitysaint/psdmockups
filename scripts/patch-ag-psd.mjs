// ag-psd (28.5.x) has two bugs that break real-world 16-bit PSDs. Patches both the CommonJS build
// (Node scripts) and the ES build (Vite/browser). Idempotent; run from "postinstall".
//
// 1. Layer masks: the channel offset is not advanced after a mask whose rectangle is empty, which desyncs every
//    following channel and makes ag-psd silently drop all layers.
// 2. 16-bit ZIP pixel data: values are big-endian in the file but were not byte-swapped before the
//    delta ("prediction") decode, so every row of the layer came out smeared.
import { readFileSync, writeFileSync } from 'node:fs';

const builds = [
  { path: '../node_modules/ag-psd/dist/psdReader.js', maskCall: 'mask.canvas = (0, helpers_1.imageDataToCanvas)(maskData);' },
  { path: '../node_modules/ag-psd/dist-es/psdReader.js', maskCall: 'mask.canvas = imageDataToCanvas(maskData);' },
];

for (const b of builds) {
  const file = new URL(b.path, import.meta.url);
  let src = readFileSync(file, 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;

  // Older revisions of this script used a single marker for the mask fix.
  if (src.includes('// RESKIN-PATCH' + nl)) {
    src = src.replace('// RESKIN-PATCH' + nl, '// RESKIN-PATCH-MASK' + nl);
    changed = true;
  }
  if (!src.includes('RESKIN-PATCH-MASK')) {
    const needle = [b.maskCall, '                }', '            }', '        }', '        else {'].join(nl);
    if (!src.includes(needle)) throw new Error(`mask patch target not found in ${b.path} (ag-psd version changed?)`);
    const patched = [b.maskCall, '                }', '            }', '            reader.offset = start + channel.length; // RESKIN-PATCH-MASK', '        }', '        else {'].join(nl);
    src = src.replace(needle, patched);
    changed = true;
  }

  if (!src.includes('RESKIN-PATCH-ENDIAN')) {
    const re = /if \(prediction\)(\s*)decodePredicted\(array, width, height, 0x10000\);/;
    if (!re.test(src)) throw new Error(`endian patch target not found in ${b.path} (ag-psd version changed?)`);
    src = src.replace(
      re,
      (_m, ws) =>
        `for (var si = 0; si < array.length; si++) { var sv = array[si]; array[si] = ((sv & 255) << 8) | (sv >> 8); } // RESKIN-PATCH-ENDIAN${ws}` +
        `if (prediction)${ws}decodePredicted(array, width, height, 0x10000);`,
    );
    changed = true;
  }

  if (changed) writeFileSync(file, src);
  console.log(`${changed ? 'patched' : 'already patched'}: ${b.path}`);
}
