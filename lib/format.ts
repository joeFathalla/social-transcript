/**
 * Pre-joined plain-text versions of the analysis.
 *
 * The structured arrays are the right shape for a UI, but a workflow tool
 * pushing this into Notion or a message almost always wants flat text. Doing
 * the joining here saves every consumer from writing the same Code node.
 */

import type { VideoAnalysis } from "./analysis";

export type PlainText = {
  /** "[00:00] Speaker 1: …" per line, original language. */
  transcript: string;
  /** Same, English. */
  transcriptEnglish: string;
  /** "[00:00–00:06] description" per line. */
  scenes: string;
  /** "[00:02] text" per line. */
  onScreenText: string;
  /** Everything, in the order a human would read it. */
  full: string;
};

export function toPlainText(a: VideoAnalysis): PlainText {
  const transcript = a.transcript
    .map((t) => `[${t.start}] ${t.speaker}: ${t.text}`)
    .join("\n");

  const transcriptEnglish = a.transcript
    .map((t) => `[${t.start}] ${t.speaker}: ${t.text_en}`)
    .join("\n");

  const scenes = a.scenes
    .map((s) => `[${s.start}–${s.end}] ${s.description}`)
    .join("\n");

  const onScreenText = a.on_screen_text
    .map((o) => `[${o.time}] ${o.text}`)
    .join("\n");

  const sections = [
    `# ${a.title}`,
    a.summary,
    "## What happens",
    a.explanation,
    transcript && "## Transcript",
    transcript,
    scenes && "## Scenes",
    scenes,
    onScreenText && "## On-screen text",
    onScreenText,
    a.audio_notes && "## Audio",
    a.audio_notes,
  ].filter(Boolean);

  return {
    transcript,
    transcriptEnglish,
    scenes,
    onScreenText,
    full: sections.join("\n\n"),
  };
}
