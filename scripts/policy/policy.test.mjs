import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  contentProblems,
  messageProblems,
  checkPush,
  verifyCommit,
} from "./core.mjs";
import { evaluate } from "./tool-guard.mjs";
const source = resolve(fileURLToPath(new URL("../..", import.meta.url)));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "woori-policy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invoke = (args, options = {}) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", ...options });
  for (const args of [
    ["init", "-b", "feature/test"],
    ["config", "user.name", "Policy Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "commit.gpgsign", "false"],
  ])
    assert.equal(invoke(args).status, 0);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(source, "scripts/policy"), join(dir, "scripts/policy"), {
    recursive: true,
  });
  cpSync(join(source, ".githooks"), join(dir, ".githooks"), {
    recursive: true,
  });
  writeFileSync(join(dir, ".nvmrc"), "24.12.0\n");
  assert.equal(invoke(["config", "core.hooksPath", ".githooks"]).status, 0);
  const write = (name, value) => {
    mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), value);
  };
  const commit = () => {
    assert.equal(invoke(["add", "."]).status, 0);
    return invoke(["commit", "-m", "검사 fixture 추가"]);
  };
  write("hello.txt", "safe\n");
  assert.equal(commit().status, 0);
  return {
    dir,
    invoke,
    write,
    commit,
    sha: () => invoke(["rev-parse", "HEAD"]).stdout.trim(),
  };
}
test("recognized credentials are redacted and env examples remain allowed", () => {
  assert.deepEqual(contentProblems(".env.example", "PASSWORD=REPLACE"), []);
  assert.ok(contentProblems(".env.production", "password=private").length);
  const token = ["ghp_", "a".repeat(36)].join("");
  const result = contentProblems("config.ts", token).join(" ");
  assert.match(result, /line 1/);
  assert.ok(!result.includes(token));
  assert.ok(contentProblems("CLAUDE.md", "x\n".repeat(201)).length);
});
test("commit signatures are rejected without restricting normal Korean messages", () => {
  assert.deepEqual(messageProblems("인증 처리 추가\n\n- 세션 검증 보완"), []);
  assert.ok(
    messageProblems("변경\n\nCo-authored-by: Agent <agent@example.invalid>")
      .length,
  );
});
test("real installed pre-commit permits feature commits and blocks protected branch commit", (t) => {
  const f = fixture(t);
  assert.equal(f.invoke(["switch", "-c", "develop"]).status, 0);
  f.write("hello.txt", "changed\n");
  const before = f.sha();
  assert.notEqual(f.commit().status, 0);
  assert.equal(f.sha(), before);
});
test("staged forbidden file blocked even when worktree removes its content", (t) => {
  const f = fixture(t);
  f.write(".env", "SECRET=test");
  f.invoke(["add", ".env"]);
  f.write(".env", "");
  assert.notEqual(f.invoke(["commit", "-m", "환경 추가"]).status, 0);
});
test("staged token blocked even when worktree is safe", (t) => {
  const f = fixture(t);
  f.write("hello.txt", ["ghp_", "b".repeat(36)].join(""));
  f.invoke(["add", "hello.txt"]);
  f.write("hello.txt", "safe");
  const result = f.invoke(["commit", "-m", "변경"]);
  assert.notEqual(result.status, 0);
  assert.ok(!result.stderr.includes("b".repeat(36)));
});
test("actual commit-msg hook rejects coauthor", (t) => {
  const f = fixture(t);
  f.write("hello.txt", "changed");
  f.invoke(["add", "."]);
  assert.notEqual(
    f.invoke([
      "commit",
      "-m",
      "변경\n\nCo-authored-by: Bot <bot@example.invalid>",
    ]).status,
    0,
  );
});
test("existing migration modification and deletion blocked, new migration allowed", (t) => {
  const f = fixture(t);
  f.write("prisma/migrations/001/migration.sql", "SELECT 1;");
  assert.equal(f.commit().status, 0);
  f.write("prisma/migrations/002/migration.sql", "SELECT 2;");
  assert.equal(f.commit().status, 0);
  f.write("prisma/migrations/001/migration.sql", "SELECT 3;");
  assert.notEqual(f.commit().status, 0);
  f.invoke([
    "restore",
    "--staged",
    "--worktree",
    "prisma/migrations/001/migration.sql",
  ]);
  f.invoke(["rm", "prisma/migrations/001/migration.sql"]);
  assert.notEqual(f.invoke(["commit", "-m", "삭제"]).status, 0);
});
test("installed pre-push blocks aliases, deletion and protected refs without network push", (t) => {
  const f = fixture(t);
  const zero = "0".repeat(40);
  for (const update of [
    `HEAD ${f.sha()} refs/heads/develop ${zero}`,
    `(delete) ${zero} refs/heads/main ${f.sha()}`,
  ]) {
    const inputPath = join(f.dir, "push-input.txt");
    writeFileSync(inputPath, update + "\n");
    const result = f.invoke([
      "hook",
      "run",
      `--to-stdin=${inputPath}`,
      "pre-push",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Direct update/);
  }
  assert.deepEqual(checkPush(f.dir, ""), []);
});
test("feature fast-forward allowed and diverging update rejected", (t) => {
  const f = fixture(t);
  const base = f.sha();
  f.write("hello.txt", "next");
  assert.equal(f.commit().status, 0);
  const tip = f.sha();
  assert.equal(
    checkPush(f.dir, `HEAD ${tip} refs/heads/feature ${base}`).length,
    1,
  );
  assert.throws(
    () => checkPush(f.dir, `HEAD ${base} refs/heads/feature ${tip}`),
    /Non-fast-forward/,
  );
  assert.throws(() => checkPush(f.dir, "malformed"), /Invalid/);
});
test("outgoing validation uses archived commit not dirty worktree; failed quality blocks", (t) => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ name: "woori_client" }));
  f.write("snapshot.txt", "committed");
  assert.equal(f.commit().status, 0);
  f.write("snapshot.txt", "dirty");
  const bin = mkdtempSync(join(tmpdir(), "woori-fake-pnpm-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  const fake = join(bin, "pnpm");
  writeFileSync(
    fake,
    '#!/bin/sh\ntest "$(cat snapshot.txt)" = committed || exit 4\ngit rev-parse --show-toplevel >/dev/null || exit 5\nexit 0\n',
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    verifyCommit(f.dir, f.sha());
    writeFileSync(fake, "#!/bin/sh\nexit 7\n");
    assert.throws(() => verifyCommit(f.dir, f.sha()), /failed/);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(readFileSync(join(f.dir, "snapshot.txt"), "utf8"), "dirty");
});
test("both tool adapters permit safe commands, deny prohibited commands and malformed input", () => {
  for (const adapter of [
    ".claude/hooks/pre-tool-use.mjs",
    ".codex/hooks/pre-tool-use.mjs",
  ]) {
    for (const [command, denied] of [
      ["git status --short", false],
      ["pnpm test", false],
      ["git push origin HEAD:develop", true],
      ["git -c core.hooksPath=/dev/null commit -m x", true],
      ["git push --no-verify", true],
      ["pnpm exec prisma migrate reset --force", true],
      ["docker compose down -v", true],
    ]) {
      const input = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      });
      const result = spawnSync(process.execPath, [join(source, adapter)], {
        input,
        encoding: "utf8",
      });
      assert.equal(result.status, denied ? 2 : 0, command);
      if (denied)
        assert.equal(
          JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
          "deny",
        );
    }
    assert.equal(
      spawnSync(process.execPath, [join(source, adapter)], {
        input: "{bad",
        encoding: "utf8",
      }).status,
      2,
    );
  }
  assert.equal(
    evaluate({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'echo "git push origin develop"' },
    }),
    null,
  );
});

test("registered hook commands work from a nested project directory", () => {
  for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
    const config = JSON.parse(readFileSync(join(source, file), "utf8"));
    const command = config.hooks.PreToolUse[0].hooks[0].command;
    for (const [toolCommand, status] of [
      ["git status --short", 0],
      ["git push origin HEAD:develop", 2],
    ]) {
      const result = spawnSync("sh", ["-c", command], {
        cwd: join(source, "scripts"),
        encoding: "utf8",
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: toolCommand },
        }),
      });
      assert.equal(result.status, status, result.stderr);
    }
  }
});
