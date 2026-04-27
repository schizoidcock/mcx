/**
 * Exit Code Classification
 * 
 * Determines if a non-zero exit code is a real error or soft fail.
 * Linus principles: ONE function, early returns, no special cases.
 */

export interface ExitResult {
  isError: boolean;
  output: string;
}

const SOFT_FAIL_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'diff', 'find', 'cmp', 'test', '[']);

/**
 * Classify exit code as error or soft fail.
 * Exit 1 with stdout from grep/diff/find = valid result, not error.
 */
export function classifyExit(
  exitCode: number,
  stdout: string,
  stderr: string,
  command: string
): ExitResult {
  if (exitCode === 0) return { isError: false, output: stdout };
  
  if (exitCode === 1 && stdout.trim() && isSoftFailCommand(command)) {
    return { isError: false, output: stdout };
  }
  
  return { 
     
    output: formatError(exitCode, stdout, stderr)
  };
}

function isSoftFailCommand(cmd: string): boolean {
  const first = cmd.trim().split(/\s+/)[0].replace(/^.*[/\\]/, '');
  return SOFT_FAIL_COMMANDS.has(first);
}

function formatError(code: number, stdout: string, stderr: string): string {
  const msg = stderr || stdout || '(no output)';
  return `Exit ${code}\n${msg}`;
}