/** @vitest-environment jsdom */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Ghostty, InputHandler } from "ghostty-web";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyDevicePixelRatio,
  devicePixelAlignedFontMetrics,
  handleTerminalCustomKeyEvent,
  installDevicePixelAlignedFontMetrics,
  installTerminalInteractionRendering,
  renderGhosttyTerminalFrame,
  refreshTerminalFontRendering,
  shouldUseEventDrivenTerminalRendering,
  suspendGhosttyIdleRenderLoop,
  watchDevicePixelRatio,
} from "./terminalRenderer";

describe("terminal event-driven rendering", () => {
  it("redraws idle selections and scrolling and removes the hooks on disposal", () => {
    const originalRequestRender = vi.fn();
    const selectionManager = {
      requestRender: originalRequestRender,
      getSelectionCoords: vi.fn(),
      getDirtySelectionRows: vi.fn(),
    };
    let onScroll: (() => void) | undefined;
    const dispose = vi.fn();
    const terminal = {
      selectionManager,
      onScroll: (callback: () => void) => {
        onScroll = callback;
        return { dispose };
      },
    } as never;
    const redraw = vi.fn();
    const cleanup = installTerminalInteractionRendering(terminal, redraw);
    selectionManager.requestRender();
    onScroll?.();
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(originalRequestRender).not.toHaveBeenCalled();
    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
    expect(selectionManager.requestRender).toBe(originalRequestRender);
  });

  it("only enables the idle-loop workaround for a non-blinking Windows terminal", () => {
    expect(shouldUseEventDrivenTerminalRendering(false, "Win32")).toBe(true);
    expect(shouldUseEventDrivenTerminalRendering(true, "Win32")).toBe(false);
    expect(shouldUseEventDrivenTerminalRendering(false, "MacIntel")).toBe(false);
    expect(shouldUseEventDrivenTerminalRendering(false, "Linux armv8l")).toBe(false);
  });

  it("cancels ghostty-web's pending idle frame", () => {
    const cancelFrame = vi.fn();
    const terminal = { animationFrameId: 42 } as never;

    expect(suspendGhosttyIdleRenderLoop(terminal, cancelFrame)).toBe(true);
    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(terminal).not.toHaveProperty("animationFrameId");
    expect(suspendGhosttyIdleRenderLoop(terminal, cancelFrame)).toBe(false);
  });

  it("renders the current viewport with ghostty's scrollbar state", () => {
    const renderer = { render: vi.fn() };
    const wasmTerm = {};
    const terminal = {
      renderer,
      wasmTerm,
      viewportY: 8,
      scrollbarOpacity: 0.4,
    } as never;

    expect(renderGhosttyTerminalFrame(terminal)).toBe(true);
    expect(renderer.render).toHaveBeenCalledWith(wasmTerm, false, 8, terminal, 0.4);
  });
});

describe("terminal renderer font refresh", () => {
  it("forces the current viewport to redraw when font settings are unchanged", () => {
    const calls: string[] = [];
    const wasmTerm = {};
    const renderer = {
      remeasureFont: vi.fn(() => calls.push("remeasure")),
      render: vi.fn(() => calls.push("render")),
    };
    const terminal = {
      options: {
        fontFamily: "same font",
        fontSize: 14,
      },
      renderer,
      viewportY: 7,
      wasmTerm,
    } as unknown as Parameters<typeof refreshTerminalFontRendering>[0];
    const fit = vi.fn(() => {
      calls.push("fit");
      return { cols: 120, rows: 40 };
    });

    expect(refreshTerminalFontRendering(terminal, "same font", 14, fit)).toEqual({
      cols: 120,
      rows: 40,
    });
    expect(terminal.options.fontFamily).toBe("same font");
    expect(terminal.options.fontSize).toBe(14);
    expect(renderer.render).toHaveBeenCalledWith(wasmTerm, true, 7, terminal, 0);
    expect(calls).toEqual(["remeasure", "fit", "render"]);
  });
});

describe("device-pixel-aligned terminal font metrics", () => {
  it("keeps stock ceiling behavior at a devicePixelRatio of 1", () => {
    expect(devicePixelAlignedFontMetrics({ width: 7.8, ascent: 10, descent: 3 }, 1)).toEqual({
      width: 8,
      height: 15,
      baseline: 11,
    });
  });

  it("lands cell edges on exact device pixels at fractional ratios", () => {
    // 7.8 CSS px * 1.25 = 9.75 device px -> 10, i.e. 8 CSS px tile exactly.
    const metrics = devicePixelAlignedFontMetrics({ width: 7.8, ascent: 10, descent: 3 }, 1.25);
    expect(metrics).toEqual({ width: 8, height: 15.2, baseline: 11.2 });
    for (const value of [metrics.width, metrics.height, metrics.baseline]) {
      expect(value * 1.25).toBeCloseTo(Math.round(value * 1.25), 10);
    }
  });

  it("falls back to a ratio of 1 for non-positive input", () => {
    expect(devicePixelAlignedFontMetrics({ width: 7.8, ascent: 10, descent: 3 }, 0)).toEqual(
      devicePixelAlignedFontMetrics({ width: 7.8, ascent: 10, descent: 3 }, 1),
    );
  });

  it("overrides measureFont, remeasures, and restores the original", () => {
    const stock = { width: 8, height: 15, baseline: 11 };
    const renderer = {
      devicePixelRatio: 1.5,
      measureFont: vi.fn(() => stock),
      remeasureFont: vi.fn(),
    };
    const measureRaw = vi.fn(() => ({ width: 7.8, ascent: 10, descent: 3 }));

    const restore = installDevicePixelAlignedFontMetrics(renderer, {
      fontFamily: "test mono",
      fontSizePx: 13,
      measureRaw,
    });

    expect(renderer.remeasureFont).toHaveBeenCalledOnce();
    // 7.8*1.5=11.7 -> 12/1.5 = 8; height (10+3+2)*1.5=22.5 -> 23/1.5.
    expect(renderer.measureFont()).toEqual({ width: 8, height: 23 / 1.5, baseline: 17 / 1.5 });
    expect(measureRaw).toHaveBeenCalledWith("test mono", 13);
    restore?.();
    expect(renderer.measureFont()).toBe(stock);
  });

  it("follows live renderer font fields after install", () => {
    const stock = { width: 8, height: 15, baseline: 11 };
    const renderer = {
      devicePixelRatio: 1,
      fontSize: 13,
      fontFamily: "old mono",
      measureFont: vi.fn(() => stock),
      remeasureFont: vi.fn(),
    };
    const measureRaw = vi.fn(() => ({ width: 7.8, ascent: 10, descent: 3 }));
    installDevicePixelAlignedFontMetrics(renderer, {
      fontFamily: "fallback mono",
      fontSizePx: 99,
      measureRaw,
    });

    renderer.fontSize = 16;
    renderer.measureFont();
    // Live renderer fields win over install-time options (stale setFontSize
    // reads were the regression: cells measured at the old size).
    expect(measureRaw).toHaveBeenLastCalledWith("old mono", 16);
  });

  it("syncs the renderer's cached ratio onto the live one", () => {
    const renderer = { devicePixelRatio: 1 };
    expect(applyDevicePixelRatio(renderer, 1.5)).toBe(1.5);
    expect(renderer.devicePixelRatio).toBe(1.5);
    expect(applyDevicePixelRatio(null, 2)).toBe(2);
  });

  it("keeps canvas size-check products exact at common ratios", () => {
    // Upstream compares integer canvas.width against cols*width*dpr with !==,
    // so the aligned metrics must multiply back to exact integers.
    for (const ratio of [1, 1.25, 1.5, 2]) {
      for (const raw of [7.2, 7.8, 9.6, 13.33]) {
        const metrics = devicePixelAlignedFontMetrics(
          { width: raw, ascent: 10, descent: 3 },
          ratio,
        );
        expect(metrics.width * ratio).toBe(Math.ceil(raw * ratio));
        expect(metrics.height * ratio).toBe(Math.ceil(15 * ratio));
      }
    }
  });

  it("uses stock metrics when raw measurement is unavailable", () => {
    const stock = { width: 8, height: 15, baseline: 11 };
    const renderer = {
      devicePixelRatio: 1.5,
      measureFont: vi.fn(() => stock),
      remeasureFont: vi.fn(),
    };
    installDevicePixelAlignedFontMetrics(renderer, {
      fontFamily: "test mono",
      fontSizePx: 13,
      measureRaw: () => null,
    });
    expect(renderer.measureFont()).toBe(stock);
  });

  it("skips renderers without the expected 0.4.0 shape", () => {
    expect(
      installDevicePixelAlignedFontMetrics(null, { fontFamily: "x", fontSizePx: 13 }),
    ).toBeNull();
    expect(
      installDevicePixelAlignedFontMetrics({} as never, { fontFamily: "x", fontSizePx: 13 }),
    ).toBeNull();
  });

  it("notifies and unsubscribes on devicePixelRatio changes", () => {
    let notify: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const observe = vi.fn((_ratio: number, onNotify: () => void) => {
      notify = onNotify;
      return unsubscribe;
    });
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(onChange, observe);

    expect(observe).toHaveBeenCalledOnce();
    notify?.();
    expect(onChange).toHaveBeenCalledOnce();
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("terminal selection copy shortcuts", () => {
  it("consumes Windows/Linux Ctrl+C when canonical terminal selection text exists", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "Win32")).toBe(true);
    expect(terminal.getSelection).toHaveBeenCalledOnce();
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("delegates Windows/Linux Ctrl+C to Ghostty for PTY ^C when selection is empty", () => {
    const terminal = terminalInput("");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "Linux x86_64")).toBe(false);
    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("\x03", true);
  });

  it("consumes macOS Cmd+C when canonical terminal selection text exists", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ metaKey: true }), terminal, "MacIntel")).toBe(true);
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("delegates macOS Ctrl+C to Ghostty for PTY interrupt even with a selection", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "MacIntel")).toBe(false);
    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("\x03", true);
  });
});

describe("codeless terminal special keys", () => {
  /** Real pinned encoder, shared across independent input handlers. */
  let ghostty: Ghostty;

  beforeAll(async () => {
    // Load the installed WASM directly so mode/modifier assertions use Ghostty's encoder.
    const wasm = await readFile(createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm"));
    const { instance } = await WebAssembly.instantiate(new Uint8Array(wasm), {
      env: { log: vi.fn() },
    });
    ghostty = new Ghostty(instance);
  });

  it.each([
    ["Enter", "\r"],
    ["Backspace", "\x7F"],
    ["Delete", "\x1B[3~"],
    ["ArrowUp", "\x1B[A"],
    ["ArrowDown", "\x1B[B"],
    ["ArrowRight", "\x1B[C"],
    ["ArrowLeft", "\x1B[D"],
    ["Home", "\x1B[H"],
    ["End", "\x1B[F"],
    ["PageUp", "\x1B[5~"],
    ["PageDown", "\x1B[6~"],
    ["Insert", "\x1B[2~"],
    ["Escape", "\x1B"],
    ["Tab", "\t"],
  ])("encodes codeless %s exactly once and cancels its default edit", (key, output) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    expect(encode(event)).toEqual([output]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("reads live application cursor mode for codeless arrows", () => {
    let applicationCursor = false;
    const host = document.createElement("div");
    const output = vi.fn();
    const handler = new InputHandler(
      ghostty, host, output, vi.fn(), undefined,
      (event) => handleTerminalCustomKeyEvent(event, terminalInput("")),
      () => applicationCursor,
    );
    try {
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
      applicationCursor = true;
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
      expect(output.mock.calls).toEqual([["\x1B[A"], ["\x1BOA"]]);
    } finally {
      handler.dispose();
    }
  });

  it.each([
    { key: "ArrowLeft", ctrlKey: true },
    { key: "ArrowDown", altKey: true },
    { key: "ArrowRight", shiftKey: true },
    { key: "Enter", altKey: true },
    { key: "Backspace", ctrlKey: true },
    { key: "Tab", shiftKey: true },
  ])("preserves Ghostty's code-bearing encoding for $key modifiers", (init) => {
    const expected = encode(new KeyboardEvent("keydown", { ...init, code: init.key }));
    expect(expected).toHaveLength(1);
    expect(encode(new KeyboardEvent("keydown", init))).toEqual(expected);
  });

  it.each([
    { key: "Enter", code: "NumpadEnter" },
    { key: "ArrowUp", code: "ArrowUp" },
    { key: "ArrowUp", location: 3 },
    { key: "Delete", location: 3 },
    { key: "Enter", location: 3 },
    { key: "x" },
    { key: "Dead" },
    { key: "Unidentified" },
    { key: "F1" },
    { key: "Enter", isComposing: true },
    { key: "Backspace", keyCode: 229 },
  ])("leaves unsupported, physical, numpad and composing events untouched: %j", (init) => {
    const event = new KeyboardEvent("keydown", init);
    expect(handleTerminalCustomKeyEvent(event, terminalInput(""))).toBe(false);
    expect(event.code).toBe(init.code ?? "");
    expect(Object.hasOwn(event, "code")).toBe(false);
  });

  /** Dispatch through Ghostty's real DOM listener and the production custom hook. */
  function encode(event: KeyboardEvent) {
    const host = document.createElement("div");
    const output = vi.fn();
    const terminal = { getSelection: () => "", input: output };
    const handler = new InputHandler(
      ghostty, host, output, vi.fn(), undefined,
      (key) => handleTerminalCustomKeyEvent(key, terminal),
    );
    try {
      host.dispatchEvent(event);
      return output.mock.calls.map(([data]) => data);
    } finally {
      handler.dispose();
    }
  }
});

function keyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    altKey: false,
    code: "KeyC",
    ctrlKey: false,
    isComposing: false,
    key: "c",
    keyCode: 67,
    metaKey: false,
    shiftKey: false,
    stopImmediatePropagation: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function terminalInput(selection: string) {
  return {
    getSelection: vi.fn(() => selection),
    input: vi.fn(),
  };
}

function dispatchCtrlC(
  event: KeyboardEvent,
  terminal: ReturnType<typeof terminalInput>,
  platform: string,
) {
  const handled = handleTerminalCustomKeyEvent(event, terminal, platform);
  if (!handled) {
    // This is Ghostty's existing default Ctrl+C encoding path.
    terminal.input("\x03", true);
  }
  return handled;
}
