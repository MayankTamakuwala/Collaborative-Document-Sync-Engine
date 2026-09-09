import { describe, expect, it } from "vitest";
import { diffText } from "../src/patch.js";

/** Applying the patch has to reproduce `after` exactly, whatever the inputs. */
function apply(before: string, patch: ReturnType<typeof diffText>): string {
  return before.slice(0, patch.at) + patch.added + before.slice(patch.at + patch.removed);
}

describe("diffText", () => {
  const cases: Array<[string, string, string]> = [
    ["typing at the end", "hello", "hello!"],
    ["typing in the middle", "hello world", "hello big world"],
    ["backspace", "hello", "hell"],
    ["delete forward", "hello", "ello"],
    ["replacing a selection", "the quick fox", "the slow fox"],
    ["pasting into an empty field", "", "a whole paragraph"],
    ["clearing everything", "some text", ""],
    ["no change", "same", "same"],
    ["repeated characters", "aaa", "aaaa"],
    ["newlines", "one\ntwo", "one\ntwo\nthree"],
  ];

  for (const [name, before, after] of cases) {
    it(name, () => {
      expect(apply(before, diffText(before, after))).toBe(after);
    });
  }

  it("finds the tightest span it can", () => {
    expect(diffText("hello world", "hello big world")).toEqual({
      at: 6,
      removed: 0,
      added: "big ",
    });
    expect(diffText("hello", "hello")).toEqual({ at: 5, removed: 0, added: "" });
  });

  it("survives random edits", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    let text = "starting point";
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(rand() * (text.length + 1));
      const removed = Math.floor(rand() * Math.min(6, text.length - at + 1));
      const added = "xy z".slice(0, Math.floor(rand() * 5));
      const next = text.slice(0, at) + added + text.slice(at + removed);

      expect(apply(text, diffText(text, next))).toBe(next);
      text = next.length > 400 ? next.slice(0, 200) : next;
    }
  });
});
