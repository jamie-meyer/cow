import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_MS, HOLD_SPEED, JUMP_MS, STEP_MS, STOP_MS, Scroller, type Frames, type Surface, keyReleased, whilePressing } from "../src/scroll.ts";

/** A page of `size` pixels showing `height` of them, and a clock that moves only when told. */
function world({ size = 100_000, height = 500, start = 10_000, hz = 60, reduced = false } = {}) {
  let top = start;
  let now = 0;
  let queue: { id: number; run: () => void }[] = [];
  let next = 1;
  const writes: number[] = [];
  const surface: Surface = {
    read: () => top,
    write: (to) => {
      top = to;
      writes.push(to);
    },
    max: () => size - height,
    height: () => height,
  };
  const frames: Frames = {
    now: () => now,
    request: (run) => {
      queue.push({ id: next, run });
      return next++;
    },
    cancel: (id) => {
      queue = queue.filter((entry) => entry.id !== id);
    },
    reduced: () => reduced,
  };
  const scroller = new Scroller(surface, frames);
  const frameMs = 1000 / hz;
  /** Let `ms` pass, drawing the frames that fall in it; returns where each frame put the page. */
  let frameAt = frameMs;
  const pass = (ms: number): number[] => {
    const seen: number[] = [];
    const end = now + ms;
    // Frames fall on the display's own beat, wherever keys fall between them.
    while (frameAt <= end + 1e-9) {
      now = frameAt;
      frameAt += frameMs;
      const due = queue;
      queue = [];
      for (const entry of due) entry.run();
      seen.push(top);
    }
    now = end;
    return seen;
  };
  return { scroller, pass, top: () => top, writes, moving: () => scroller.moving };
}

const press = (code: string, repeat: boolean, run: () => void) => whilePressing({ code, repeat }, run);

/** Hold a key for `ms`, its repeats every `every` ms after a first delay, then let it go. */
function hold(w: ReturnType<typeof world>, dir: 1 | -1, ms: number, { delay = 300, every = 33, code = dir > 0 ? "KeyJ" : "KeyK" } = {}) {
  const tops: number[] = [];
  press(code, false, () => w.scroller.step(dir, 60));
  let held = 0;
  tops.push(...w.pass(delay));
  held += delay;
  while (held < ms) {
    press(code, true, () => w.scroller.step(dir, 60));
    tops.push(...w.pass(every));
    held += every;
  }
  keyReleased(code);
  return tops;
}

test("one step lands exactly on its target, over several frames", () => {
  const w = world();
  press("KeyJ", false, () => w.scroller.step(1, 60));
  const tops = w.pass(STEP_MS + 50);
  assert.equal(w.top(), 10_060);
  assert.equal(w.moving(), false);
  const moving = tops.filter((top, i) => top !== (i === 0 ? 10_000 : tops[i - 1]));
  assert.ok(moving.length >= 6, `moved on ${moving.length} frames`);
  // Never past the target, and never back.
  for (let i = 1; i < tops.length; i += 1) assert.ok(tops[i]! >= tops[i - 1]! && tops[i]! <= 10_060);
  // Up lands as exactly.
  press("KeyK", false, () => w.scroller.step(-1, 60));
  w.pass(STEP_MS + 50);
  assert.equal(w.top(), 10_000);
});

test("presses in quick succession add up, and each lands on a step", () => {
  const w = world();
  for (let i = 0; i < 3; i += 1) {
    press("KeyJ", false, () => w.scroller.step(1, 60));
    w.pass(40);
  }
  w.pass(STEP_MS + 50);
  assert.equal(w.top(), 10_180);
});

test("a held key moves at the held speed, however fast it repeats, and comes to rest within a short distance", () => {
  for (const every of [16, 33, 83]) {
    const w = world();
    const tops = hold(w, 1, 2000, { every });
    const released = w.top();
    w.pass(STOP_MS + 50);
    const after = w.top() - released;
    // Half of what the stop's time at full speed would cover, and the frame's worth it moved since it was last drawn.
    assert.ok(after >= 0 && after <= (HOLD_SPEED * (STOP_MS / 2 + 1000 / 60)) / 1000 + 0.5, `${after} px after release`);
    // Over a second of steady holding, the speed is the stated one.
    const frames = 60;
    const steady = tops.slice(-frames - 1);
    const speed = (steady.at(-1)! - steady[0]!) / (frames / 60);
    assert.ok(Math.abs(speed - HOLD_SPEED) < 15, `${speed} px/s with repeats every ${every} ms`);
    // Steady: no frame moves much more or less than another.
    const moves = steady.slice(1).map((top, i) => top - steady[i]!);
    assert.ok(Math.max(...moves) - Math.min(...moves) < 1, moves.join(","));
  }
});

test("repeats do not pile up: when they stop, it stops", () => {
  const w = world();
  hold(w, 1, 1000);
  const released = w.top();
  w.pass(1000);
  assert.ok(w.top() - released <= (HOLD_SPEED * (STOP_MS / 2 + 1000 / 60)) / 1000 + 0.5);
  assert.equal(w.moving(), false);
});

test("a held key whose release never comes stops soon after its repeats do", () => {
  const w = world();
  press("KeyJ", false, () => w.scroller.step(1, 60));
  w.pass(300);
  for (let i = 0; i < 10; i += 1) {
    press("KeyJ", true, () => w.scroller.step(1, 60));
    w.pass(33);
  }
  const last = w.top();
  w.pass(2000);
  assert.ok(w.top() - last < HOLD_SPEED * 0.5, String(w.top() - last));
  assert.equal(w.moving(), false);
});

test("the opposite key turns round at once", () => {
  const w = world();
  press("KeyJ", false, () => w.scroller.step(1, 60));
  w.pass(300);
  for (let i = 0; i < 10; i += 1) {
    press("KeyJ", true, () => w.scroller.step(1, 60));
    w.pass(33);
  }
  const drawn = w.top();
  press("KeyK", false, () => w.scroller.step(-1, 60));
  const turned = w.scroller.destination() + 60;
  // Where it had got to when k came, a moment after the last frame, it goes back from there.
  assert.ok(turned >= drawn && turned - drawn <= HOLD_SPEED / 60 + 0.5);
  const [first, second, third] = w.pass(50);
  assert.ok(first! <= turned && second! < first! && third! < second!, `${turned} → ${first} → ${second} → ${third}`);
  w.pass(STEP_MS);
  assert.equal(w.top(), turned - 60);
  // And the first key's release, late, changes nothing.
  keyReleased("KeyJ");
  w.pass(100);
  assert.equal(w.top(), turned - 60);
});

test("the same at two frame rates", () => {
  const run = (hz: number) => {
    const w = world({ hz });
    const drawn = new Map<number, number>();
    let clock = 0;
    const note = (tops: number[], ms: number) => {
      // Frames fall every 1000/hz ms from the start: name each by its time.
      const first = Math.ceil((clock + 1e-9) / (1000 / hz));
      tops.forEach((top, i) => drawn.set(Math.round(((first + i) * 1000) / hz), top));
      clock += ms;
    };
    press("KeyJ", false, () => w.scroller.step(1, 60));
    note(w.pass(100), 100);
    press("KeyJ", false, () => w.scroller.step(1, 60));
    note(w.pass(300), 300);
    for (let i = 0; i < 25; i += 1) {
      press("KeyJ", true, () => w.scroller.step(1, 60));
      note(w.pass(33), 33);
    }
    keyReleased("KeyJ");
    note(w.pass(200), 200);
    w.scroller.jump(20_000);
    note(w.pass(300), 300);
    return drawn;
  };
  const sixty = run(60);
  const hundredTwenty = run(120);
  let compared = 0;
  for (const [time, top] of sixty) {
    const other = hundredTwenty.get(time);
    if (other === undefined) continue;
    compared += 1;
    assert.ok(Math.abs(top - other) < 0.01, `at ${time} ms: ${top} at 60 fps, ${other} at 120`);
  }
  assert.ok(compared > 50, String(compared));
});

test("a jump takes the same short time however far it goes", () => {
  for (const to of [10_300, 60_000, 0]) {
    const w = world();
    w.scroller.jump(to);
    w.pass(JUMP_MS - 20);
    assert.notEqual(w.top(), to);
    w.pass(40);
    assert.equal(w.top(), to);
  }
  const w = world();
  w.scroller.jump("end");
  w.pass(JUMP_MS + 20);
  assert.equal(w.top(), 100_000 - 500);
});

test("with reduce motion every motion is a jump", () => {
  const w = world({ reduced: true });
  press("KeyJ", false, () => w.scroller.step(1, 60));
  assert.equal(w.top(), 10_060);
  press("KeyJ", true, () => w.scroller.step(1, 60));
  assert.equal(w.top(), 10_120);
  w.scroller.jump(0);
  assert.equal(w.top(), 0);
  w.scroller.follow(2_000, 2_017);
  assert.equal(w.top(), 2_017 - 500);
  assert.equal(w.pass(100).length > 0 && w.writes.length, 4);
});

test("the view follows a cursor line held moving: always in view, steadily, never further behind", () => {
  for (const every of [33, 50, 83]) {
    const w = world({ start: 0 });
    const row = 17;
    let line = 20;
    const follow = (repeat: boolean) => press("KeyJ", repeat, () => w.scroller.follow(line * row, line * row + row));
    follow(false);
    const tops = w.pass(300);
    const lags: number[] = [];
    for (let held = 0; held < 2000; held += every) {
      line += 1;
      follow(true);
      for (const top of w.pass(every)) {
        tops.push(top);
        // The cursor line is in view on every frame.
        assert.ok(line * row >= top - 0.5 && line * row + row <= top + 500 + 0.5, `line ${line} at ${top}`);
        lags.push(line * row + row - (top + 500));
      }
    }
    // It does not fall further behind as the key stays down.
    const early = Math.max(...lags.slice(30, 60));
    const late = Math.max(...lags.slice(-30));
    assert.ok(late <= early + row / 2, `${early} then ${late}`);
    // Many small moves, no big one.
    const moves = tops.slice(1).map((top, i) => top - tops[i]!);
    assert.ok(Math.max(...moves) < row, `largest move ${Math.max(...moves)}`);
  }
});

test("a single cursor move into view eases to the nearest place, exactly", () => {
  const w = world({ start: 0 });
  w.scroller.follow(500, 517);
  w.pass(FOLLOW_MS + 20);
  assert.equal(w.top(), 17);
  // Already in view: nothing moves.
  w.scroller.follow(100, 117);
  w.pass(50);
  assert.equal(w.top(), 17);
  // Far: a jump's time.
  w.scroller.follow(9_000, 9_017);
  w.pass(JUMP_MS + 20);
  assert.equal(w.top(), 9_017 - 500);
});

test("content shifting under it moves the motion with it, which still lands a step from where it started", () => {
  const w = world();
  press("KeyJ", false, () => w.scroller.step(1, 60));
  w.pass(50);
  // Something above grew by 17 pixels, and the browser kept what shows in place.
  const surface = (w.scroller as unknown as { surface: Surface }).surface;
  surface.write(surface.read() + 17);
  w.pass(STEP_MS);
  assert.equal(w.top(), 10_077);
  assert.equal(w.moving(), false);
});

test("stopped, it stays where it is", () => {
  const w = world();
  w.scroller.jump(20_000);
  w.pass(50);
  w.scroller.stop();
  const at = w.top();
  w.pass(300);
  assert.equal(w.top(), at);
  assert.equal(w.moving(), false);
});

test("from rest after something else moved it, a step goes from there", () => {
  const w = world();
  press("KeyJ", false, () => w.scroller.step(1, 60));
  w.pass(STEP_MS + 20);
  const surface = (w.scroller as unknown as { surface: Surface }).surface;
  surface.write(5_000);
  w.scroller.jump(4_000);
  w.pass(JUMP_MS + 20);
  assert.equal(w.top(), 4_000);
});
