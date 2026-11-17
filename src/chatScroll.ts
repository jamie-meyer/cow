// Scrolling the chat in the pane from the overview, so it can be read
// without the mouse and without giving it the keyboard.
//
// The chat is bb's, and so is its scrolling. What bb does, established
// against bb 0.49, and what cow does about it:
// - bb keeps the chat pinned to its newest message until a scroll takes it
//   more than a few pixels away, and it takes a scroll to be the person's
//   only for a moment after a wheel, touch, pointer or scroll-key event on
//   the chat. Any other change of position it treats as the page shifting,
//   and puts back. So cow says "wheel" to the chat before it scrolls it.
// - While text arrives, the chat grows many times a second and bb pins it
//   again each time. Scrolling up in steps smaller than bb's few pixels per
//   growth never gets away: on a trackpad, scrolling up does nothing until
//   the text stops. This is the same in bb's own thread view. So when the
//   person scrolls up and the chat has not moved, cow moves it far enough
//   in one step to leave the pin, and tells the chat it scrolled, so that
//   bb lets go before the next growth; bb then holds the place it was put.

/**
 * The element that scrolls the chat's messages: of everything inside the
 * pane that can scroll up and down, the tallest. The composer's own field
 * and a diff opened inside a message can scroll too, and are smaller.
 * Nothing of bb's is named; only what the browser says scrolls.
 */
export function chatScroller(chat: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const element of chat.querySelectorAll<HTMLElement>("*")) {
    if (element.scrollHeight <= element.clientHeight + 1 || element.clientHeight === 0) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (best === null || element.clientHeight > best.clientHeight) best = element;
  }
  return best;
}

/** How far one press of `;` or `'` goes: about three lines. */
export const CHAT_STEP_PX = 66;
/** Nearer its end than this, the chat is at its newest message. */
export const AT_END_PX = 8;
/** The least a step away from the newest message moves: more than bb's pin lets go at. */
export const LEAVE_PX = 40;

export const bottomOf = (element: HTMLElement): number => element.scrollHeight - element.clientHeight;
export const atEnd = (element: HTMLElement): boolean => bottomOf(element) - element.scrollTop <= AT_END_PX;

/**
 * Where a step of `delta` pixels lands from `top`, when the end is at
 * `max`: clamped to the chat, and from the very end never less than
 * `LEAVE_PX` up, so the step is not taken back.
 */
export function stepTarget(top: number, delta: number, max: number): number {
  const leaving = delta < 0 && max - top <= AT_END_PX;
  const to = top + (leaving ? Math.min(delta, -LEAVE_PX) : delta);
  return Math.max(0, Math.min(max, to));
}

/** Tell the chat a scroll is the person's: the wheel event a mouse would have sent, which moves nothing itself. */
function announce(element: HTMLElement, deltaY: number): void {
  element.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: false }));
}

/**
 * Move the chat off its newest message in one step, and have bb take note
 * at once: while text arrives bb pins the chat again on every growth, and
 * it lets go only when it has seen the scroll, which the browser would
 * report a frame later.
 */
function leaveEnd(element: HTMLElement, top: number): void {
  announce(element, -1);
  element.scrollTop = top;
  element.dispatchEvent(new Event("scroll"));
}

/**
 * Scrolls one element toward a target that each press moves, a part of the
 * way on every frame: one press glides, and a held key keeps gliding
 * instead of jumping.
 */
export class Glide {
  private element: HTMLElement | null = null;
  private target = 0;
  private frame = 0;
  private toEnd = false;

  /** Move the target by `delta` pixels; "end" goes to the newest message. */
  push(element: HTMLElement, delta: number | "end"): void {
    const max = bottomOf(element);
    if (this.element !== element || this.frame === 0) {
      this.element = element;
      this.target = element.scrollTop;
    }
    this.toEnd = delta === "end";
    if (delta === "end") this.target = max;
    else {
      const leaving = delta < 0 && atEnd(element);
      this.target = stepTarget(this.target, delta, max);
      if (leaving) {
        // Off the pin at once, in one step: gliding off it would be undone on the way.
        leaveEnd(element, Math.max(0, Math.min(element.scrollTop, max - LEAVE_PX)));
      }
    }
    if (this.frame === 0) this.frame = requestAnimationFrame(this.step);
  }

  stop(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.element = null;
  }

  private step = (): void => {
    const element = this.element;
    this.frame = 0;
    if (!element || !element.isConnected) return;
    // The newest message moves further off while text arrives.
    if (this.toEnd) this.target = bottomOf(element);
    const left = this.target - element.scrollTop;
    if (Math.abs(left) < 1.5) {
      announce(element, left);
      element.scrollTop = this.target;
      return;
    }
    const before = element.scrollTop;
    announce(element, left);
    element.scrollTop = before + left * 0.35 + Math.sign(left);
    // At an end, or held by something else: stop instead of pushing for ever.
    if (element.scrollTop === before) return;
    this.frame = requestAnimationFrame(this.step);
  };
}

/** How long upward wheel movement is added up before it is forgotten. */
const WHEEL_WINDOW_MS = 300;
/** This much upward movement with the chat still at its end means the pin is holding it. */
const HELD_PX = 12;
/** Nearer the end than this, with text arriving, the chat may be pinned again at any moment. */
const NEAR_END_PX = 80;

/**
 * Help a mouse or trackpad leave the newest message while text arrives.
 * When the person has scrolled up by more than a little and the chat is
 * still at its end, move it up that far in one step. Nothing is done when
 * the scroll worked by itself, and nothing ever scrolls it back down.
 */
export function attachWheelEscape(chatOf: () => HTMLElement | null): () => void {
  let up = 0;
  let last = 0;
  let frame = 0;
  const onWheel = (event: WheelEvent) => {
    if (!event.isTrusted) return;
    const chat = chatOf();
    if (!chat || !(event.target instanceof Node) || !chat.contains(event.target)) return;
    if (event.deltaY >= 0 || event.ctrlKey) {
      up = 0;
      return;
    }
    const now = performance.now();
    up = now - last > WHEEL_WINDOW_MS ? -event.deltaY : up - event.deltaY;
    last = now;
    if (frame !== 0 || up < HELD_PX) return;
    // After the browser has done its own scrolling for this event.
    frame = requestAnimationFrame(() => {
      frame = 0;
      const scroller = chatScroller(chat);
      if (!scroller || up < HELD_PX) return;
      // Fast text can add more than a few pixels between two frames: near the end counts as held at it.
      const max = bottomOf(scroller);
      const to = Math.max(0, max - Math.max(LEAVE_PX, up));
      if (max - scroller.scrollTop > NEAR_END_PX || to >= scroller.scrollTop) return;
      leaveEnd(scroller, to);
      up = 0;
    });
  };
  window.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => {
    window.removeEventListener("wheel", onWheel, { capture: true });
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}

/**
 * Whether new output has arrived below while the chat was scrolled away
 * from its newest message. `left` is the chat's height when the person
 * left the end, or null while they are at it.
 */
export function outputBelow(left: number | null, heightNow: number): boolean {
  return left !== null && heightNow > left + 4;
}
