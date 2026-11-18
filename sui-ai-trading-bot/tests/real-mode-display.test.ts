import { expect, it } from "vitest";
import { deploymentMode } from "../apps/worker/src/http-routes.ts";
it("reports PAPER, REAL execution, and REAL read-only modes", () => {
  expect(deploymentMode("PAPER")).toBe("PAPER");
  expect(deploymentMode("REAL_TRADECAP")).toBe("REAL_TRADECAP");
  expect(deploymentMode("REAL_READONLY")).toBe("REAL_READONLY");
});
