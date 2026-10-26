import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  LoginScreen,
  type VerifyResult,
} from "../../../apps/dashboard/src/LoginScreen.tsx";
import "../../../apps/dashboard/src/style.css";

interface Pending {
  token: string;
  signal?: AbortSignal;
  resolve: (result: VerifyResult) => void;
  reject: (error: Error) => void;
}
declare global {
  interface Window {
    loginHarness: {
      pending: Pending[];
      authenticated: string[];
      hide(): void;
      mount(): void;
    };
  }
}
const root = createRoot(document.getElementById("root")!);
window.loginHarness = {
  pending: [],
  authenticated: [],
  hide: () => root.render(null),
  mount: () =>
    root.render(
      <StrictMode>
        <LoginScreen
          // Deliberately ignore cancellation so stale-result guards are exercised.
          verify={(token, signal) =>
            new Promise((resolve, reject) =>
              window.loginHarness.pending.push({
                token,
                signal,
                resolve,
                reject,
              }),
            )
          }
          onAuthenticated={(token) =>
            window.loginHarness.authenticated.push(token)
          }
        />
      </StrictMode>,
    ),
};
window.loginHarness.mount();
