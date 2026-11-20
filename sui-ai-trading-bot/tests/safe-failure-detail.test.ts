import { expect, it } from "vitest";
import { safeFailureDetail } from "../packages/shared/src/index.ts";

it("removes URLs and long hex strings and normalizes whitespace", () => {
  expect(
    safeFailureDetail(
      new Error(
        `Failed\n HTTP://user:password@example.invalid/ https://example.invalid/?token=hidden\t object 0x${"a".repeat(32)} pending`,
      ),
    ),
  ).toBe("Failed object pending");
});

it("redacts credential assignments and bearer values", () => {
  expect(
    safeFailureDetail(
      new Error("Token=private KEY : key-value secret: hidden Password=pw Authorization: Bearer jwt Bearer other"),
    ),
  ).toBe(
    "Token=[redacted] KEY : [redacted] secret: [redacted] Password=[redacted] Authorization: [redacted] Bearer [redacted]",
  );
});

it("scrubs and appends only the immediate Error cause", () => {
  const cause = new Error("Request failed token=private", {
    cause: new Error("Nested failure"),
  });
  expect(safeFailureDetail(new Error("Execution failed", { cause }))).toBe(
    "Execution failed | cause: Request failed token=[redacted]",
  );
});

it("caps the full detail at 240 characters after scrubbing", () => {
  expect(
    safeFailureDetail(new Error(`https://example.invalid ${"x".repeat(250)}`)),
  ).toBe("x".repeat(240));
});

it("returns an empty string when there is no usable message", () => {
  expect(safeFailureDetail("Failure")).toBe("");
  expect(safeFailureDetail(new Error(""))).toBe("");
  expect(safeFailureDetail(new Error("https://example.invalid"))).toBe("");
});
