package logsafe

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestSanitize(t *testing.T) {
	cases := map[string]string{
		"plain":          "plain",
		"a\nb":           "ab",
		"a\r\nb":         "ab",
		"line1\rline2":   "line1line2",
		"forged\nERROR ": "forgedERROR ",
	}
	for in, want := range cases {
		if got := Sanitize(in); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPrintfStripsNewlines(t *testing.T) {
	var buf bytes.Buffer
	oldWriter, oldFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(oldWriter)
		log.SetFlags(oldFlags)
	}()

	Printf("user=%s action=%s n=%d", "evil\nERROR forged line", "login", 7)

	out := buf.String()
	// Exactly one newline: the one the logger itself appends.
	if strings.Count(out, "\n") != 1 {
		t.Fatalf("newline not neutralised: %q", out)
	}
	if !strings.Contains(out, "user=evilERROR forged line action=login n=7") {
		t.Fatalf("unexpected output: %q", out)
	}
}
