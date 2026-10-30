// Synthetic host example. Supply private roots and an origin; no real user defaults.
import { CliClient } from "@sebastian-software/app-tracking";

const [origin, stateRoot, cacheRoot, command = "help"] = process.argv.slice(2);
const services = new CliClient({
  origin,
  stateRoot,
  tool: "ardo",
  version: "1.0.0",
  interaction: "never",
  invocation: { metric: "cli.invocation", categories: { build: { command: "build" } } },
  updates: { cacheRoot, distribution: "github", mode: "enabled", serviceMetrics: false },
});

// Real hosts own command routing, informed choices, eligibility, and rendering.
if (command === "status") console.log(JSON.stringify(await services.status()));
else if (command === "preview") console.log(JSON.stringify(await services.preview()));
else if (command === "withdraw") console.log(JSON.stringify(await services.withdrawReporting()));
else if (command === "disable") console.log(JSON.stringify(await services.disableReporting()));
else if (command === "delete") console.log(JSON.stringify(await services.deleteReporting()));
else if (command === "permission") {
  // Change interaction to terminal only at an eligible interactive host boundary.
  await services.requestReportingOptIn(
    "Help prioritize Ardo maintenance. Privacy: https://example.com/privacy",
  );
} else if (command === "build") {
  try {
    await services.recordInvocation("build"); // Exactly once, where real work begins.
    console.log('{"command":"ok"}'); // Stand-in for the host's normal work/output.
    const result = await services.checkForUpdates(); // Host chose this output boundary.
    if (result.ok && result.value)
      console.error(`Update ${result.value.latestVersion}; see ${result.value.releaseUrl}`);
    process.exitCode = 7; // Synthetic nonzero command result must survive optional work.
  } finally {
    await services.complete(); // Also runs after a failed or interrupted command.
  }
} else {
  console.log("Synthetic help: build, status, preview, permission, withdraw, disable, delete");
}
