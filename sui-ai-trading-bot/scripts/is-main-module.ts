import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl: string, argvPath: string | undefined) {
  if (!argvPath) return false;
  const windows = win32.isAbsolute(argvPath);
  const absolutePath = windows ? win32.resolve(argvPath) : resolve(argvPath);
  return moduleUrl === pathToFileURL(absolutePath, { windows }).href;
}
