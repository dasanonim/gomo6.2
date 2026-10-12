// Package logsafe wraps the standard logger so values that may contain user
// input are neutralised before they reach a log line.
//
// Log injection (CWE-117) is not about escaping a format string: whoever can
// put a "\n" into a logged value can forge whole log entries — fake "ERROR"
// lines, fake audit records, or ANSI control sequences in a terminal. Rather
// than audit every field at every call site, use these wrappers for anything
// derived from a request: the formatted message is stripped of CR and LF as a
// whole, so every argument is covered regardless of its type.
//
// Plain log.Printf stays the right choice for values that are provably not
// user-controlled (startup diagnostics, static configuration); those are the
// only sites where CodeQL's go/log-injection would still have something to
// report.
package logsafe

import (
	"fmt"
	"log"
	"strings"
)

// Sanitize strips CR and LF so a value cannot forge or split a log line.
// The replacements stay inline: CodeQL's go/log-injection recognises
// strings.ReplaceAll of "\r"/"\n" as the sanitizer.
func Sanitize(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	return strings.ReplaceAll(s, "\n", "")
}

// Printf is log.Printf with the formatted message sanitised. Formatting happens
// first (so %d/%.2f/%v keep working), then CR/LF are stripped from the result;
// log.Print does not re-interpret the text, so a literal "%s" in user data
// stays literal.
func Printf(format string, args ...any) { log.Print(Sanitize(fmt.Sprintf(format, args...))) }

// Println is log.Println with the message sanitised.
func Println(args ...any) { log.Print(Sanitize(fmt.Sprintln(args...))) }

// Fatalf is log.Fatalf with the formatted message sanitised.
func Fatalf(format string, args ...any) { log.Fatal(Sanitize(fmt.Sprintf(format, args...))) }
