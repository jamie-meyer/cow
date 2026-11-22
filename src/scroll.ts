// Scrolling by key, eased: one scroller for every place a key scrolls or the
// view follows the cursor (the list, the queue, the sheets and cards, the
// reader, the chat in the pane).
//
// How it moves:
// - A press scrolls a fixed step, eased in and out over STEP_MS, and lands
//   exactly on its target. Presses in the same direction add up.
// - The key's repeat (the key held down) does not add more steps: from the
//   first repeat on, the view glides at HOLD_SPEED until the key is let go,
//   and then slows to rest over STOP_MS, which covers half of what the same
//   time at full speed would. However fast the keyboard repeats, the speed is
//   the same, and nothing queues up.
// - The opposite key turns round at once: the new step starts from where the
//   view is, at rest.
// - Half pages, pages and the ends take JUMP_MS, however far they go.
// - Following the cursor eases to the nearest place that shows its line over
//   FOLLOW_MS, keeping the speed it has, so a held key that moves the cursor
//   line by line moves the view steadily. While the key repeats, the line is
//   kept a few lines from the edge, more than the follower ever lags by, and
//   on every frame the line is held in view whatever the ease says.
// - Everything is a function of time, evaluated when a frame is drawn: the
//   motion is the same at any frame rate.
// - With the person's "reduce motion" setting, every motion is a jump.

/** A thing that scrolls up and down. */
export interface Surface {
  read(): number;
  write(top: number): void;
  /** The furthest it can scroll. */
  max(): number;
  /** How much of it shows. */
  height(): number;
}

/** Time and frames: the browser's, or a test's. */
export interface Frames {
  now(): number;
  request(run: () => void): number;
  cancel(id: number): void;
  reduced(): boolean;
}

/** One press: how far it goes, and how long it takes. */
export const STEP_MS = 140;
/** A held key's speed, in pixels a second. */
export const HOLD_SPEED = 900;
/** From still to the held speed. */
export const RAMP_MS = 90;
/** From the held speed to rest, once the key is let go. */
export const STOP_MS = 120;
/** Half pages, pages, the top and the bottom. */
export const JUMP_MS = 180;
/** The view following the cursor. */
export const FOLLOW_MS = 100;
/** A held key whose repeats stop arriving, its release missed, is let go after this long. */
export const HOLD_LAPSE_MS = 400;
/** While the cursor's key repeats, the cursor line is kept this many lines from the edge. */
export const FOLLOW_LINES = 3;
/** Gone to the bottom, it stays with a bottom that keeps moving off for at most this long. */
export const END_CHASE_MS = 2000;
/** Nearer the bottom than this when a frame comes, it is at the bottom. */
const AT_BOTTOM_PX = 1.5;
/** Further from where it was put than this, the view was moved by something else. */
const MOVED_PX = 3;

const PER_MS = HOLD_SPEED / 1000;

type Segment =
  | { kind: "still" }
  /** A cubic ease from p0 at speed v0 to p1, at rest, over d. `end`: p1 is the bottom, wherever it moves to. */
  | { kind: "curve"; t0: number; d: number; p0: number; v0: number; p1: number; end: boolean }
  /** The held key: from p0 at v0, speeding to v over RAMP_MS, and on. */
  | { kind: "cruise"; t0: number; p0: number; v0: number; v: number };

/** Where a segment has got to at time t, and how fast it moves, in pixels a millisecond. */
function at(segment: Segment, t: number, max: number, rest: number): { p: number; v: number; done: boolean } {
  if (segment.kind === "still") return { p: rest, v: 0, done: true };
  const tau = Math.max(0, t - segment.t0);
  if (segment.kind === "cruise") {
    const { p0, v0, v } = segment;
    if (tau < RAMP_MS) return { p: p0 + v0 * tau + ((v - v0) * tau * tau) / (2 * RAMP_MS), v: v0 + ((v - v0) * tau) / RAMP_MS, done: false };
    const ramped = p0 + ((v0 + v) * RAMP_MS) / 2;
    return { p: ramped + v * (tau - RAMP_MS), v, done: false };
  }
  const p1 = segment.end ? max : segment.p1;
  const { p0, v0, d } = segment;
  if (tau >= d) return { p: p1, v: 0, done: true };
  const s = tau / d;
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
  const h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const p = h00 * p0 + h10 * d * v0 + h01 * p1;
  const v = ((6 * s ** 2 - 6 * s) * p0 + (3 * s ** 2 - 4 * s + 1) * d * v0 + (-6 * s ** 2 + 6 * s) * p1) / d;
  return { p, v, done: false };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The key being handled right now, if a key is: which one, and whether it is the key's repeat. */
let pressing: { code: string; repeat: boolean } | null = null;
/** Scrollers moving because a key is held. */
const holding = new Set<Scroller>();

/** Run what a key does, with the scrollers told which key it is and whether it repeats. */
export function whilePressing<T>(key: { code: string; repeat: boolean }, run: () => T): T {
  const before = pressing;
  pressing = { code: key.code, repeat: key.repeat };
  try {
    return run();
  } finally {
    pressing = before;
  }
}

/** A key was let go, or the window lost the keyboard (`null`: every key). */
export function keyReleased(code: string | null): void {
  for (const scroller of [...holding]) scroller.release(code);
}

/** Whether the key being handled is a held key's repeat. */
export const repeating = (): boolean => pressing?.repeat === true;

/** Keeps one surface moving. */
export class Scroller {
  private segment: Segment = { kind: "still" };
  private frame = 0;
  /** Where it was last put, as read back. */
  private put: number | null = null;
  /** The held key, its direction, and when it last repeated. */
  private held: { code: string; dir: 1 | -1; last: number } | null = null;
  /** While following the cursor: the place each frame must stay within, so the cursor line shows. */
  private keep: { low: number; high: number } | null = null;

  private readonly surface: Surface;
  private readonly frames: Frames;

  constructor(surface: Surface, frames: Frames) {
    this.surface = surface;
    this.frames = frames;
  }

  /** Whether it is moving. */
  get moving(): boolean {
    return this.segment.kind !== "still";
  }

  /** Where it will come to rest, as far as anything asked so far goes. */
  destination(): number {
    const max = this.surface.max();
    const segment = this.segment;
    if (segment.kind === "still") return this.surface.read();
    if (segment.kind === "curve") return clamp(segment.end ? max : segment.p1, 0, max);
    const now = this.now(this.frames.now());
    return clamp(now.p + (now.v * STOP_MS) / 2, 0, max);
  }

  /** Scroll one step of `size` pixels, `dir` down or up: a press, or the key's repeat. */
  step(dir: 1 | -1, size: number): void {
    const t = this.frames.now();
    const key = pressing;
    const max = this.surface.max();
    this.keep = null;
    if (this.frames.reduced()) return this.jumpNow(clamp(this.destination() + dir * size, 0, max));
    if (key?.repeat) {
      if (this.held?.dir === dir) {
        this.held.last = t;
        return;
      }
      // The first repeat: from here the key is held.
      const now = this.now(t);
      this.held = { code: key.code, dir, last: t };
      holding.add(this);
      this.segment = { kind: "cruise", t0: t, p0: now.p, v0: Math.sign(now.v) === dir ? now.v : 0, v: dir * PER_MS };
      return this.run();
    }
    this.letGo();
    const now = this.now(t);
    const sameWay = this.segment.kind !== "still" && Math.sign(now.v) === dir;
    const from = sameWay && this.segment.kind === "curve" && !this.segment.end ? this.segment.p1 : now.p;
    this.curve(t, now, clamp(from + dir * size, 0, max), STEP_MS, sameWay);
  }

  /** Go to `to`, or the bottom, over JUMP_MS. */
  jump(to: number | "end"): void {
    const t = this.frames.now();
    const max = this.surface.max();
    this.keep = null;
    this.letGo();
    if (this.frames.reduced()) return this.jumpNow(to === "end" ? max : clamp(to, 0, max));
    const now = this.now(t);
    const target = to === "end" ? max : clamp(to, 0, max);
    this.curve(t, now, target, JUMP_MS, true, to === "end");
  }

  /**
   * Bring the part from `top` to `bottom` (in the surface's own coordinates)
   * into view the least way, as the cursor moves onto it.
   */
  follow(top: number, bottom: number): void {
    const height = this.surface.height();
    const max = this.surface.max();
    const margin = repeating() ? Math.min(FOLLOW_LINES * (bottom - top), Math.max(0, (height - (bottom - top)) / 2)) : 0;
    const from = this.destination();
    let to = from;
    if (top - margin < from) to = top - margin;
    else if (bottom + margin > from + height) to = bottom + margin - height;
    to = clamp(to, 0, max);
    const keep = { low: clamp(bottom - height, 0, max), high: clamp(top, 0, max) };
    if (to === from) {
      if (this.segment.kind !== "still") this.keep = keep;
      return;
    }
    if (this.toward(to)) this.keep = keep;
  }

  /**
   * Ease to `to`, keeping the speed it has: over FOLLOW_MS, or JUMP_MS when
   * it is more than what shows away. True when it eased the short way.
   */
  toward(to: number): boolean {
    const t = this.frames.now();
    to = clamp(to, 0, this.surface.max());
    this.keep = null;
    this.letGo();
    if (this.frames.reduced()) {
      this.jumpNow(to);
      return false;
    }
    const now = this.now(t);
    const far = Math.abs(to - now.p) > this.surface.height();
    this.curve(t, now, to, far ? JUMP_MS : FOLLOW_MS, true);
    return !far;
  }

  /** The held key was let go (`null`: any): slow to rest. */
  release(code: string | null): void {
    if (!this.held || (code !== null && code !== this.held.code)) return;
    const t = this.frames.now();
    this.letGo();
    if (this.segment.kind !== "cruise") return;
    const now = this.now(t);
    const max = this.surface.max();
    this.segment = { kind: "curve", t0: t, d: STOP_MS, p0: now.p, v0: now.v, p1: clamp(now.p + (now.v * STOP_MS) / 2, 0, max), end: false };
    this.run();
  }

  /** Be where it is going, now. */
  finish(): void {
    if (this.segment.kind === "still") return;
    const to = this.destination();
    this.letGo();
    this.jumpNow(to);
  }

  /** Stop where it is. */
  stop(): void {
    this.letGo();
    this.segment = { kind: "still" };
    this.keep = null;
    if (this.frame !== 0) this.frames.cancel(this.frame);
    this.frame = 0;
  }

  private letGo(): void {
    this.held = null;
    holding.delete(this);
  }

  /** Where it is at t: on its way, or, at rest, where it is. */
  private now(t: number): { p: number; v: number } {
    const read = this.surface.read();
    if (this.segment.kind === "still" || this.put === null) {
      this.put = read;
      return { p: read, v: 0 };
    }
    this.shifted(read);
    const { p, v } = at(this.segment, t, this.surface.max(), read);
    return { p, v };
  }

  /**
   * Moved from where it was put by something other than the person (content
   * above it changing size, the browser keeping what shows in place): the
   * motion moves with it, and goes on.
   */
  private shifted(read: number): void {
    const segment = this.segment;
    if (this.put === null || Math.abs(read - this.put) <= MOVED_PX || segment.kind === "still") return;
    const by = read - this.put;
    segment.p0 += by;
    if (segment.kind === "curve") segment.p1 += by;
    if (this.keep) this.keep = { low: this.keep.low + by, high: this.keep.high + by };
    this.put = read;
  }

  private curve(t: number, now: { p: number; v: number }, to: number, d: number, keepSpeed: boolean, end = false): void {
    const distance = to - now.p;
    // Kept speed in the same direction, and no more than lands without going past.
    let v0 = keepSpeed && Math.sign(now.v) === Math.sign(distance) ? now.v : 0;
    const most = (3 * Math.abs(distance)) / d;
    if (Math.abs(v0) > most) v0 = Math.sign(v0) * most;
    if (Math.abs(distance) < 0.5 && !end) {
      this.jumpNow(to);
      return;
    }
    this.segment = { kind: "curve", t0: t, d, p0: now.p, v0, p1: to, end };
    this.run();
  }

  private jumpNow(to: number): void {
    this.segment = { kind: "still" };
    this.keep = null;
    if (this.frame !== 0) this.frames.cancel(this.frame);
    this.frame = 0;
    this.surface.write(to);
    this.put = this.surface.read();
  }

  private run(): void {
    if (this.frame === 0) this.frame = this.frames.request(this.draw);
  }

  private draw = (): void => {
    this.frame = 0;
    const t = this.frames.now();
    const segment = this.segment;
    if (segment.kind === "still") return;
    this.shifted(this.surface.read());
    const read = this.surface.read();
    if (this.held && t - this.held.last > HOLD_LAPSE_MS) {
      // Its release was missed: let go of it as if it had come.
      this.release(this.held.code);
      return;
    }
    const max = this.surface.max();
    const state = at(segment, t, max, read);
    let p = clamp(state.p, 0, max);
    if (this.keep) p = clamp(p, Math.min(this.keep.low, this.keep.high), this.keep.high);
    this.surface.write(p);
    this.put = this.surface.read();
    if (state.done) {
      // Gone to the bottom while the bottom moves on (text arriving): a frame that finds it
      // short of the bottom puts it there again, until one finds it there, or for a while.
      if (segment.kind === "curve" && segment.end && max - read > AT_BOTTOM_PX && t - (segment.t0 + segment.d) < END_CHASE_MS) {
        this.run();
        return;
      }
      this.segment = { kind: "still" };
      this.keep = null;
      return;
    }
    // Held against an end, it waits there for the key to be let go.
    this.run();
  };
}

/** The browser's frames, and the person's motion setting. */
export const browserFrames: Frames = {
  now: () => performance.now(),
  request: (run) => requestAnimationFrame(() => run()),
  cancel: (id) => cancelAnimationFrame(id),
  reduced: () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
};

/** An element as a surface. `before` is told of each move first. */
export function elementSurface(element: HTMLElement, before?: (delta: number) => void): Surface {
  return {
    read: () => element.scrollTop,
    write: (top) => {
      before?.(top - element.scrollTop);
      element.scrollTop = top;
    },
    max: () => Math.max(0, element.scrollHeight - element.clientHeight),
    height: () => element.clientHeight,
  };
}

const scrollers = new WeakMap<HTMLElement, Scroller>();
const live = new Set<WeakRef<HTMLElement>>();

/** The one scroller for an element, made the first time it is asked for. */
export function scrollerOf(element: HTMLElement, before?: (delta: number) => void): Scroller {
  let scroller = scrollers.get(element);
  if (!scroller) {
    const made = new Scroller(elementSurface(element, before), browserFrames);
    scroller = made;
    scrollers.set(element, made);
    live.add(new WeakRef(element));
    // The person's own wheel, touch or press on it wins: what a key started stops where it is.
    const interrupt = (event: Event) => {
      if (event.isTrusted) made.stop();
    };
    for (const type of ["wheel", "touchstart", "pointerdown"]) element.addEventListener(type, interrupt, { passive: true });
  }
  return scroller;
}

/** Where an element's scrolling will come to rest: what to read instead of scrollTop right after a key. */
export function restingTop(element: HTMLElement): number {
  return scrollers.get(element)?.destination() ?? element.scrollTop;
}

/** Bring every scrolling element to where it is going, now: before anything measures what is on screen. */
export function settleAll(): void {
  for (const ref of [...live]) {
    const element = ref.deref();
    if (!element) {
      live.delete(ref);
      continue;
    }
    scrollers.get(element)?.finish();
  }
}

/** The nearest element above `element` that scrolls up and down, or null. */
export function scrollParent(element: Element): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (at.scrollHeight <= at.clientHeight + 1) continue;
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

/** Bring an element into view the least way, eased: the cursor following. Instead of scrollIntoView({ block: "nearest" }). */
export function followInto(element: Element | null | undefined): void {
  if (!element) return;
  const parent = scrollParent(element);
  if (!parent) return;
  const box = element.getBoundingClientRect();
  const frame = parent.getBoundingClientRect();
  const top = box.top - frame.top - parent.clientTop + parent.scrollTop;
  scrollerOf(parent).follow(top, top + box.height);
}

/** Scroll an element by key: a step down or up of `size` pixels. */
export function stepScroll(element: HTMLElement | null | undefined, dir: 1 | -1, size: number): void {
  if (element) scrollerOf(element).step(dir, size);
}

/** Scroll an element to a place, or its top or bottom, over a short fixed time. */
export function jumpScroll(element: HTMLElement | null | undefined, to: number | "top" | "end"): void {
  if (element) scrollerOf(element).jump(to === "top" ? 0 : to);
}

/**
 * The keys a card or sheet that only scrolls takes: j k and the arrows a
 * step, g and G its ends, Space most of what shows. True when the key scrolled.
 */
export function scrollKey(element: HTMLElement | null | undefined, key: string): boolean {
  if (!element) return false;
  if (key === "j" || key === "ArrowDown") stepScroll(element, 1, CARD_STEP_PX);
  else if (key === "k" || key === "ArrowUp") stepScroll(element, -1, CARD_STEP_PX);
  else if (key === "G") jumpScroll(element, "end");
  else if (key === "g") jumpScroll(element, "top");
  else if (key === " ") jumpScroll(element, restingTop(element) + element.clientHeight * 0.8);
  else return false;
  return true;
}

/** How far j or k goes in a card or sheet. */
export const CARD_STEP_PX = 60;
