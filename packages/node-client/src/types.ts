export type Decision = "undecided" | "granted" | "declined";
export type PermissionOutcome = "granted" | "declined" | "unavailable";
export type Recorded = "counted" | "suppressed" | "capacityReached";
export type Dimensions = Readonly<Record<string, string>>;
export interface ProjectContext {
  /** undefined means unavailable; null means confirmed absent. */
  origin?: string | null;
  packageJson?: string;
}
export interface ClientOptions {
  origin: string;
  /** Absolute private directory. Node and Rust use separate subdirectories. */
  stateRoot: string;
  tool: string;
  version: string;
  /** Use never for JSON output, editors, agents, and unattended modes. */
  interaction?: "terminal" | "never";
  /** Called lazily, once, after collection permission; never sent to a worker. */
  projectContext?: () => ProjectContext | Promise<ProjectContext>;
  policy?: {
    offline?: boolean;
    doNotTrack?: boolean;
    hostDisabled?: boolean;
    telemetry?: string;
    ci?: boolean;
    ciRevision?: string;
    isolatedCiState?: boolean;
  };
}
export interface AdditionalPermissionStatus {
  decision: Decision;
  pending: boolean;
}
export interface Status {
  decision: Decision;
  optIn: boolean;
  collectOptIn: boolean;
  disabled: boolean;
  deletionPending: boolean;
  openDimensions: number;
  queuedBatches: number;
  dropped: number;
}
export interface Resource {
  id: string;
  url: string;
  bytes: number;
  sha256: string;
  reporting?: { metric: string; dimensions: Dimensions };
}
export interface DownloadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
export type ErrorCode =
  | "Configuration"
  | "State"
  | "Busy"
  | "Clock"
  | "AdditionalPermission"
  | "PreviousIdentity"
  | "Background"
  | "Interaction"
  | "Offline"
  | "Cancelled"
  | "Network"
  | "HttpStatus"
  | "Integrity"
  | "DownloadStorage";

const messages: Record<ErrorCode, string> = {
  Configuration: "invalid client, metric, or resource configuration",
  State: "private client state unavailable or invalid",
  Busy: "client state is busy",
  Clock: "client clock outside supported range",
  AdditionalPermission: "additional permission prerequisites are not met",
  PreviousIdentity: "delete the previous reporting identity before renewing an expired grant",
  Background: "background reporting worker unavailable",
  Interaction: "permission dialog input or output unavailable",
  Offline: "resource unavailable in offline mode",
  Cancelled: "resource download cancelled",
  Network: "request failed or exceeded its deadline",
  HttpStatus: "resource server returned an unsuccessful HTTP status",
  Integrity: "resource size or SHA-256 verification failed",
  DownloadStorage: "temporary resource storage unavailable",
};
export class TrackingError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(messages[code]);
    this.name = "TrackingError";
    this.code = code;
  }
}
export function fail(code: ErrorCode): never {
  throw new TrackingError(code);
}
