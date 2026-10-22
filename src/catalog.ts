export type ReleaseSource =
  | { kind: "npm"; packageName: string; tag: string }
  | {
      kind: "github";
      repository: string;
      tagPrefix: string;
      binaryTargets: readonly string[];
    };

export interface Distribution {
  tool: string;
  distribution: string;
  channel: "stable";
  source: ReleaseSource;
}

// This reviewed catalog, never request data, owns every upstream destination.
export const catalog: readonly Distribution[] = [
  {
    tool: "dalo",
    distribution: "npm",
    channel: "stable",
    source: { kind: "npm", packageName: "getdalo", tag: "latest" },
  },
  {
    tool: "dalo",
    distribution: "standalone",
    channel: "stable",
    source: {
      kind: "github",
      repository: "sebastian-software/dalo",
      tagPrefix: "dalo-v",
      binaryTargets: [
        "aarch64-apple-darwin",
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl",
        "x86_64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
      ],
    },
  },
  {
    tool: "palamedes",
    distribution: "npm",
    channel: "stable",
    source: { kind: "npm", packageName: "@palamedes/cli", tag: "latest" },
  },
];

export function versionPath(entry: Distribution): string {
  return `/v1/versions/${entry.tool}/${entry.distribution}/${entry.channel}`;
}
