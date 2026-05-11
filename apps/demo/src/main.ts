import { runDemo } from "./demo";
import { harness } from "./test-harness";

window.__fipsHarness = harness;

runDemo().catch((err) => {
  console.error(err);
  const log = document.getElementById("log");
  if (log) log.textContent += `\n[fatal] ${(err as Error).message}`;
});
