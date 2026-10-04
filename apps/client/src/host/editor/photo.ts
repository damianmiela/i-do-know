// Photos for photo questions: shrunk in the browser before upload (Damian's decision: no image
// library on the server). Guests download them on mobile data, so they must stay small.

/** Longest side after shrinking (the big screen shows photos at most ~620 px wide). */
export const PHOTO_MAX_SIDE = 1200;

/** The size a photo gets: the longest side at most `max`, never enlarged. */
export function fitSize(width: number, height: number, max = PHOTO_MAX_SIDE) {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Shrinks a picture from the laptop to a small WebP (JPEG in browsers that can't make WebP,
 * e.g. Safari): about 100–300 KB instead of several MB.
 */
export async function shrink(file: File): Promise<Blob> {
  const image = await createImageBitmap(file);
  const { width, height } = fitSize(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot shrink pictures.');
  context.drawImage(image, 0, 0, width, height);
  image.close();
  const webp = await toBlob(canvas, 'image/webp', 0.8);
  if (webp?.type === 'image/webp') return webp;
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.85);
  if (!jpeg) throw new Error('This browser cannot shrink pictures.');
  return jpeg;
}

/** Sends a shrunk photo to the server; returns the file name the server gave it. */
export async function uploadPhoto(blob: Blob): Promise<string> {
  const res = await fetch('/host/photos', {
    method: 'POST',
    headers: { 'content-type': blob.type },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload refused (${res.status}).`);
  const { name } = (await res.json()) as { name: string };
  return name;
}
