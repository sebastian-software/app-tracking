import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import * as os from "node:os";
import type { ProjectContext } from "./types.ts";

export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function projectIdentity(context: ProjectContext): string | undefined {
  let input = context.origin;
  if (input === undefined) return;
  if (input === null) {
    if (!context.packageJson || Buffer.byteLength(context.packageJson) > 1_048_576) return;
    try {
      const repository = JSON.parse(context.packageJson).repository;
      if (typeof repository === "string") input = repository;
      else if (
        repository &&
        (repository.type === undefined || repository.type === "git") &&
        typeof repository.url === "string"
      )
        input = repository.url;
      else return;
      if (typeof input !== "string") return;
      const shorthand = /^(github|gitlab|bitbucket):(.+)$/.exec(input);
      if (shorthand)
        input = `https://${{ github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" }[shorthand[1]]}/${shorthand[2]}`;
      else if (!input.includes(":") && input.split("/").length === 2)
        input = `https://github.com/${input}`;
    } catch {
      return;
    }
  }
  if (!input || input.length > 8192 || /[^\x21-\x7e]|[\\?#]/.test(input)) return;
  let transport: string, authority: string, path: string;
  const url = /^([^:]+):\/\/([^/]+)\/(.*)$/.exec(input);
  if (url) {
    transport = url[1].toLowerCase().replace(/^git\+/, "");
    if (transport !== "https" && transport !== "ssh") return;
    [, , authority, path] = url;
  } else {
    const scp = /^([^:]+):(.*)$/.exec(input);
    if (!scp || scp[2].startsWith("/")) return;
    [, authority, path] = scp;
    transport = "ssh";
  }
  const user = authority.split("@");
  if (user.length > 2 || (user.length === 2 && !user[0])) return;
  authority = user.at(-1)!;
  const parts = authority.split(":");
  if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) return;
  let host = parts[0].toLowerCase();
  const port = parts.length === 2 ? Number(parts[1]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return;
  if (
    host.length > 253 ||
    !host.includes(".") ||
    !/[a-z]/.test(host.split(".").at(-1)!) ||
    host.split(".").some((p) => p.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))
  )
    return;
  const alias = host === "ssh.github.com";
  if (alias) {
    if (transport !== "ssh" || port !== 443) return;
    host = "github.com";
  }
  const validPath = (value: string) =>
    value.split("/").every((p) => p !== "." && p !== ".." && /^[a-zA-Z0-9._-]+$/.test(p));
  if (["github.com", "gitlab.com", "bitbucket.org"].includes(host)) {
    if (!alias && port !== undefined && port !== (transport === "ssh" ? 22 : 443)) return;
    path = path.replace(/\/$/, "").replace(/\.git$/, "");
    if (
      !validPath(path) ||
      path.split("/").length < 2 ||
      (host !== "gitlab.com" && path.split("/").length !== 2)
    )
      return;
    return hash(`${host}/${host === "github.com" ? path.toLowerCase() : path}`);
  }
  if (transport !== "https" || !validPath(path.replace(/\/$/, ""))) return;
  return hash(`https://${host}${port !== undefined && port !== 443 ? `:${port}` : ""}/${path}`);
}

export function numericVersion(raw: string): string {
  const prefix = /^[\d.]*/.exec(raw.trim())![0].replace(/\.+$/, "");
  const parts = prefix.split(".").slice(0, 4);
  return parts.some((p) => !/^\d{1,5}$/.test(p)) ? "unknown" : parts.map(Number).join(".");
}
async function boundedFile(path: string): Promise<string> {
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(16_384);
      const { bytesRead } = await file.read(buffer);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}
export async function systemContext(profile: string): Promise<Record<string, unknown> | undefined> {
  if (profile === "none") return;
  const platform = os.platform();
  const arch = process.arch;
  const result: Record<string, unknown> = {
    os:
      ({ darwin: "macos", linux: "linux", win32: "windows" } as Record<string, string>)[platform] ??
      "other",
    arch:
      ({ arm64: "aarch64", x64: "x86_64", ia32: "x86", arm: "arm" } as Record<string, string>)[
        arch
      ] ?? "other",
    os_version: "unknown",
    cpu_family: "unknown",
  };
  if (profile !== "full") return result;
  const model = os.cpus()[0]?.model.trim() ?? "";
  const apple = /^Apple M([1-9])(?: (?:Pro|Max|Ultra))?$/.exec(model);
  result.cpu_family = apple
    ? `apple_m${apple[1]}`
    : model.includes("Intel") || model === "GenuineIntel"
      ? "intel"
      : model.includes("AMD") || model === "AuthenticAMD"
        ? "amd"
        : model
          ? "other"
          : "unknown";
  // Node exposes the macOS kernel release, not the product version; keep that
  // product value unknown rather than labeling Darwin as a macOS version.
  if (platform === "win32") result.os_version = numericVersion(os.release());
  if (platform === "linux") {
    const release = await boundedFile("/etc/os-release");
    const field = (name: string) =>
      new RegExp(`^${name}=(.*)$`, "m")
        .exec(release)?.[1]
        .trim()
        .replace(/^["']|["']$/g, "") ?? "";
    const id = field("ID");
    const distribution = [
      "ubuntu",
      "debian",
      "fedora",
      "arch",
      "alpine",
      "nixos",
      "rhel",
      "centos",
      "rocky",
      "opensuse",
      "linuxmint",
      "pop",
    ].includes(id)
      ? id
      : id
        ? "other"
        : "unknown";
    result.os_version = numericVersion(field("VERSION_ID"));
    result.linux = {
      distribution,
      distribution_version: result.os_version,
      kernel_version: numericVersion(os.release()),
    };
  }
  return result;
}
