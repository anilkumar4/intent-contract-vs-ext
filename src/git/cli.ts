import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitText(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return result.stdout;
}

export async function gitBuffer(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Buffer> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, ...env },
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return result.stdout as Buffer;
}

export async function findRepositoryRoot(directory: string): Promise<string> {
  return (await gitText(directory, ["rev-parse", "--show-toplevel"])).trim();
}

export async function optionalHeadSha(root: string): Promise<string | null> {
  try {
    return (await gitText(root, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}
