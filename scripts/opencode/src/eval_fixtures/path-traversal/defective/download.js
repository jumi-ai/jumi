import path from "node:path";

export function filePath(baseDir, name) {
  return path.join(baseDir, name);
}
