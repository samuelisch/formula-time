import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it } from "vitest";

import { focusableElements, trapTabKey } from "./focusTrap.ts";

function buildDialog(bodyHtml: string): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = bodyHtml;
  document.body.appendChild(container);
  return container;
}

function keyEvent(key: string, shiftKey = false) {
  let prevented = false;
  return {
    key,
    shiftKey,
    preventDefault: () => {
      prevented = true;
    },
    wasPrevented: () => prevented,
  } as unknown as ReactKeyboardEvent & { wasPrevented: () => boolean };
}

describe("focusableElements", () => {
  it("lists focusable descendants in DOM order", () => {
    const container = buildDialog(`
      <button id="a">a</button>
      <span>not focusable</span>
      <button id="b">b</button>
    `);

    expect(focusableElements(container).map((el) => el.id)).toEqual(["a", "b"]);
  });

  it("excludes an element inside a hidden ancestor", () => {
    const container = buildDialog(`
      <button id="a">a</button>
      <div hidden><button id="b">b</button></div>
    `);

    expect(focusableElements(container).map((el) => el.id)).toEqual(["a"]);
  });
});

describe("trapTabKey", () => {
  it("wraps Tab from the last focusable element back to the first", () => {
    const container = buildDialog(`<button id="a">a</button><button id="b">b</button>`);
    const last = container.querySelector<HTMLButtonElement>("#b")!;
    last.focus();

    const event = keyEvent("Tab");
    trapTabKey(container, event);

    expect(event.wasPrevented()).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("wraps Shift+Tab from the first focusable element back to the last", () => {
    const container = buildDialog(`<button id="a">a</button><button id="b">b</button>`);
    const first = container.querySelector<HTMLButtonElement>("#a")!;
    first.focus();

    const event = keyEvent("Tab", true);
    trapTabKey(container, event);

    expect(event.wasPrevented()).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("does nothing on Tab from a middle element", () => {
    const container = buildDialog(`<button id="a">a</button><button id="b">b</button><button id="c">c</button>`);
    const middle = container.querySelector<HTMLButtonElement>("#b")!;
    middle.focus();

    const event = keyEvent("Tab");
    trapTabKey(container, event);

    expect(event.wasPrevented()).toBe(false);
    expect(document.activeElement?.id).toBe("b");
  });

  it("ignores a non-Tab key", () => {
    const container = buildDialog(`<button id="a">a</button>`);
    const event = keyEvent("Escape");
    trapTabKey(container, event);
    expect(event.wasPrevented()).toBe(false);
  });
});
