// SubagentStop fires when a Task-spawned sub-agent finishes. For swarmeq v0.1,
// sub-agents are not registered separately; the registry only tracks top-level
// agents. This hook is intentionally a no-op so the registry stays clean.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", () => {}); // drain
