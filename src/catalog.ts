export interface Distribution {
  tool: string;
  distribution: string;
  channel: "stable";
  source: {
    repository: string;
    tagPrefix: string;
  };
}

// Reviewed mappings only. Distribution labels are API compatibility aliases;
// every installation of a tool uses the same GitHub release from oss-metrics.
export const catalog: readonly Distribution[] = [
  ...["github", "npm"].map((distribution) => ({
    tool: "ardo",
    distribution,
    channel: "stable" as const,
    source: { repository: "ardo", tagPrefix: "ardo-v" },
  })),
  ...["github", "npm", "standalone"].map((distribution) => ({
    tool: "dalo",
    distribution,
    channel: "stable" as const,
    source: { repository: "dalo", tagPrefix: "dalo-v" },
  })),
  ...["github", "npm"].map((distribution) => ({
    tool: "palamedes",
    distribution,
    channel: "stable" as const,
    source: { repository: "palamedes", tagPrefix: "palamedes-v" },
  })),
];

export function versionPath(entry: Distribution): string {
  return `/v1/versions/${entry.tool}/${entry.distribution}/${entry.channel}`;
}
