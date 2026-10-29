import { Client } from "./client.ts";

const deadline = setTimeout(() => process.exit(1), 10_000);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (part: string) => {
  input += part;
  if (Buffer.byteLength(input) > 16_384) process.exit(1);
});
process.stdin.on("end", () => {
  void (async () => {
    const { options, nonce } = JSON.parse(input);
    await new Client({ ...options, interaction: "never" }).runBackgroundWorker(nonce);
  })().then(
    () => {
      clearTimeout(deadline);
    },
    () => {
      clearTimeout(deadline);
      process.exitCode = 1;
    },
  );
});
