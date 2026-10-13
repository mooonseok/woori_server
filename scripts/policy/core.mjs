import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
export function git(args, cwd = process.cwd(), options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}
export const root = () => git(["rev-parse", "--show-toplevel"]).trim();
export const protectedRef = (ref) => /^refs\/heads\/(main|develop)$/.test(ref);
export const zero = (sha) => /^0+$/.test(sha);
export function forbiddenFile(file) {
  const name = basename(file);
  return (
    ((name === ".env" || name.startsWith(".env.")) &&
      !/^\.env(?:\.[a-z0-9-]+)?\.example$/.test(name)) ||
    /\.(pem|p12|pfx|key)$/i.test(name) ||
    /^(id_rsa|id_ed25519|credentials\.json)$/.test(name)
  );
}
export function contentProblems(file, content) {
  const result = [];
  if (forbiddenFile(file)) result.push("forbidden credential file");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Deliberately limited to recognizable credentials; never print matching values.
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(lines[i]) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{20,})\b/.test(
        lines[i],
      )
    )
      result.push(`recognized credential at line ${i + 1}`);
  }
  if (
    ["AGENTS.md", "CLAUDE.md"].includes(file) &&
    content.trimEnd().split("\n").length > 200
  )
    result.push("instruction entry exceeds 200 lines");
  return result;
}
export function messageProblems(message) {
  return /^(?:Co-authored-by|Generated-by|Assisted-by):|Generated (?:with|by) (?:Claude|Codex|ChatGPT)/im.test(
    message,
  )
    ? ["agent/co-author signature is not allowed"]
    : [];
}
export function scanSnapshot(cwd, ref = null) {
  const files = ref
    ? git(["ls-tree", "-r", "--name-only", "-z", ref], cwd).split("\0")
    : git(["ls-files", "-z"], cwd).split("\0");
  const errors = [];
  for (const file of files.filter(Boolean)) {
    const bytes = execFileSync(
      "git",
      ["show", ref ? `${ref}:${file}` : `:${file}`],
      { cwd, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (forbiddenFile(file)) errors.push(`${file}: forbidden credential file`);
    if (bytes.includes(0)) continue;
    for (const issue of contentProblems(file, bytes.toString("utf8")))
      errors.push(`${file}: ${issue}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
export function checkMigrations(cwd, base, target = null) {
  const args = ["diff", "--name-status", "--no-renames"];
  if (!target) args.push("--cached");
  args.push(base);
  if (target) args.push(target);
  args.push("--", "prisma/migrations");
  const changed = git(args, cwd).trim().split("\n").filter(Boolean);
  if (changed.some((line) => !line.startsWith("A\t")))
    throw new Error(
      "Existing migration changed/deleted; add a new migration instead.",
    );
}
export function checkPush(cwd, input) {
  const updates = input
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  for (const fields of updates) {
    if (
      fields.length !== 4 ||
      !/^[0-9a-f]{40,64}$/.test(fields[1]) ||
      !/^[0-9a-f]{40,64}$/.test(fields[3])
    )
      throw new Error("Invalid pre-push input");
    const [, local, remoteRef, remote] = fields;
    if (protectedRef(remoteRef))
      throw new Error(`Direct update of ${remoteRef} blocked; use a PR.`);
    if (!zero(local) && !zero(remote)) {
      const ancestor = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", remote, local],
        { cwd },
      );
      if (ancestor.status !== 0)
        throw new Error(
          "Non-fast-forward or unknown remote history blocked. Fetch and retry.",
        );
    }
  }
  return updates;
}
export function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? "launch error"})`);
}
export function quality(cwd) {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Node 24 required; run nvm use.");
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const tasks =
    pkg.name === "woori_client"
      ? [
          "policy:check",
          "policy:test",
          "lint",
          "typecheck",
          "test",
          "check:boundaries",
          "format:check",
          "build",
        ]
      : [
          "policy:check",
          "policy:test",
          "prisma:validate",
          "typecheck",
          "test",
          "test:integration",
        ];
  for (const task of tasks) run("pnpm", ["run", task], cwd);
}
// Verify exactly the outgoing commit in a disposable checkout, not a dirty working tree.
export function verifyCommit(cwd, sha) {
  const dir = mkdtempSync(join(tmpdir(), "woori-push-"));
  chmodSync(dir, 0o700);
  try {
    const archive = execFileSync("git", ["archive", sha], {
      cwd,
      maxBuffer: 128 * 1024 * 1024,
    });
    const unpack = spawnSync("tar", ["-x", "-C", dir], { input: archive });
    if (unpack.status !== 0) throw new Error("Cannot extract outgoing commit");
    // Registered hooks resolve their paths via Git, even in an archived snapshot.
    run("git", ["init", "--quiet", "-b", "push-verification"], dir);
    if (
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name ===
      "woori_server"
    ) {
      // Preserve the existing runner guard; only isolated local connection values enter the temp checkout.
      if (!existsSync(join(cwd, ".env")))
        throw new Error(
          "Server integration needs the isolated local .env setup.",
        );
      const parsed = awaitEnv(readFileSync(join(cwd, ".env"), "utf8"));
      for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
        const url = new URL(parsed[key]);
        if (
          url.hostname !== "127.0.0.1" ||
          url.port !== "55439" ||
          url.pathname !== "/woori_dev"
        )
          throw new Error(
            "Only isolated local DB credentials allowed for pre-push.",
          );
      }
      writeFileSync(
        join(dir, ".env"),
        ["DATABASE_URL", "MIGRATION_DATABASE_URL"]
          .map((key) => `${key}=${JSON.stringify(parsed[key])}`)
          .join("\n") + "\n",
        { mode: 0o600 },
      );
    }
    run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], dir);
    quality(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Node's dotenv parser handles quoting without printing the source.
import { parseEnv as awaitEnv } from "node:util";
