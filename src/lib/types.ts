export type LayerKind = 'group' | 'pixel' | 'smartObject' | 'text' | 'fill' | 'adjustment';

/** Bump when the stored shape changes; older records are dropped on load. */
export const RECORD_SCHEMA = 2;

export interface MaskMeta {
  /** Index into the blob list (grayscale PNG). Absent = the mask is a constant `defaultColor`. */
  blob?: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 0-255, the value outside the mask rectangle. */
  defaultColor: number;
}

export interface CurvePoint {
  input: number;
  output: number;
}

export interface CurvesMeta {
  rgb?: CurvePoint[];
  red?: CurvePoint[];
  green?: CurvePoint[];
  blue?: CurvePoint[];
}

export interface LayerMeta {
  /** Index into the file's blob list, when pixels were kept. */
  blob?: number;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number;
  /** Photoshop "Fill" slider, 0-1. Effective alpha is opacity * fillOpacity. */
  fillOpacity: number;
  blendMode: string;
  left: number;
  top: number;
  width: number;
  height: number;
  mask?: MaskMeta;
  curves?: CurvesMeta;
  /** Smart object placement: 8 numbers, the four corner points of the transformed quad. */
  placedQuad?: number[];
  /** Id of the linked smart object content; duplicates of one smart object share it. */
  placedId?: string;
  /** Size of the smart object's own canvas, i.e. the box a replacement design is fitted into. */
  placedSize?: [number, number];
  /** Solid color fill, #rrggbb. */
  fillColor?: string;
  children?: LayerMeta[];
}

/** Where a signed-in user's original PSD was copied to in their Google Drive. */
export interface BackupInfo {
  fileId: string;
  link: string;
  at: number;
}

export interface MockupRecord {
  id: string;
  schema: number;
  name: string;
  rawBytes: number;
  storedBytes: number;
  width: number;
  height: number;
  layerCount: number;
  smartObjectCount: number;
  layers: LayerMeta[];
  /** placedId of the smart object a user's design replaces. */
  designTargetId?: string;
  /** Things in the file the renderer can't reproduce yet. */
  warnings: string[];
  /** Set once the original file has been uploaded to Drive. Optional, so older records stay valid. */
  backup?: BackupInfo;
  createdAt: number;
  /** null = never expires (signed-in user). */
  expiresAt: number | null;
  owner: string | null;
}

export type IngestStage = 'reading' | 'parsing' | 'compressing' | 'saving';

export interface IngestProgress {
  stage: IngestStage;
  fraction: number;
}
