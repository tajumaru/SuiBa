import { expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BrowserSessions,
  SESSION_SECONDS,
  sessionMutationAllowed,
} from "../apps/worker/src/browser-session.ts";

const sessions = new BrowserSessions(
  "test-admin-secret-that-is-at-least-32-characters",
);
it("restores a session after server recreation without keeping the admin token in the cookie", () => {
  const value = sessions.issue(1000);
  expect(value).not.toContain("test-admin-secret");
  expect(
    new BrowserSessions(
      "test-admin-secret-that-is-at-least-32-characters",
    ).valid(`suiba.session=${value}`, 2000),
  ).toBe(true);
  expect(
    new BrowserSessions("rotated-secret").valid(`suiba.session=${value}`, 2000),
  ).toBe(false);
});
it("rejects expired, malformed, and tampered cookies", () => {
  const value = sessions.issue(1000);
  expect(
    sessions.valid(`suiba.session=${value}`, 1000 + SESSION_SECONDS * 1000),
  ).toBe(false);
  expect(sessions.valid(`suiba.session=${value}x`, 2000)).toBe(false);
  expect(sessions.valid("suiba.session=bad", 2000)).toBe(false);
  expect(sessions.valid("", 2000)).toBe(false);
});
it("sets persistent HttpOnly cookies and expires them on logout", () => {
  const req = {
    headers: { "x-forwarded-proto": "https" },
    socket: {},
  } as unknown as IncomingMessage;
  const setHeader = vi.fn();
  const res = { setHeader } as unknown as ServerResponse;
  sessions.setCookie(req, res);
  expect(setHeader.mock.calls[0][1]).toContain(
    "HttpOnly; SameSite=Strict; Max-Age=604800; Secure",
  );
  sessions.setCookie(req, res, true);
  expect(setHeader.mock.calls[1][1]).toContain(
    "suiba.session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0",
  );
});
it("blocks cross-origin forms and scripted mutations", () => {
  const allowed = (headers: Record<string, string>) =>
    sessionMutationAllowed({ headers } as IncomingMessage);
  expect(allowed({})).toBe(false);
  expect(
    allowed({ "x-suiba-request": "1", "sec-fetch-site": "cross-site" }),
  ).toBe(false);
  expect(
    allowed({ "x-suiba-request": "1", "sec-fetch-site": "same-site" }),
  ).toBe(false);
  expect(
    allowed({ "x-suiba-request": "1", "sec-fetch-site": "same-origin" }),
  ).toBe(true);
});
