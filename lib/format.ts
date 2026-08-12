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
  /** Just the deliverable — the guide or skill document, as Markdown. */
  document: string;
  /** Ordered steps as plain text. */
  steps: string;
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

  const steps = a.steps
    .map((st) => {
      const cmds = st.commands.length
        ? "\n" + st.commands.map((c) => `    ${c}`).join("\n")
        : "";
      return `${st.number}. [${st.timestamp}] ${st.title}\n   ${st.detail}${cmds}`;
    })
    .join("\n\n");

  // The document already contains its own prerequisites and steps in Markdown,
  // so repeating them here produced duplicate "## Steps" headings and a second
  // H1. Strip its leading H1 (the title is added once, above) and let it own
  // that material; `steps` stays available separately for structured use.
  const body = a.document.replace(/^#\s+.*\n+/, "");

  const sections = [
    `# ${a.title}`,
    a.brief,
    // The document is the point of a tech video, so it leads.
    body,
    a.key_details.length && "## Key details",
    a.key_details.length &&
      a.key_details.map((k) => `- ${k.label}: ${k.value}`).join("\n"),
    a.gaps.length && "## Not covered by the video",
    a.gaps.length && a.gaps.map((g) => `- ${g}`).join("\n"),
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
    document: a.document,
    steps,
    full: sections.filter(Boolean).join("\n\n"),
  };
}
