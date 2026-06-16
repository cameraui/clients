import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import type { ComputedRef, MaybeRefOrGetter } from 'vue';

interface FsState {
  wrapper: HTMLElement;
  parent: HTMLElement | null;
  next: Node | null;
  bodyOverflow: string;
  htmlOverflow: string;
}

const fsRegistry = new WeakMap<HTMLElement, FsState>();
const fullscreenStack: HTMLElement[] = [];
const topmostFullscreenWrapper = shallowRef<HTMLElement | null>(null);

function refreshTopmost(): void {
  topmostFullscreenWrapper.value = fullscreenStack[fullscreenStack.length - 1] ?? null;
}

export function useTopmostFullscreenElement(): ComputedRef<HTMLElement | null> {
  return computed(() => topmostFullscreenWrapper.value);
}

export type FullscreenMode = 'fit' | 'scroll';

export interface UseCuiFullscreenOptions {
  mode?: FullscreenMode;
}

export interface UseCuiFullscreenReturn {
  readonly isFullscreen: ComputedRef<boolean>;
  readonly isSupported: ComputedRef<boolean>;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  toggle: () => Promise<void>;
}

export function useCuiFullscreen(target: MaybeRefOrGetter<HTMLElement | null | undefined>, options: UseCuiFullscreenOptions = {}): UseCuiFullscreenReturn {
  const mode = options.mode ?? 'fit';

  const isFullscreen = ref(false);
  const currentEl = shallowRef<HTMLElement | null>(null);

  watch(
    () => toValue(target),
    (el) => {
      currentEl.value = el ?? null;
    },
    { immediate: true },
  );

  function onEscape(e: KeyboardEvent): void {
    if (e.key === 'Escape' && isFullscreen.value) {
      exit();
    }
  }

  async function enter(): Promise<void> {
    const el = currentEl.value;
    if (!el || isFullscreen.value) return;

    const wrapper = document.createElement('div');
    wrapper.className = `cui-fullscreen cui-fullscreen-${mode}`;
    applyWrapperStyles(wrapper, mode);

    const state: FsState = {
      wrapper,
      parent: el.parentElement,
      next: el.nextSibling,
      bodyOverflow: document.body.style.overflow,
      htmlOverflow: document.documentElement.style.overflow,
    };
    fsRegistry.set(el, state);

    el.setAttribute('data-cui-fullscreen', mode);
    document.body.appendChild(wrapper);
    wrapper.appendChild(el);

    // Stop the body underneath from scrolling/bouncing. The wrapper itself
    // has its own scroll behavior in 'scroll' mode.
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    document.addEventListener('keydown', onEscape);

    fullscreenStack.push(wrapper);
    refreshTopmost();

    isFullscreen.value = true;
  }

  async function exit(): Promise<void> {
    const el = currentEl.value;
    if (!el || !isFullscreen.value) return;

    const state = fsRegistry.get(el);
    if (!state) return;
    fsRegistry.delete(el);

    el.removeAttribute('data-cui-fullscreen');

    if (state.parent) {
      if (state.next && state.next.parentNode === state.parent) {
        state.parent.insertBefore(el, state.next);
      } else {
        state.parent.appendChild(el);
      }
    }
    state.wrapper.remove();

    document.body.style.overflow = state.bodyOverflow;
    document.documentElement.style.overflow = state.htmlOverflow;

    document.removeEventListener('keydown', onEscape);

    const stackIndex = fullscreenStack.indexOf(state.wrapper);
    if (stackIndex !== -1) fullscreenStack.splice(stackIndex, 1);
    refreshTopmost();

    isFullscreen.value = false;
  }

  async function toggle(): Promise<void> {
    if (isFullscreen.value) await exit();
    else await enter();
  }

  tryOnScopeDispose(() => {
    if (isFullscreen.value && currentEl.value) {
      exit();
    }
    document.removeEventListener('keydown', onEscape);
  });

  return {
    isFullscreen: computed(() => isFullscreen.value),
    isSupported: computed(() => true),
    enter,
    exit,
    toggle,
  };
}

function applyWrapperStyles(wrapper: HTMLElement, mode: FullscreenMode): void {
  const common = {
    position: 'fixed',
    top: '0',
    right: '0',
    bottom: '0',
    left: '0',
    zIndex: '2147483647',
    margin: '0',
    background: 'black',
    paddingTop: 'env(safe-area-inset-top)',
    paddingRight: 'env(safe-area-inset-right)',
    paddingBottom: 'env(safe-area-inset-bottom)',
    paddingLeft: 'env(safe-area-inset-left)',
    boxSizing: 'border-box',
  };

  if (mode === 'fit') {
    Object.assign(wrapper.style, common, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    });
  } else {
    Object.assign(wrapper.style, common, {
      display: 'block',
      overflowY: 'auto',
      overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch',
      overscrollBehavior: 'contain',
    });
  }
}
