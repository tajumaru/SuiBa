import React from "react";
import { reason } from "./presentation.ts";
export function Reason({ code }: { code: string }) {
  return (
    <>
      {reason(code)}
      {!/[^\x20-\x7E]/.test(code) && (
        <small className="error-code">コード：{code}</small>
      )}
    </>
  );
}
