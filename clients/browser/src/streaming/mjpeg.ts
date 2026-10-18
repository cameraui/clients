export interface MJPEGHandlerOptions {
  signal: AbortSignal;
}

export interface MJPEGHandler {
  readonly stream: MediaStream;
  readonly frames: number;
  appendFrame: (data: ArrayBuffer) => void;
  close: () => void;
}

export function isJpegFrame(data: ArrayBuffer): boolean {
  if (data.byteLength < 2) return false;
  const bytes = new Uint8Array(data, 0, 2);
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

export function createMJPEGHandler(options: MJPEGHandlerOptions): MJPEGHandler {
  const { signal } = options;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  const stream = canvas.captureStream();

  let frames = 0;
  let decoding = false;
  let pending: ArrayBuffer | undefined;
  let closed = false;

  function appendFrame(data: ArrayBuffer): void {
    if (closed || signal.aborted) return;
    if (decoding) {
      pending = data;
      return;
    }
    decode(data);
  }

  async function decode(data: ArrayBuffer): Promise<void> {
    decoding = true;
    try {
      const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (!closed) draw(bitmap);
      bitmap.close();
    } catch {
      // a broken frame is skipped
    }
    decoding = false;

    const next = pending;
    pending = undefined;
    if (next && !closed) decode(next);
  }

  function draw(bitmap: ImageBitmap): void {
    if (!context) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    context.drawImage(bitmap, 0, 0);
    frames++;
  }

  function close(): void {
    closed = true;
    pending = undefined;
    for (const track of stream.getTracks()) track.stop();
  }

  signal.addEventListener('abort', close, { once: true });

  return {
    stream,
    get frames() {
      return frames;
    },
    appendFrame,
    close,
  };
}
