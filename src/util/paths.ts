import path from "node:path";

export function toRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function resolveRepoFile(root: string, repoPath: string): string {
  const normalized = toRepoPath(repoPath);
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Unsafe repository path: ${repoPath}`);
  }
  return path.join(root, ...normalized.split("/"));
}
