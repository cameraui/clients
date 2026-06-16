import type { MaybeRefOrGetter } from 'vue';
import type { ReactiveCameraDevice } from '../types.js';

export type CameraIdentifier = MaybeRefOrGetter<string | ReactiveCameraDevice | undefined>;

export function extractCameraId(camera: string | ReactiveCameraDevice | undefined): string | undefined {
  if (!camera) return undefined;
  if (typeof camera === 'string') return camera;
  return camera.id;
}
