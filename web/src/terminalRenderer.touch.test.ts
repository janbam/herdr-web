/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhosttyRenderer } from "./terminalRenderer";

/** Observable Ghostty boundaries; real renderer touch handlers own every tested gesture. */
const ghostty = vi.hoisted(() => ({
  hasMouseTracking: vi.fn(() => false),
  write: vi.fn(),
  select: vi.fn(),
  clearSelection: vi.fn(),
}));

vi.mock("ghostty-web", () => ({
  init: vi.fn(),
  /** Minimal synchronous terminal surface needed to mount the real gesture adapter. */
  Terminal: class {
    cols = 80;
    rows = 24;
    viewportY = 0;
    options = {};
    renderer = {
      getMetrics: () => ({ width: 10, height: 10 }),
      getCanvas: () => this.canvas,
      measureFont: () => ({ width: 10, height: 10, baseline: 8 }),
      remeasureFont: vi.fn(),
    };
    canvas = document.createElement("canvas");
    buffer = {
      active: {
        getLine: () => ({
          length: 80,
          getCell: () => ({ getCodepoint: () => 88, getWidth: () => 1, getHyperlinkId: () => 0 }),
        }),
      },
    };
    hasMouseTracking = ghostty.hasMouseTracking;
    write = ghostty.write;
    select = ghostty.select;
    clearSelection = ghostty.clearSelection;
    getScrollbackLength = () => 0;
    getViewportY = () => 0;
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
    dispose = vi.fn();
    /** Give dispatched touch events the same canvas-to-host path as the browser. */
    open(container: HTMLElement) {
      container.append(this.canvas);
    }
  },
  /** Keep fitting inert so these tests measure gesture policy rather than layout emulation. */
  FitAddon: class {
    fit = vi.fn();
    dispose = vi.fn();
  },
}));

/** Mount state is owned and disposed by each test, including pending long-press timers. */
let renderer: GhosttyRenderer;
/** Host touch-action represents the stylesheet's explicit native-pan opt-in. */
let host: HTMLDivElement;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ghostty.hasMouseTracking.mockReturnValue(false);
  vi.stubGlobal("matchMedia", () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement("div");
  host.style.touchAction = "pan-y";
  document.body.append(host);
  renderer = new GhosttyRenderer(14, false);
  await renderer.mount(host);
});

afterEach(() => {
  renderer.dispose();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("terminal and browser touch arbitration", () => {
  it("forwards physical finger travel while leaving browser panning uncancelled for the whole swipe", () => {
    const scroll = vi.fn();
    renderer.onScroll(scroll);
    renderer.setMobileTouchSelection("copy", vi.fn(), 1500);
    const start = dispatchTouch("touchstart", 100, 220);

    // Toolbar movement reverses client-space travel; CSS changes cannot reclassify an active gesture.
    host.style.touchAction = "none";
    const move = dispatchTouch("touchmove", 110, 180);
    dispatchTouch("touchend", 110, 180);

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(scroll.mock.calls).toEqual([[4]]);
    vi.advanceTimersByTime(700);
    expect(ghostty.select).not.toHaveBeenCalled();
  });

  it("retains client-space scrolling and default cancellation outside the stylesheet opt-in", () => {
    host.style.touchAction = "none";
    const scroll = vi.fn();
    renderer.onScroll(scroll);
    renderer.setMobileTouchSelection("copy", vi.fn(), 1500);
    const start = dispatchTouch("touchstart", 100, 220);
    const move = dispatchTouch("touchmove", 90, 120);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(scroll.mock.calls).toEqual([[1]]);
  });

  it.each(["off", "copy"] as const)("preserves tap focus after a tiny shared-pan wobble with long-press %s", (behavior) => {
    const focus = vi.fn(() => true);
    const scroll = vi.fn();
    renderer.setTapFocusHandler(focus);
    renderer.setMobileTouchSelection(behavior, vi.fn(), 1500);
    renderer.onScroll(scroll);
    dispatchTouch("touchstart", 100, 220);
    dispatchTouch("touchmove", 99, 219);
    dispatchTouch("touchend", 99, 219);

    expect(focus).toHaveBeenCalledOnce();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("lets a held selection claim client-space dragging without scrolling the terminal or browser", () => {
    const scroll = vi.fn();
    const selection = vi.fn();
    renderer.onScroll(scroll);
    renderer.setMobileTouchSelection("copy", selection, 1500);
    dispatchTouch("touchstart", 20, 220);

    // A stationary hold wins ownership before its first drag movement reaches the browser.
    vi.advanceTimersByTime(600);
    const move = dispatchTouch("touchmove", 60, 180);
    const end = dispatchTouch("touchend", 60, 180);

    expect(move.defaultPrevented).toBe(true);
    expect(end.defaultPrevented).toBe(true);
    expect(scroll).not.toHaveBeenCalled();
    expect(selection).toHaveBeenCalledOnce();
    expect(selection.mock.calls[0][0]).toEqual({ type: "selection", text: expect.stringContaining("\n") });
    expect(ghostty.select).toHaveBeenLastCalledWith(2, 2, 321);
  });

  it("cancels long-press intent when toolbar movement masks physical scrolling in client space", () => {
    const scroll = vi.fn();
    renderer.onScroll(scroll);
    renderer.setMobileTouchSelection("copy", vi.fn(), 1500);
    dispatchTouch("touchstart", 100, 220);
    dispatchTouch("touchmove", 100, 200);
    vi.advanceTimersByTime(600);

    expect(scroll.mock.calls).toEqual([[2]]);
    expect(ghostty.select).not.toHaveBeenCalled();
  });

  it("publishes parsed mouse-tracking mode before the next touch and restores ordinary mode", () => {
    expect(host.dataset.mouseTracking).toBe("false");
    ghostty.hasMouseTracking.mockReturnValue(true);
    renderer.write("\x1b[?1000h");
    expect(ghostty.write).toHaveBeenCalledWith("\x1b[?1000h");
    expect(host.dataset.mouseTracking).toBe("true");

    const scroll = vi.fn();
    renderer.onScroll(scroll);
    dispatchTouch("touchstart", 100, 220);
    dispatchTouch("touchmove", 60, 180);
    expect(scroll).not.toHaveBeenCalled();

    ghostty.hasMouseTracking.mockReturnValue(false);
    renderer.write("\x1b[?1000l");
    expect(host.dataset.mouseTracking).toBe("false");
  });

  it("removes touch ownership and pending selection work when the renderer is disposed", () => {
    const scroll = vi.fn();
    renderer.onScroll(scroll);
    renderer.setMobileTouchSelection("copy", vi.fn(), 1500);
    dispatchTouch("touchstart", 20, 220);
    renderer.dispose();
    vi.advanceTimersByTime(700);
    dispatchTouch("touchmove", 60, 180);

    expect(host.dataset.mouseTracking).toBeUndefined();
    expect(ghostty.select).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });
});

/** Dispatch independent viewport and screen coordinates through the real DOM gesture path. */
function dispatchTouch(type: string, clientY: number, screenY: number) {
  const touch = { identifier: 0, clientX: 20, clientY, screenX: 20, screenY } as Touch;
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" ? [] : [touch],
    changedTouches: [touch],
  });
  host.querySelector("canvas")?.dispatchEvent(event);
  return event;
}
