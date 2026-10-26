import { getBlob, layerKey } from './store';
import { resolveDesignBlend, type Edits } from './layers';
import type { CurvePoint, CurvesMeta, LayerMeta, MockupRecord } from './types';

export type FitMode = 'contain' | 'cover';

export interface Design {
  bitmap: ImageBitmap;
  fit: FitMode;
}

export interface RenderOptions {
  /** Longest edge of the output in pixels. */
  maxEdge: number;
  /** Replaces the mockup's design smart object. Null/absent renders the PSD as authored. */
  design?: Design | null;
  /** Keep decoded layer textures between renders (previews). Export renders pass false. */
  cache?: boolean;
  format?: 'image/webp' | 'image/png' | 'image/jpeg';
  /** Color, visibility and opacity changes made in the editor. */
  edits?: Edits;
}

// Photoshop blend modes -> shader ids. Anything missing falls back to normal.
const MODES: Record<string, number> = {
  normal: 0, 'pass through': 0, dissolve: 0,
  multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5,
  'color dodge': 6, 'color burn': 7, 'linear burn': 8, 'linear dodge': 9,
  'hard light': 10, 'soft light': 11, 'vivid light': 12, 'linear light': 13, 'pin light': 14,
  'hard mix': 15, difference: 16, exclusion: 17, subtract: 18, divide: 19,
  hue: 20, saturation: 21, color: 22, luminosity: 23, 'darker color': 24, 'lighter color': 25,
};

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBack;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform sampler2D uLut;
uniform float uScale;
uniform vec2 uRes;
uniform int uKind;      // 0 pixels, 1 solid fill, 2 curves
uniform int uMode;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec4 uRect;     // left, top, width, height in document px
uniform bool uQuad;
uniform mat3 uInv;      // document px -> unit square (smart object content)
uniform int uMaskMode;  // 0 none, 1 constant, 2 texture
uniform vec4 uMaskRect;
uniform float uMaskDef;
out vec4 outColor;

float dodge(float cb, float cs) { if (cb <= 0.0) return 0.0; if (cs >= 1.0) return 1.0; return min(1.0, cb / (1.0 - cs)); }
float burn(float cb, float cs) { if (cb >= 1.0) return 1.0; if (cs <= 0.0) return 0.0; return 1.0 - min(1.0, (1.0 - cb) / cs); }
float hardL(float cb, float cs) { return cs <= 0.5 ? cb * 2.0 * cs : cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0); }
float softL(float cb, float cs) {
  if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
  float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
  return cb + (2.0 * cs - 1.0) * (d - cb);
}

float sep(float cb, float cs, int m) {
  if (m == 1) return cb * cs;
  if (m == 2) return cb + cs - cb * cs;
  if (m == 3) return hardL(cs, cb);
  if (m == 4) return min(cb, cs);
  if (m == 5) return max(cb, cs);
  if (m == 6) return dodge(cb, cs);
  if (m == 7) return burn(cb, cs);
  if (m == 8) return max(0.0, cb + cs - 1.0);
  if (m == 9) return min(1.0, cb + cs);
  if (m == 10) return hardL(cb, cs);
  if (m == 11) return softL(cb, cs);
  if (m == 12) return cs <= 0.5 ? burn(cb, 2.0 * cs) : dodge(cb, 2.0 * (cs - 0.5));
  if (m == 13) return clamp(cb + 2.0 * cs - 1.0, 0.0, 1.0);
  if (m == 14) return cs < 0.5 ? min(cb, 2.0 * cs) : max(cb, 2.0 * cs - 1.0);
  if (m == 15) return cb + cs >= 1.0 ? 1.0 : 0.0;
  if (m == 16) return abs(cb - cs);
  if (m == 17) return cb + cs - 2.0 * cb * cs;
  if (m == 18) return max(0.0, cb - cs);
  if (m == 19) return cs <= 0.0 ? 1.0 : min(1.0, cb / cs);
  return cs;
}

float lumf(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipC(vec3 c) {
  float l = lumf(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipC(c + (l - lumf(c))); }
float satf(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}

vec3 blendFn(vec3 cb, vec3 cs, int m) {
  if (m == 0) return cs;
  if (m == 20) return setLum(setSat(cs, satf(cb)), lumf(cb));
  if (m == 21) return setLum(setSat(cb, satf(cs)), lumf(cb));
  if (m == 22) return setLum(cs, lumf(cb));
  if (m == 23) return setLum(cb, lumf(cs));
  if (m == 24) return lumf(cs) < lumf(cb) ? cs : cb;
  if (m == 25) return lumf(cs) > lumf(cb) ? cs : cb;
  return vec3(sep(cb.r, cs.r, m), sep(cb.g, cs.g, m), sep(cb.b, cs.b, m));
}

float lutAt(float v, int ch) {
  vec4 t = texture(uLut, vec2((floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5) + 0.5) / 256.0, 0.5));
  return ch == 0 ? t.r : (ch == 1 ? t.g : t.b);
}

void main() {
  vec4 back = texelFetch(uBack, ivec2(gl_FragCoord.xy), 0);
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;

  vec3 cs = uColor;
  float sa = 1.0;
  // Texture reads stay outside divergent branches so sampling is well defined.
  vec2 uv = uQuad ? (uInv * vec3(p, 1.0)).xy / (uInv * vec3(p, 1.0)).z : (p - uRect.xy) / uRect.zw;
  vec4 t = texture(uTex, clamp(uv, 0.0, 1.0));
  vec2 mu = (p - uMaskRect.xy) / uMaskRect.zw;
  float mt = texture(uMask, clamp(mu, 0.0, 1.0)).r;

  if (uKind == 0) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { outColor = back; return; }
    cs = t.rgb;
    sa = t.a;
  } else if (uKind == 2) {
    cs = vec3(lutAt(back.r, 0), lutAt(back.g, 1), lutAt(back.b, 2));
  }

  float m = 1.0;
  if (uMaskMode == 1) m = uMaskDef;
  else if (uMaskMode == 2) m = (mu.x < 0.0 || mu.x > 1.0 || mu.y < 0.0 || mu.y > 1.0) ? uMaskDef : mt;

  float a = sa * uOpacity * m;
  if (a <= 0.0) { outColor = back; return; }

  float ab = back.a;
  vec3 b = blendFn(back.rgb, cs, uKind == 2 ? 0 : uMode);
  float ar = a + ab * (1.0 - a);
  vec3 cr = ((1.0 - a) * ab * back.rgb + (1.0 - ab) * a * cs + a * ab * b) / ar;
  outColor = vec4(cr, ar);
}`;

const BLIT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

/** Natural cubic spline through the curve points (what Photoshop's curve editor draws), 0-255 -> 0-255. */
function splineFn(pts: CurvePoint[]): (x: number) => number {
  const n = pts.length;
  const x = pts.map((p) => p.input);
  const y = pts.map((p) => p.output);
  const h = x.slice(1).map((v, i) => v - x[i] || 1e-6);
  // Solve the tridiagonal system for second derivatives (natural ends: 0).
  const M = new Array(n).fill(0);
  const c = new Array(n).fill(0);
  const d = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = h[i - 1], b = 2 * (h[i - 1] + h[i]), cc = h[i];
    const r = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
    const w = b - a * c[i - 1];
    c[i] = cc / w;
    d[i] = (r - a * d[i - 1]) / w;
  }
  for (let i = n - 2; i >= 1; i--) M[i] = d[i] - c[i] * M[i + 1];
  return (v) => {
    if (v <= x[0]) return y[0];
    if (v >= x[n - 1]) return y[n - 1];
    let i = 0;
    while (v > x[i + 1]) i++;
    const a = (x[i + 1] - v) / h[i], b = (v - x[i]) / h[i];
    return a * y[i] + b * y[i + 1] + (((a * a * a - a) * M[i] + (b * b * b - b) * M[i + 1]) * h[i] * h[i]) / 6;
  };
}

function curveFn(points?: CurvePoint[]): (x: number) => number {
  if (!points || points.length < 2) return (x) => x;
  return splineFn([...points].sort((a, b) => a.input - b.input));
}

function buildLut(c: CurvesMeta): Uint8Array {
  const rgb = curveFn(c.rgb), r = curveFn(c.red), g = curveFn(c.green), b = curveFn(c.blue);
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    out[i * 4] = clamp(rgb(clamp(r(i))));
    out[i * 4 + 1] = clamp(rgb(clamp(g(i))));
    out[i * 4 + 2] = clamp(rgb(clamp(b(i))));
    out[i * 4 + 3] = 255;
  }
  return out;
}

type Mat3 = number[]; // row-major

function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

/** Matrix taking document px to the unit square of a smart object whose corners are TL, TR, BR, BL. */
function quadToUnit(q: number[]): Mat3 {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const den = dx1 * dy2 - dy1 * dx2;
    g = (dx3 * dy2 - dy3 * dx2) / den;
    h = (dx1 * dy3 - dy1 * dx3) / den;
  }
  const unitToDoc: Mat3 = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
  return invert3(unitToDoc);
}

const toColumnMajor = (m: Mat3) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

interface Op {
  layer: LayerMeta;
  kind: 0 | 1 | 2;
  isDesign: boolean;
  /** Layer opacity after edits. */
  opacity: number;
  /** Fill color after edits, for solid-fill layers. */
  color?: string;
  /** Blend mode that replaces the layer's own (used for the design). */
  blend?: string;
}

function collectOps(layers: LayerMeta[], rec: MockupRecord, hasDesign: boolean, edits?: Edits, prefix = '', out: Op[] = [], blend = resolveDesignBlend(edits)): Op[] {
  // Layer lists are top-to-bottom; paint bottom-to-top. Paths match flattenLayers() so edits line up with the UI.
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const path = prefix ? `${prefix}.${i}` : String(i);
    if (!(edits?.visible[path] ?? l.visible)) continue;
    if (l.children) {
      collectOps(l.children, rec, hasDesign, edits, path, out, blend);
      continue;
    }
    const opacity = edits?.opacity[path] ?? l.opacity;
    if (opacity * l.fillOpacity <= 0) continue;
    const color = edits?.colors[path] ?? l.fillColor;
    if (l.kind === 'fill' && color) out.push({ layer: l, kind: 1, isDesign: false, opacity, color });
    else if (l.curves) out.push({ layer: l, kind: 2, isDesign: false, opacity });
    else if (l.kind === 'adjustment') continue;
    else if (hasDesign && l.kind === 'smartObject' && l.placedId && l.placedId === rec.designTargetId && l.placedQuad && l.placedSize) {
      out.push({ layer: l, kind: 0, isDesign: true, opacity, blend });
    } else if (l.blob !== undefined) out.push({ layer: l, kind: 0, isDesign: false, opacity });
  }
  return out;
}

interface Tex {
  tex: WebGLTexture;
  bytes: number;
}

const CACHE_BYTES = 400 * 1024 * 1024;

export class MockupRenderer {
  private canvas = new OffscreenCanvas(1, 1);
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private blit: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private fb: WebGLFramebuffer[] = [];
  private fbTex: WebGLTexture[] = [];
  private fbSize = '';
  private lutTex: WebGLTexture;
  private dummy: WebGLTexture;
  private cache = new Map<string, Tex>();
  private cacheBytes = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false, alpha: true });
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    this.gl = gl as WebGL2RenderingContext;
    this.prog = this.program(VERT, FRAG);
    this.blit = this.program(VERT, BLIT);
    for (const n of ['uBack', 'uTex', 'uMask', 'uLut', 'uScale', 'uRes', 'uKind', 'uMode', 'uOpacity', 'uColor', 'uRect', 'uQuad', 'uInv', 'uMaskMode', 'uMaskRect', 'uMaskDef']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256 * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.dummy = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program error: ' + gl.getProgramInfoLog(p));
    return p;
  }

  private targets(w: number, h: number) {
    const gl = this.gl;
    const key = `${w}x${h}`;
    if (this.fbSize === key) return;
    for (const t of this.fbTex) gl.deleteTexture(t);
    for (const f of this.fb) gl.deleteFramebuffer(f);
    this.fb = [];
    this.fbTex = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.fbTex.push(t);
      this.fb.push(f);
    }
    this.fbSize = key;
  }

  private upload(src: TexImageSource, w: number, h: number): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, bytes: w * h * 4 };
  }

  /** Decodes a stored blob at render resolution (the source is never needed at full size for previews). */
  private async blobTexture(rec: MockupRecord, index: number, w: number, h: number, scale: number, cache: boolean, temps: Tex[]): Promise<Tex | undefined> {
    const key = `${rec.id}|${Math.round(scale * 10000)}|${index}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit;
    }
    const blob = await getBlob(layerKey(rec.id, index));
    if (!blob) return undefined;
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const bmp = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
      ...(scale < 1 ? { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' as const } : {}),
    });
    const t = this.upload(bmp, bmp.width, bmp.height);
    bmp.close();
    if (cache) {
      this.cache.set(key, t);
      this.cacheBytes += t.bytes;
      while (this.cacheBytes > CACHE_BYTES && this.cache.size > 1) {
        const [oldKey, old] = this.cache.entries().next().value as [string, Tex];
        this.cache.delete(oldKey);
        this.cacheBytes -= old.bytes;
        this.gl.deleteTexture(old.tex);
      }
    } else temps.push(t);
    return t;
  }

  /** Draws the user's design into the smart object's own canvas, fitted like Photoshop's Place would. */
  private designTexture(design: Design, w: number, h: number, scale: number, temps: Tex[]): Tex {
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const c = new OffscreenCanvas(cw, ch);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    const bw = design.bitmap.width, bh = design.bitmap.height;
    const k = design.fit === 'cover' ? Math.max(cw / bw, ch / bh) : Math.min(cw / bw, ch / bh);
    ctx.drawImage(design.bitmap, (cw - bw * k) / 2, (ch - bh * k) / 2, bw * k, bh * k);
    const t = this.upload(c, cw, ch);
    temps.push(t);
    return t;
  }

  render(rec: MockupRecord, opts: RenderOptions): Promise<Blob> {
    const run = () => this.renderNow(rec, opts);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async renderNow(rec: MockupRecord, opts: RenderOptions): Promise<Blob> {
    const gl = this.gl;
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const scale = Math.min(1, opts.maxEdge / Math.max(rec.width, rec.height), limit / Math.max(rec.width, rec.height));
    const W = Math.max(1, Math.round(rec.width * scale));
    const H = Math.max(1, Math.round(rec.height * scale));
    const useCache = opts.cache !== false;
    const temps: Tex[] = [];
    const design = opts.design ?? null;
    const ops = collectOps(rec.layers, rec, !!design, opts.edits);

    // Decode everything first (async), then paint synchronously.
    const pending = new Map<string, Promise<Tex | undefined>>();
    const want = (index: number | undefined, w: number, h: number) => {
      if (index === undefined) return undefined;
      const k = String(index);
      if (!pending.has(k)) pending.set(k, this.blobTexture(rec, index, w, h, scale, useCache, temps));
      return pending.get(k)!;
    };
    const resolved = await Promise.all(
      ops.map(async (op) => {
        const l = op.layer;
        const px = op.kind === 0 && !op.isDesign ? await want(l.blob, l.width, l.height) : undefined;
        const mk = l.mask?.blob !== undefined ? await want(l.mask.blob, l.mask.right - l.mask.left, l.mask.bottom - l.mask.top) : undefined;
        return { px, mk };
      }),
    );

    this.canvas.width = W;
    this.canvas.height = H;
    this.targets(W, H);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    for (const f of this.fb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    gl.useProgram(this.prog);
    const U = this.u;
    gl.uniform1i(U.uBack, 0);
    gl.uniform1i(U.uTex, 1);
    gl.uniform1i(U.uMask, 2);
    gl.uniform1i(U.uLut, 3);
    // Give the content and mask units something valid to sample when an op has no texture (fills, curves).
    for (const unit of [gl.TEXTURE1, gl.TEXTURE2]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    }
    gl.uniform1f(U.uScale, scale);
    gl.uniform2f(U.uRes, W, H);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);

    let read = 0;
    ops.forEach((op, i) => {
      const l = op.layer;
      const { px, mk } = resolved[i];
      let content: Tex | undefined = px;
      let quad = false;
      if (op.isDesign && design && l.placedSize && l.placedQuad) {
        content = this.designTexture(design, l.placedSize[0], l.placedSize[1], scale, temps);
        quad = true;
        gl.uniformMatrix3fv(U.uInv, false, toColumnMajor(quadToUnit(l.placedQuad)));
      }
      if (op.kind === 0 && !content) return;

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[1 - read]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fbTex[read]);
      if (content) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, content.tex);
      }
      gl.uniform1i(U.uKind, op.kind);
      gl.uniform1i(U.uMode, MODES[op.blend ?? l.blendMode] ?? 0);
      gl.uniform1f(U.uOpacity, op.opacity * l.fillOpacity);
      gl.uniform1i(U.uQuad, quad ? 1 : 0);
      gl.uniform4f(U.uRect, l.left, l.top, Math.max(1, l.width), Math.max(1, l.height));

      if (op.kind === 1 && op.color) {
        const n = parseInt(op.color.slice(1), 16);
        gl.uniform3f(U.uColor, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
      } else if (op.kind === 2 && l.curves) {
        gl.activeTexture(gl.TEXTURE3);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(l.curves));
      }

      const m = l.mask;
      if (m && mk) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, mk.tex);
        gl.uniform1i(U.uMaskMode, 2);
        gl.uniform4f(U.uMaskRect, m.left, m.top, Math.max(1, m.right - m.left), Math.max(1, m.bottom - m.top));
        gl.uniform1f(U.uMaskDef, m.defaultColor / 255);
      } else if (m) {
        gl.uniform1i(U.uMaskMode, 1);
        gl.uniform1f(U.uMaskDef, m.defaultColor / 255);
      } else gl.uniform1i(U.uMaskMode, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      read = 1 - read;
    });

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fbTex[read]);
    gl.uniform1i(gl.getUniformLocation(this.blit, 'uSrc'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const type = opts.format ?? 'image/webp';
    let blob: Blob;
    if (type === 'image/jpeg') {
      // JPEG has no alpha: flatten onto white instead of letting transparent pixels turn black.
      const flat = new OffscreenCanvas(W, H);
      const fc = flat.getContext('2d')!;
      fc.fillStyle = '#fff';
      fc.fillRect(0, 0, W, H);
      fc.drawImage(this.canvas, 0, 0);
      blob = await flat.convertToBlob({ type, quality: 0.95 });
    } else {
      blob = await this.canvas.convertToBlob({ type, quality: 0.92 });
    }
    for (const t of temps) gl.deleteTexture(t.tex);
    return blob;
  }

  /** Frees cached textures for a removed mockup. */
  forget(recordId: string) {
    for (const [k, t] of this.cache) {
      if (k.startsWith(recordId + '|')) {
        this.cache.delete(k);
        this.cacheBytes -= t.bytes;
        this.gl.deleteTexture(t.tex);
      }
    }
  }
}

let shared: MockupRenderer | undefined;
export const renderer = () => (shared ??= new MockupRenderer());
