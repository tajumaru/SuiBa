import { afterEach, expect, it, vi } from "vitest";
import { loginSession } from "../apps/dashboard/src/browserSession.ts";
import { verifyToken } from "../apps/dashboard/src/verifyToken.ts";
vi.mock("../apps/dashboard/src/verifyToken.ts", () => ({
  verifyToken: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("creates a persistent session only after verification succeeds", async () => {
  vi.mocked(verifyToken).mockResolvedValue({ ok: true });
  const request = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", request);
  expect(await loginSession("test-token")).toEqual({ ok: true });
  expect(request).toHaveBeenCalledWith(
    "/api/auth/session",
    expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer test-token", "X-SuiBa-Request": "1" },
    }),
  );
});
it("does not create a session for invalid credentials", async () => {
  vi.mocked(verifyToken).mockResolvedValue({ ok: false, code: "UNAUTHORIZED" });
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  expect(await loginSession("invalid")).toEqual({
    ok: false,
    code: "UNAUTHORIZED",
  });
  expect(request).not.toHaveBeenCalled();
});
it("reports failure when the server cannot create a session", async () => {
  vi.mocked(verifyToken).mockResolvedValue({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 503 })),
  );
  expect(await loginSession("test-token")).toEqual({
    ok: false,
    code: "HTTP_503",
  });
});
