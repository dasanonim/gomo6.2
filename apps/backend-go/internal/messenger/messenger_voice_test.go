package messenger

import (
	"strings"
	"testing"
)

func TestValidateAudioMeta(t *testing.T) {
	valid := []string{
		`{"voice":true,"duration":12.4,"waveform":[6,40,100,0,55]}`,
		`{"voice":false,"duration":0,"waveform":[]}`,
		`{"duration":599.9}`,
	}
	for _, meta := range valid {
		if err := validateAudioMeta(meta); err != nil {
			t.Fatalf("expected %q to pass, got %v", meta, err)
		}
	}

	invalid := map[string]string{
		"not json":            `{"voice":true,`,
		"too long":            `{"voice":true,"duration":1,"waveform":[]}` + strings.Repeat(" ", 5000),
		"negative duration":   `{"duration":-1}`,
		"duration over limit": `{"duration":601}`,
		"too many peaks":      `{"duration":5,"waveform":[` + strings.Repeat("50,", 129) + `50]}`,
		"peak out of range":   `{"duration":5,"waveform":[101]}`,
		"negative peak":       `{"duration":5,"waveform":[-1]}`,
	}
	for name, meta := range invalid {
		if err := validateAudioMeta(meta); err == nil {
			t.Fatalf("expected %q (%s) to be rejected", meta, name)
		}
	}
}
