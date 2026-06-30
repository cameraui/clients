import { Logger } from '@camera.ui/logger';
import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref } from 'vue';

import type { ComputedRef } from 'vue';

const DEFAULT_TAB_PAUSE_MS = 30_000;

const log = new Logger('TabVisibility');

type HiddenCallback = () => void;
type VisibleCallback = (info: { hiddenMs: number }) => void;

interface HiddenEntry {
  cb: HiddenCallback;
}

interface PausedEntry {
  cb: HiddenCallback;
  delayMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface VisibleEntry {
  cb: VisibleCallback;
}

const _isVisible = ref(typeof document === 'undefined' ? true : document.visibilityState === 'visible');
let _hiddenAt: number | null = null;
const _hiddenListeners = new Set<HiddenEntry>();
const _pausedListeners = new Set<PausedEntry>();
const _visibleListeners = new Set<VisibleEntry>();
let _initialized = false;

function _firePausedEntry(entry: PausedEntry): void {
  log.debug(`paused listener fired (delay ${entry.delayMs}ms reached)`);
  try {
    entry.cb();
  } catch (err) {
    log.error('onTabPaused listener threw:', err);
  }
}

function _schedulePausedEntry(entry: PausedEntry): void {
  log.debug(`paused listener scheduled in ${entry.delayMs}ms`);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (_isVisible.value) {
      log.debug('paused listener skipped — tab visible before delay');
      return;
    }
    _firePausedEntry(entry);
  }, entry.delayMs);
}

function _cancelPausedEntries(): void {
  for (const entry of _pausedListeners) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}

function _init(): void {
  if (_initialized || typeof document === 'undefined') return;
  _initialized = true;

  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';

    if (!visible && _isVisible.value) {
      _isVisible.value = false;
      _hiddenAt = Date.now();
      log.debug(`tab → hidden (hidden=${_hiddenListeners.size} paused=${_pausedListeners.size})`);
      for (const entry of _hiddenListeners) {
        try {
          entry.cb();
        } catch (err) {
          log.error('onTabHidden listener threw:', err);
        }
      }
      for (const entry of _pausedListeners) {
        _schedulePausedEntry(entry);
      }
    } else if (visible && !_isVisible.value) {
      _cancelPausedEntries();
      const hiddenMs = _hiddenAt != null ? Date.now() - _hiddenAt : 0;
      _hiddenAt = null;
      _isVisible.value = true;
      log.debug(`tab → visible (hiddenMs=${hiddenMs}, visible-listeners=${_visibleListeners.size})`);
      for (const { cb } of _visibleListeners) {
        try {
          cb({ hiddenMs });
        } catch (err) {
          log.error('onTabVisible listener threw:', err);
        }
      }
    }
  });
}

export interface UseTabVisibilityReturn {
  readonly isVisible: ComputedRef<boolean>;
  onTabHidden(cb: HiddenCallback): () => void;
  onTabPaused(cb: HiddenCallback, options?: { delayMs?: number }): () => void;
  onTabVisible(cb: VisibleCallback): () => void;
}

export function useTabVisibility(): UseTabVisibilityReturn {
  _init();

  const isVisible = computed(() => _isVisible.value);

  function onTabHidden(cb: HiddenCallback): () => void {
    const entry: HiddenEntry = { cb };
    _hiddenListeners.add(entry);
    const off = () => {
      _hiddenListeners.delete(entry);
    };
    tryOnScopeDispose(off);
    return off;
  }

  function onTabPaused(cb: HiddenCallback, options: { delayMs?: number } = {}): () => void {
    const entry: PausedEntry = { cb, delayMs: options.delayMs ?? DEFAULT_TAB_PAUSE_MS, timer: null };
    _pausedListeners.add(entry);
    const off = () => {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      _pausedListeners.delete(entry);
    };
    tryOnScopeDispose(off);
    return off;
  }

  function onTabVisible(cb: VisibleCallback): () => void {
    const entry: VisibleEntry = { cb };
    _visibleListeners.add(entry);
    const off = () => {
      _visibleListeners.delete(entry);
    };
    tryOnScopeDispose(off);
    return off;
  }

  return {
    isVisible,
    onTabHidden,
    onTabPaused,
    onTabVisible,
  };
}
