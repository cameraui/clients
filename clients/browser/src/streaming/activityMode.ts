import { ref } from 'vue';

import type { Ref } from 'vue';

const DEFAULT_CONFIG: Required<ActivityModeConfig> = {
  standbyTimeout: 5000,
  activityTimeout: 5000,
  wakeTimeout: 30000,
};

export type CameraActivityMode = 'always-on' | 'standby' | 'activity';

export interface ActivityModeConfig {
  standbyTimeout?: number;
  activityTimeout?: number;
  wakeTimeout?: number;
}

export interface ActivityModeState {
  readonly mode: Ref<CameraActivityMode>;
  readonly inStandby: Ref<boolean>;
  readonly hasActivity: Ref<boolean>;
}

export interface ActivityModeActions {
  setMode: (mode: CameraActivityMode) => void;
  engage: () => void;
  reportActivity: (hasActivity: boolean) => void;
  resumeFromStandby: () => void;
  resetIdleTimer: () => void;
  setKeepAwake: (awake: boolean) => void;
  dispose: () => void;
}

export interface ActivityMode extends ActivityModeState, ActivityModeActions {}

export interface CreateActivityModeOptions {
  initialMode?: CameraActivityMode;
  config?: ActivityModeConfig;
  onStreamStart: () => void;
  onStreamStop: () => void;
  isStreamPlaying: () => boolean;
}

export function createActivityMode(options: CreateActivityModeOptions): ActivityMode {
  const { initialMode = 'always-on', config = {}, onStreamStart, onStreamStop, isStreamPlaying } = options;

  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };

  const mode = ref<CameraActivityMode>(initialMode);
  const inStandby = ref(false);
  const hasActivity = ref(false);

  let activityTimeout: NodeJS.Timeout | undefined;
  let idleTimeout: NodeJS.Timeout | undefined;
  let keepAwake = false;
  let engaged = false;

  function clearActivityTimeout(): void {
    if (activityTimeout) {
      clearTimeout(activityTimeout);
      activityTimeout = undefined;
    }
  }

  function clearIdleTimeout(): void {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = undefined;
    }
  }

  function clearAllTimers(): void {
    clearActivityTimeout();
    clearIdleTimeout();
  }

  function goToStandby(): void {
    if (!inStandby.value) {
      inStandby.value = true;
      onStreamStop();
    }
  }

  function exitStandby(): void {
    if (inStandby.value) {
      inStandby.value = false;
      onStreamStart();
    }
  }

  function manageStreamState(): void {
    clearAllTimers();

    switch (mode.value) {
      case 'always-on':
        inStandby.value = false;
        if (!isStreamPlaying()) {
          onStreamStart();
        }
        break;

      case 'standby':
        if (!inStandby.value) {
          if (!isStreamPlaying()) {
            onStreamStart();
          }
          startIdleTimer();
        }
        break;

      case 'activity':
        if (hasActivity.value) {
          inStandby.value = false;
          if (!isStreamPlaying()) {
            onStreamStart();
          }
        } else {
          // grace period against flicker on a mode switch
          activityTimeout = setTimeout(() => {
            if (mode.value === 'activity' && !hasActivity.value) {
              goToStandby();
            }
          }, resolvedConfig.activityTimeout);
        }
        break;
    }
  }

  function startIdleTimer(): void {
    clearIdleTimeout();
    if (keepAwake) return;
    const timeout = isStreamPlaying() ? resolvedConfig.standbyTimeout : resolvedConfig.wakeTimeout;
    idleTimeout = setTimeout(() => {
      if (mode.value === 'standby') {
        goToStandby();
      }
    }, timeout);
  }

  function setMode(newMode: CameraActivityMode): void {
    if (mode.value !== newMode) {
      mode.value = newMode;
      if (engaged) manageStreamState();
    }
  }

  function engage(): void {
    engaged = true;
    const rests = mode.value === 'standby' || (mode.value === 'activity' && !hasActivity.value);
    if (rests && !isStreamPlaying()) {
      clearAllTimers();
      goToStandby();
      return;
    }
    manageStreamState();
  }

  function reportActivity(detected: boolean): void {
    if (mode.value !== 'activity') {
      return;
    }

    if (detected) {
      hasActivity.value = true;
      clearActivityTimeout();

      if (inStandby.value) {
        exitStandby();
      } else if (!isStreamPlaying()) {
        onStreamStart();
      }
    } else {
      hasActivity.value = false;
      clearActivityTimeout();
      activityTimeout = setTimeout(() => {
        if (!hasActivity.value) {
          goToStandby();
        }
      }, resolvedConfig.activityTimeout);
    }
  }

  function resumeFromStandby(): void {
    if (!inStandby.value) {
      return;
    }

    exitStandby();

    switch (mode.value) {
      case 'standby':
        startIdleTimer();
        break;

      case 'activity':
        clearActivityTimeout();
        if (!hasActivity.value) {
          activityTimeout = setTimeout(() => {
            goToStandby();
          }, resolvedConfig.activityTimeout);
        }
        break;
    }
  }

  function resetIdleTimer(): void {
    if (engaged && mode.value === 'standby' && !inStandby.value) {
      startIdleTimer();
    }
  }

  function setKeepAwake(awake: boolean): void {
    if (keepAwake === awake) return;
    keepAwake = awake;
    if (awake) {
      clearIdleTimeout();
    } else {
      resetIdleTimer();
    }
  }

  function dispose(): void {
    clearAllTimers();
  }

  return {
    mode,
    inStandby,
    hasActivity,
    setMode,
    engage,
    reportActivity,
    resumeFromStandby,
    resetIdleTimer,
    setKeepAwake,
    dispose,
  };
}
