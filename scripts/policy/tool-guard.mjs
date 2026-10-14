import { readFileSync } from 'node:fs';
// Supplementary guard for recognizable command forms. This is not a shell interpreter or a sandbox.
export function commandReason(command) {
  const parts = command.split(/(?:&&|\|\||;|\n)/).map((part) => part.trim());
  for (const part of parts) {
    if (/^(?:env\s+)?(?:\w+=\S+\s+)*(?:git|\/\S*\/git)\s/.test(part)) {
      if (
        /(?:--no-verify|core\.hooksPath\s*=|core\.hooksPath\s+|\bconfig\b[^\n]*--unset[^\n]*core\.hooksPath)/.test(
          part
        )
      )
        return 'Git hook bypass is blocked.';
      if (
        /\bpush\b/.test(part) &&
        /(?:--force(?:-with-lease)?\b|(?:^|\s)-f(?:\s|$)|(?:^|\s)\+|--mirror\b)/.test(
          part
        )
      )
        return 'Forced/mirror push is blocked.';
      if (
        /\bpush\b/.test(part) &&
        /(?:^|[\s:])(?:refs\/heads\/)?(?:main|develop)(?:\s|$)/.test(part)
      )
        return 'Direct protected-branch push is blocked; use a PR.';
    }
    if (
      /^(?:(?:pnpm|npx)\s+(?:exec\s+)?)?prisma\s+(?:migrate\s+reset|db\s+push\b[^\n]*--(?:force-reset|accept-data-loss))/.test(
        part
      )
    )
      return 'Destructive Prisma reset is blocked; use an isolated migration workflow.';
    if (
      /^(?:docker\s+compose|docker-compose)\b[^\n]*\bdown\b[^\n]*(?:--volumes|(?:^|\s)-v(?:\s|$))/.test(
        part
      )
    )
      return 'Database volume deletion is blocked.';
  }
  return null;
}
export function evaluate(input) {
  if (input.hook_event_name !== 'PreToolUse')
    throw new Error('Unexpected hook event');
  if (!input.tool_input || typeof input.tool_input !== 'object')
    throw new Error('Invalid tool input');
  const name = input.tool_name;
  if (['Bash', 'exec_command', 'shell_command'].includes(name)) {
    const command = input.tool_input.command ?? input.tool_input.cmd;
    if (typeof command !== 'string') throw new Error('Missing shell command');
    return commandReason(command);
  }
  return null;
}
export function main() {
  let reason;
  try {
    reason = evaluate(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    reason = 'Malformed safety hook input; retry with valid tool input.';
  }
  if (reason) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })
    );
    console.error(`[woori policy] ${reason}`);
    process.exitCode = 2;
  }
}
