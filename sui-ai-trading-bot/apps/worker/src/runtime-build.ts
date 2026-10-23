import { createHash } from "node:crypto";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface RuntimeBuild {
  declaredSha: string | null;
  declaredImage: string | null;
  node: string;
  lockSha256: string;
}
// Declarations must be independently matched to docker inspect by the operator.
// Never persist the environment, URLs, auth headers or credentials.
export function runtimeBuild(
  env: NodeJS.ProcessEnv,
  lock: string,
): RuntimeBuild {
  const sha = env.SUIBA_BUILD_SHA,
    image = env.SUIBA_IMAGE_ID;
  if (sha && sha !== "unknown" && !/^[a-f0-9]{40}$/.test(sha))
    throw Error("INVALID_BUILD_SHA");
  if (image && !/^sha256:[a-f0-9]{64}$/.test(image))
    throw Error("INVALID_IMAGE_ID");
  return {
    declaredSha: sha && sha !== "unknown" ? sha : null,
    declaredImage: image ?? null,
    node: process.version,
    lockSha256: digest(lock),
  };
}
