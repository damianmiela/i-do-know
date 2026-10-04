// Motion for the big screen and the phone (Phase 6.5): slow and elegant, but never in the way.
// - A screen decides ONCE, when it appears, whether it animates (useAnimate): after a reconnect or
//   a restart it simply shows the current state, and a later update never replays an animation.
// - Mostly movement, size and fading (smooth on an average laptop); on the big screen also two
//   slow glows and the top-3 frames fading in.
// - The phone has only short reveal animations (under 1.5 s); they may replay after a reload.
// - "Reduce motion" in the system settings turns it all off (CSS and useCountUp).
import { createContext, useContext, useEffect, useRef, useState } from 'react';

/** True while the current view came right after a (re)connect: show it without animation. */
export const InstantContext = createContext(false);

/** Whether this screen animates. Fixed when it mounts, so later updates never replay anything. */
export function useAnimate(): boolean {
  const instant = useContext(InstantContext);
  const [animate] = useState(() => !instant && !prefersReducedMotion());
  return animate;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Ease-out: fast start, gentle landing. */
export const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** The value `delay` ms into a count from `from` to `to` that takes `duration` ms. */
export function countAt(
  from: number,
  to: number,
  elapsed: number,
  delay: number,
  duration: number,
) {
  const k = Math.min(Math.max((elapsed - delay) / duration, 0), 1);
  return from + (to - from) * easeOut(k);
}

interface CountUp {
  /** Where the count starts (default: the target, i.e. only later changes count). */
  from?: number;
  delay?: number;
  duration?: number;
  animate?: boolean;
}

/**
 * A number that counts up to `target` (votes, scores, the lobby's guest count). When the target
 * changes later, it counts from the value shown to the new one.
 */
export function useCountUp(
  target: number,
  { from, delay = 0, duration = 1200, animate = true }: CountUp = {},
): number {
  const [value, setValue] = useState(() => (animate ? (from ?? target) : target));
  const shown = useRef(value);
  useEffect(() => {
    if (!animate) return;
    const start = shown.current;
    if (start === target) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const v = countAt(start, target, t - t0, delay, duration);
      shown.current = v;
      setValue(v);
      if (t - t0 < delay + duration) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, animate, delay, duration]);
  return animate ? Math.round(value) : target;
}
