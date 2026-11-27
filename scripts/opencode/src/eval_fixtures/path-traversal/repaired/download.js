import path from "node:path";

export function filePath(baseDir, name) {
  const resolved = path.resolve(baseDir, name);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new Error("unsafe path");
  }
  return resolved;
}
