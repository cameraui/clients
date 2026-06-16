import { inject } from 'vue';

import { CAMERA_UI_INJECTION_KEY } from '../plugin.js';

import type { CameraUiContext } from '../types.js';

export function useCameraUi(): CameraUiContext {
  const context = inject(CAMERA_UI_INJECTION_KEY);

  if (!context) {
    throw new Error(
      '[camera.ui] useCameraUi() called without CameraUiPlugin installed. ' + 'Make sure to call app.use(createCameraUiPlugin({ ... })) before using this composable.',
    );
  }

  return context;
}
