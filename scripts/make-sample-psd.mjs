// Generates small test PSDs so the drag-and-drop flow can be tried without real mockups.
import { writePsd } from 'ag-psd';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = new URL('../sample-psd/', import.meta.url);
mkdirSync(out, { recursive: true });

function layerPixels(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  return { width: w, height: h, data };
}

function make(name, W, H, tee) {
  const bg = layerPixels(W, H, (x, y) => [235 - (y / H) * 30, 235 - (y / H) * 30, 240, 255]);
  const shirtW = Math.round(W * 0.6), shirtH = Math.round(H * 0.7);
  const left = Math.round((W - shirtW) / 2), top = Math.round(H * 0.15);
  const shirt = layerPixels(shirtW, shirtH, (x, y) => {
    const nx = (x / shirtW - 0.5) * 2;
    const inside = Math.abs(nx) < 1 - (y < shirtH * 0.15 ? (1 - y / (shirtH * 0.15)) * 0.35 : 0);
    const shade = 1 - Math.abs(nx) * 0.25;
    return inside ? [tee[0] * shade, tee[1] * shade, tee[2] * shade, 255] : [0, 0, 0, 0];
  });
  const shadow = layerPixels(shirtW, shirtH, (x, y) => [0, 0, 0, Math.max(0, 40 - (y / shirtH) * 40)]);
  const psd = {
    width: W,
    height: H,
    children: [
      { name: 'Background', left: 0, top: 0, right: W, bottom: H, imageData: bg },
      { name: 'Tee color', left, top, right: left + shirtW, bottom: top + shirtH, imageData: shirt },
      {
        name: 'Shading',
        left, top, right: left + shirtW, bottom: top + shirtH,
        blendMode: 'multiply', opacity: 0.8, imageData: shadow,
      },
    ],
  };
  const buf = Buffer.from(writePsd(psd, { generateThumbnail: false }));
  writeFileSync(new URL(name, out), buf);
  console.log(name, (buf.length / 1048576).toFixed(1), 'MB');
}

make('tee-black.psd', 2400, 2400, [30, 30, 34]);
make('tee-sand.psd', 3000, 3000, [216, 196, 160]);
make('tee-forest.psd', 1800, 2400, [40, 90, 62]);
