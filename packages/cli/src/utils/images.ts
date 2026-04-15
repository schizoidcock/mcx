/**
 * Image extraction utilities for MCP native image support.
 * Adapters return McxImageContent markers, which are extracted
 * and sent as separate MCP image content.
 */

/** Marker interface for native MCP images */
export interface McxImageContent {
  __mcx_image__: true;
  mimeType: string;
  data: string; // base64
}

/** MCP image content type */
export type ImageContent = { type: "image"; mimeType: string; data: string };

/** Check if a value is an MCX image marker */
export function isMcxImage(value: unknown): value is McxImageContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as McxImageContent).__mcx_image__ === true &&
    typeof (value as McxImageContent).mimeType === "string" &&
    typeof (value as McxImageContent).data === "string"
  );
}

/** Check if value is image metadata (placeholder after extraction) */
export function isImageMetadata(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).__image__ === true;
}

/** Convert McxImageContent to ImageContent */
function toImageContent(img: McxImageContent): ImageContent {
  return { type: "image", mimeType: img.mimeType, data: img.data };
}

/** Extract images from array */
function extractFromArray(arr: unknown[]): { value: unknown[]; images: ImageContent[] } {
  if (!arr.some(isMcxImage)) return { value: arr, images: [] };
  
  const images: ImageContent[] = [];
  const rest: unknown[] = [];
  for (const item of arr) {
    if (isMcxImage(item)) images.push(toImageContent(item));
    else rest.push(item);
  }
  return { value: rest, images };
}

/** Extract images from object */
function extractFromObject(obj: Record<string, unknown>): { value: Record<string, unknown>; images: ImageContent[] } {
  const hasImage = Object.values(obj).some(isMcxImage);
  if (!hasImage) return { value: obj, images: [] };

  const images: ImageContent[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (isMcxImage(val)) images.push(toImageContent(val));
    else rest[key] = val;
  }
  return { value: rest, images };
}

/** Extract images from result, returning remaining value and extracted images */
export function extractImages(value: unknown): { value: unknown; images: ImageContent[] } {
  if (value === null || typeof value !== "object") {
    return { value, images: [] };
  }

  if (isMcxImage(value)) {
    return {
      value: { __image__: true, mimeType: value.mimeType, size: value.data.length },
      images: [toImageContent(value)],
    };
  }

  if (Array.isArray(value)) return extractFromArray(value);
  return extractFromObject(value as Record<string, unknown>);
}
