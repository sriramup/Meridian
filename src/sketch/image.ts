// Browser-side image preprocessing for sketches and photos: decode (EXIF orientation honoured),
// downscale to ≤ 1568 px on the long edge (what the vision model reads at full detail; larger
// images cost more and are downscaled by the API anyway), re-encode as JPEG ≈ 0.85, and make a small
// thumbnail for the composer chip, the message bubble and the saved history. Unreadable, unsupported
// or huge files are refused with a plain message.

import { growFrame, rectifiedSize, warpFrame, type FrameCorners } from "./rectify";
import { newSketchId, type SketchAttachment } from "./store";

export const MAX_EDGE = 1568;
export const THUMB_EDGE = 176;
export const JPEG_QUALITY = 0.85;
/** files above this are refused before decoding (a 48 MP phone photo is ≈ 15–25 MB) */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
/** the smallest picture that can hold a readable plan */
export const MIN_EDGE = 200;
export const ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif";

/** scale (w, h) to fit within `max` on the long edge (never upscales) */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number; scale: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}

const isHeic = (f: { type: string; name?: string }) => /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name ?? "");

/** why a file can't be used (before decoding), or null */
export function checkFile(f: { type: string; size: number; name?: string }): string | null {
  const imageLike = /^image\//.test(f.type) || isHeic(f) || (!f.type && /\.(png|jpe?g|webp)$/i.test(f.name ?? ""));
  if (!imageLike) return "That isn't an image. Attach a PNG, JPEG, WebP or HEIC photo of the sketch.";
  if (/svg|gif/i.test(f.type)) return "Animated and vector images can't be read as a sketch. Attach a PNG, JPEG, WebP or HEIC photo.";
  if (f.size > MAX_INPUT_BYTES) return `That photo is ${Math.round(f.size / 1024 / 1024)} MB; the limit is ${MAX_INPUT_BYTES / 1024 / 1024} MB. Export a smaller copy and try again.`;
  if (f.size < 64) return "That file is empty.";
  return null;
}

/** a friendly name for the attachment from its file name ("IMG_2041.HEIC" → "Photo", "riverside-plan.png" → "riverside plan") */
export function displayName(name: string | undefined, fallback = "Sketch"): string {
  const base = (name ?? "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim();
  if (!base || (/^(img|image|dsc|pxl|photo|screenshot|screen shot|whatsapp image)\b/i.test(base) && /\d{3,}/.test(base))) return fallback;
  return base.slice(0, 60);
}

/** a project name from an attachment ("riverside plan" → "Riverside plan") */
export function projectNameFor(att: { name: string }): string {
  const n = displayName(att.name, "");
  return n ? n[0].toUpperCase() + n.slice(1) : "From a sketch";
}

/** bytes of a base64 string */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap applies the EXIF orientation with imageOrientation "from-image"
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      // fall through to <img> (some formats decode only there)
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    // <img> honours EXIF orientation by default (CSS image-orientation: from-image)
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))), "image/jpeg", quality));
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("The image could not be read."));
    r.readAsDataURL(b);
  });
}

function draw(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  // transparent PNGs (exported diagrams) read as black on JPEG: put them on white like a whiteboard
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  return c;
}

export class ImageError extends Error {}

/** decode → orient → downscale → JPEG, plus a thumbnail */
export async function preprocessImage(blob: Blob, name: string): Promise<SketchAttachment> {
  const bad = checkFile({ type: blob.type, size: blob.size, name });
  if (bad) throw new ImageError(bad);
  let img: ImageBitmap | HTMLImageElement;
  try {
    img = await decode(blob);
  } catch {
    throw new ImageError(isHeic({ type: blob.type, name }) ? "This browser can't open HEIC photos. Export it as JPEG (on an iPhone: Settings › Camera › Formats › Most Compatible) and try again." : "That image couldn't be opened; it may be damaged or in an unsupported format.");
  }
  const w0 = "naturalWidth" in img ? img.naturalWidth : img.width,
    h0 = "naturalHeight" in img ? img.naturalHeight : img.height;
  if (!w0 || !h0) throw new ImageError("That image is empty.");
  if (Math.max(w0, h0) < MIN_EDGE) throw new ImageError(`That image is only ${w0} × ${h0} pixels, too small to read a plan from. Use a larger photo.`);
  const fit = fitWithin(w0, h0, MAX_EDGE);
  let quality = JPEG_QUALITY;
  let jpeg = await toBlob(draw(img, fit.w, fit.h), quality);
  // a very busy photo: step the quality down rather than send megabytes
  while (jpeg.size > 1_800_000 && quality > 0.55) {
    quality -= 0.1;
    jpeg = await toBlob(draw(img, fit.w, fit.h), quality);
  }
  const t = fitWithin(w0, h0, THUMB_EDGE);
  const thumb = `data:image/jpeg;base64,${await blobToBase64(await toBlob(draw(img, t.w, t.h), 0.72))}`;
  if ("close" in img) img.close();
  return { id: newSketchId(), name, media_type: "image/jpeg", data: await blobToBase64(jpeg), width: fit.w, height: fit.h, thumb, bytes: jpeg.size };
}

/** a faint labelled reference grid at every 0.1 (helps the vision model read positions; not part of the plan) */
export function drawGrid(g: CanvasRenderingContext2D, w: number, h: number) {
  g.save();
  g.strokeStyle = "rgba(0,170,220,0.45)";
  g.lineWidth = Math.max(1, w / 900);
  g.fillStyle = "rgba(0,140,190,0.9)";
  g.font = `bold ${Math.round(Math.max(w, h) / 75)}px sans-serif`;
  for (let i = 1; i < 10; i++) {
    const x = (w * i) / 10,
      y = (h * i) / 10;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
    const t = `0.${i}`;
    g.textAlign = "center";
    g.textBaseline = "top";
    g.fillText(t, x, 3);
    g.textBaseline = "bottom";
    g.fillText(t, x, h - 3);
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(t, 4, y);
    g.textAlign = "right";
    g.fillText(t, w - 4, y);
  }
  g.restore();
}

async function canvasOf(att: { data: string; media_type: string }): Promise<HTMLCanvasElement> {
  const img = await decode(await (await fetch(`data:${att.media_type};base64,${att.data}`)).blob());
  const w = "naturalWidth" in img ? img.naturalWidth : img.width,
    h = "naturalHeight" in img ? img.naturalHeight : img.height;
  const c = draw(img, w, h);
  if ("close" in img) img.close();
  return c;
}

/** the image with the reference grid drawn over it (for the frame pass) */
export async function withGrid(att: SketchAttachment): Promise<SketchAttachment> {
  const c = await canvasOf(att);
  drawGrid(c.getContext("2d")!, c.width, c.height);
  return { ...att, data: await blobToBase64(await toBlob(c, 0.88)) };
}

export interface Straightened {
  /** upright drawing for the model to read: the reference grid drawn over it */
  gridded: SketchAttachment;
  /** the same without the grid (what the agent sees, and what the reading card shows) */
  plain: SketchAttachment;
  /** a display copy (≤ 720 px) as a data URL */
  view: string;
}

/** map the drawn frame onto an upright rectangle (perspective transform) */
export async function straighten(att: SketchAttachment, frame: FrameCorners): Promise<Straightened> {
  const src = await canvasOf(att);
  const f = growFrame(frame);
  const { w, h } = rectifiedSize(f, src.width, src.height, 1400);
  const out = warpFrame(src.getContext("2d")!.getImageData(0, 0, src.width, src.height), f, w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.putImageData(new ImageData(new Uint8ClampedArray(out.data), w, h), 0, 0);
  const plainBlob = await toBlob(c, 0.88);
  const v = fitWithin(w, h, 720);
  const view = `data:image/jpeg;base64,${await blobToBase64(await toBlob(draw(c, v.w, v.h), 0.8))}`;
  drawGrid(g, w, h);
  const gridBlob = await toBlob(c, 0.88);
  const base = { ...att, width: w, height: h };
  return { gridded: { ...base, data: await blobToBase64(gridBlob), bytes: gridBlob.size }, plain: { ...base, data: await blobToBase64(plainBlob), bytes: plainBlob.size }, view };
}

/** the first image in a clipboard / drag payload */
export function imageFromItems(items: DataTransferItemList | null | undefined, files?: FileList | null): File | null {
  for (const f of Array.from(files ?? [])) if (/^image\//.test(f.type) || isHeic(f)) return f;
  for (const it of Array.from(items ?? [])) {
    if (it.kind !== "file") continue;
    const f = it.getAsFile();
    if (f && (/^image\//.test(f.type) || isHeic(f))) return f;
  }
  return null;
}

/** does a drag carry files (dragenter can't read them yet, only their kinds) */
export const dragHasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes("Files");
