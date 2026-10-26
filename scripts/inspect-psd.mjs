// Prints the layer tree of a PSD (no pixel data) so we can see how a mockup is built.
import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';

const file = process.argv[2];
const t0 = Date.now();
const psd = readPsd(readFileSync(file), {
  skipLayerImageData: true,
  skipCompositeImageData: true,
  skipThumbnail: true,
});
console.log(`${psd.width}x${psd.height}  bits=${psd.bitsPerChannel} mode=${psd.colorMode}  parsed in ${Date.now() - t0}ms`);
console.log('linkedFiles:', (psd.linkedFiles ?? []).map((f) => `${f.name} ${f.data?.length ?? 0}B`));

function walk(ls, depth = 0) {
  for (const l of [...ls].reverse()) {
    const bits = [];
    if (l.children) bits.push('GROUP');
    if (l.placedLayer) bits.push(`SMART(${l.placedLayer.type}, ${l.placedLayer.width}x${l.placedLayer.height}${l.placedLayer.warp ? ', WARP' : ''}${l.placedLayer.nonAffineTransform ? ', nonAffine' : ''})`);
    if (l.text) bits.push('TEXT');
    if (l.vectorFill) bits.push(`vfill:${l.vectorFill.type}`);
    if (l.adjustment) bits.push(`ADJ:${l.adjustment.type}`);
    if (l.mask) bits.push('mask');
    if (l.effects) bits.push('fx:' + Object.keys(l.effects).join('+'));
    if (l.blendMode && l.blendMode !== 'normal') bits.push(l.blendMode);
    if (l.opacity !== undefined && l.opacity < 1) bits.push(`op${Math.round(l.opacity * 100)}`);
    if (l.hidden) bits.push('hidden');
    if (l.clipping) bits.push('clip');
    const size = l.children ? '' : ` [${(l.right ?? 0) - (l.left ?? 0)}x${(l.bottom ?? 0) - (l.top ?? 0)}]`;
    console.log(`${'  '.repeat(depth)}- ${l.name}${size} ${bits.join(' ')}`);
    if (l.children) walk(l.children, depth + 1);
  }
}
walk(psd.children ?? []);
