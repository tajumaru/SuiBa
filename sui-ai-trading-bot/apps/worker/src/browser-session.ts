import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const NAME = "suiba.session";
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class BrowserSessions {
  constructor(private readonly secret: string) {}
  private sign(value: string) {
    return createHmac("sha256", this.secret)
      .update("suiba-session:" + value)
      .digest("base64url");
  }
  issue(now = Date.now()) {
    const value = `${now + SESSION_SECONDS * 1000}.${randomBytes(24).toString("base64url")}`;
    return `${value}.${this.sign(value)}`;
  }
  valid(cookie = "", now = Date.now()) {
    const value = cookie
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(NAME + "="))
      ?.slice(NAME.length + 1);
    if (!value) return false;
    const parts = value.split(".");
    if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return false;
    const expiry = Number(parts[0]);
    return (
      expiry > now &&
      expiry <= now + SESSION_SECONDS * 1000 &&
      equal(parts[2], this.sign(parts.slice(0, 2).join(".")))
    );
  }
  bearer(req: IncomingMessage) {
    return equal(req.headers.authorization ?? "", "Bearer " + this.secret);
  }
  setCookie(req: IncomingMessage, res: ServerResponse, clear = false) {
    const secure =
      (req.socket as { encrypted?: boolean }).encrypted ||
      req.headers["x-forwarded-proto"] === "https";
    res.setHeader(
      "Set-Cookie",
      `${NAME}=${clear ? "" : this.issue()}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure ? "; Secure" : ""}`,
    );
  }
}

/** Cookie requests must carry a header that cross-origin forms cannot supply.
 * The server exposes no CORS permission for cross-origin scripted requests. */
export function sessionMutationAllowed(req: IncomingMessage) {
  return (
    req.headers["x-suiba-request"] === "1" &&
    (!req.headers["sec-fetch-site"] ||
      req.headers["sec-fetch-site"] === "same-origin")
  );
}
