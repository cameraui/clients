import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import type { ComputedRef, MaybeRefOrGetter } from 'vue';

interface FsState {
  wrapper: HTMLElement;
  parent: HTMLElement | null;
  placeholder: Comment;
  bodyOverflow: string;
  htmlOverflow: string;
  scrollY: number;
}

export interface NativeFullscreen {
  enter: () => Promise<boolean>;
  exit: () => Promise<void>;
}

const documentFullscreen: NativeFullscreen = {
  async enter() {
    if (!document.fullscreenEnabled || document.fullscreenElement) return false;
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return true;
  },
  async exit() {
    if (document.fullscreenElement) await document.exitFullscreen();
  },
};

const fsRegistry = new WeakMap<HTMLElement, FsState>();
let fullscreenRoot: HTMLElement | null = null;
let nativeFullscreen: NativeFullscreen | null = documentFullscreen;
let nativeOwned = false;

export function setFullscreenRoot(el: HTMLElement | null): void {
  fullscreenRoot = el;
}

export function setNativeFullscreen(native: NativeFullscreen | null): void {
  nativeFullscreen = native;
}

const fullscreenStack: HTMLElement[] = [];
const topmostFullscreenWrapper = shallowRef<HTMLElement | null>(null);

function refreshTopmost(): void {
  topmostFullscreenWrapper.value = fullscreenStack[fullscreenStack.length - 1] ?? null;
}

function enterNative(): void {
  if (!nativeFullscreen || nativeOwned) return;
  nativeOwned = true;
  // the page goes native underneath the overlay, the browser's bars and the system's go with it
  nativeFullscreen.enter().then(
    (taken) => {
      nativeOwned = taken;
      // ours may have ended while the request was on its way
      exitNative();
    },
    () => {
      nativeOwned = false;
    },
  );
}

function exitNative(): void {
  if (!nativeOwned || fullscreenStack.length > 0) return;
  nativeOwned = false;
  nativeFullscreen?.exit();
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

  function onNativeChange(): void {
    // the browser's Esc or a system gesture ends native fullscreen, ours follows
    if (nativeOwned && nativeFullscreen === documentFullscreen && !document.fullscreenElement) exit();
  }

  async function enter(): Promise<void> {
    const el = currentEl.value;
    if (!el || isFullscreen.value) return;

    enterNative();

    const wrapper = document.createElement('div');
    wrapper.className = `cui-fullscreen cui-fullscreen-${mode}`;
    applyWrapperStyles(wrapper, mode);

    // the host may swap the element's siblings while it is away, a marker of our own keeps its place
    const placeholder = document.createComment('cui-fullscreen');
    el.before(placeholder);

    const state: FsState = {
      wrapper,
      parent: el.parentElement,
      placeholder,
      bodyOverflow: document.body.style.overflow,
      htmlOverflow: document.documentElement.style.overflow,
      scrollY: window.scrollY,
    };
    fsRegistry.set(el, state);

    el.setAttribute('data-cui-fullscreen', mode);
    (fullscreenRoot ?? document.body).appendChild(wrapper);
    wrapper.appendChild(el);

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    // overlays inside the wrapper position themselves in page coordinates, the fixed wrapper starts at the viewport top
    window.scrollTo({ top: 0, behavior: 'instant' });

    document.addEventListener('keydown', onEscape);
    document.addEventListener('fullscreenchange', onNativeChange);

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

    if (state.placeholder.parentNode) {
      state.placeholder.replaceWith(el);
    } else {
      state.parent?.appendChild(el);
    }
    state.wrapper.remove();

    document.body.style.overflow = state.bodyOverflow;
    document.documentElement.style.overflow = state.htmlOverflow;
    window.scrollTo({ top: state.scrollY, behavior: 'instant' });

    document.removeEventListener('keydown', onEscape);
    document.removeEventListener('fullscreenchange', onNativeChange);

    const stackIndex = fullscreenStack.indexOf(state.wrapper);
    if (stackIndex !== -1) fullscreenStack.splice(stackIndex, 1);
    refreshTopmost();
    exitNative();

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
    document.removeEventListener('fullscreenchange', onNativeChange);
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
