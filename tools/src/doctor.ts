import fs from "node:fs";
import { execSync } from "node:child_process";
import { stateDir } from "./paths.ts";
import { tryBind } from "./bind.ts";

function row(name: string, ok: boolean, hint = ""): string {
  const sym = ok ? "✓" : "✗";
  return `${sym} ${name.padEnd(34)} ${ok ? "" : hint}`;
}

async function portFree(port: number): Promise<boolean> {
  const srv = await tryBind(port);
  if (!srv) return false;
  srv.close();
  return true;
}

export async function runDoctor(): Promise<void> {
  const lines: string[] = [];

  const node = process.versions.node.split(".").map(Number);
  lines.push(row("node >= 20", node[0] >= 20, `current: v${process.versions.node}`));

  let claudePath = "";
  try {
    const cmd = process.platform === "win32"
      ? "where claude"
      : "command -v claude 2>/dev/null || which claude 2>/dev/null";
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    claudePath = execSync(cmd, { encoding: "utf8", shell }).trim().split(/\r?\n/)[0] || "";
  } catch {}
  lines.push(row("claude on PATH", !!claudePath, "install Claude Code, then re-run"));

  lines.push(row(
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1",
    "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
  ));

  let bindable = false;
  for (let p = 7777; p <= 7790; p++) {
    if (await portFree(p)) { bindable = true; break; }
  }
  lines.push(row("port in 7777-7790 bindable", bindable, "free a port in that range"));

  let writable = false;
  try {
    const d = stateDir();
    fs.accessSync(d, fs.constants.W_OK);
    writable = true;
  } catch {}
  lines.push(row("state/ writable", writable, "check ~/.claude/plugins/swarmeq/state perms"));

  // Check that the installed claude supports --fork-session by grepping --help.
  // Avoids API spend; the actual fork-probe is exercised on tab click.
  let forkOk = false;
  if (claudePath) {
    try {
      const help = execSync(`${claudePath} --help`, { encoding: "utf8", timeout: 4000 });
      forkOk = help.includes("--fork-session") && help.includes("--no-session-persistence");
    } catch {}
  }
  lines.push(row("--fork-session supported", forkOk, "update Claude Code to >=2.1.117"));

  process.stdout.write(lines.join("\n") + "\n");
}
