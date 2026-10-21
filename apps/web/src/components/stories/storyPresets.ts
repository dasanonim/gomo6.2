/** Text-story background presets. The chosen key is stored in
 * `text_style.preset`; the gradient itself lives in stories.css so themes and
 * future presets stay in one place. */
export const STORY_TEXT_PRESETS = [
  "sunset",
  "violet",
  "mint",
  "sun",
  "graphite",
  "neon",
] as const;

export type StoryTextPreset = (typeof STORY_TEXT_PRESETS)[number];

export function storyPresetBackground(preset?: string): string {
  const index = Math.max(
    0,
    STORY_TEXT_PRESETS.indexOf((preset ?? "sunset") as StoryTextPreset),
  );
  return `var(--story-text-gradient-${index + 1})`;
}
