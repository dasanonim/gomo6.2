/**
 * Strip CR/LF from a value before it reaches the console.
 *
 * Log injection (CWE-117): a server-supplied string containing "\n" can forge
 * whole log lines in devtools — fake errors, fake stack traces, ANSI control
 * sequences — and that is exactly the text people copy into bug reports. Any
 * value that originates from the network should pass through here before it is
 * handed to console.*.
 */
export const sanitizeLog = (value: unknown): string => String(value).replace(/[\r\n]/g, "");
