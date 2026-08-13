/**
 * The contract between the model and the UI.
 *
 * `ANALYSIS_SCHEMA` is handed to Gemini as a JSON schema so the response is
 * guaranteed to parse into `VideoAnalysis` instead of arriving as prose we
 * have to regex our way through.
 *
 * FIELD ORDER IS PART OF THE PROMPT. The model emits fields in the order they
 * are declared, so the schema is arranged to make it transcribe and extract
 * before it composes: raw speech and on-screen text first, then the specifics,
 * then the steps, and only then the written document. Reordering these fields
 * changes the output quality, not just the JSON layout.
 */

export type TranscriptSegment = {
  /** MM:SS */
  start: string;
  /** MM:SS */
  end: string;
  speaker: string;
  /** Verbatim, in whatever language was spoken. */
  text: string;
  /** English translation (identical to `text` when already English). */
  text_en: string;
};

export type Scene = {
  start: string;
  end: string;
  description: string;
};

export type OnScreenText = {
  time: string;
  text: string;
};

/** What kind of tech video this is — decides the shape of the deliverable. */
export type ContentType = "ai_skill" | "tech_guide" | "other";

export type Step = {
  number: number;
  /** MM:SS in the video where this step starts. */
  timestamp: string;
  title: string;
  detail: string;
  /** Exact commands, code, or config shown for this step. */
  commands: string[];
};

export type KeyDetail = {
  label: string;
  value: string;
};

export type VideoAnalysis = {
  title: string;
  language: string;
  has_speech: boolean;
  content_type: ContentType;
  /** A short Markdown orientation: subject, tools, and practical payoff. */
  brief: string;
  /** The deliverable: a skill spec, a step-by-step guide, or notes. */
  document: string;
  steps: Step[];
  requirements: string[];
  key_details: KeyDetail[];
  gaps: string[];
  transcript: TranscriptSegment[];
  scenes: Scene[];
  on_screen_text: OnScreenText[];
  audio_notes: string;
  hashtags: string[];
};

export type SourceInfo = {
  platform: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  webpageUrl: string;
};

/** Reported by the downloader before each attempt, and when one fails. */
export type AttemptInfo =
  | { phase: "trying"; attempt: number; maxAttempts: number }
  | {
      phase: "failed";
      attempt: number;
      maxAttempts: number;
      error: string;
      hint?: string;
      /** How long we'll wait before the next attempt. */
      retryInMs: number;
    };

/**
 * NDJSON events streamed by POST /api/fetch.
 *
 * `message` is always safe to render. The underlying yt-dlp error is written
 * to the server log, and only reaches the browser in `details` when
 * SHOW_DOWNLOAD_ERROR_DETAILS is turned on.
 */
export type FetchEvent =
  | { stage: "downloading"; message: string; attempt: number; maxAttempts: number }
  | {
      stage: "retrying";
      message: string;
      attempt: number;
      maxAttempts: number;
      retryInSeconds: number;
      details?: string;
    }
  | {
      stage: "ready";
      id: string;
      mediaUrl: string;
      mimeType: string;
      sizeBytes: number;
      source: SourceInfo;
      attempts: number;
    }
  | {
      stage: "error";
      error: string;
      hint?: string;
      attempts: number;
      details?: string;
    };

/** Progress events streamed to the browser as NDJSON. */
export type Stage =
  | "queued"
  | "downloading"
  | "uploading"
  | "processing"
  | "analyzing"
  | "done"
  | "error";

export type StreamEvent =
  | { stage: Exclude<Stage, "done" | "error">; message: string; pct: number }
  | { stage: "done"; result: VideoAnalysis; source: SourceInfo | null }
  | { stage: "error"; error: string; hint?: string };

const str = (description: string) => ({ type: "string", description });

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    // --- 1. decide what this is ---------------------------------------------
    content_type: {
      type: "string",
      enum: ["ai_skill", "tech_guide", "other"],
      description:
        "Decide this FIRST; everything else follows from it. " +
        "'ai_skill' = the video teaches a capability, technique or prompt " +
        "pattern an AI agent could be instructed to carry out. " +
        "'tech_guide' = it walks through a procedure a person performs: " +
        "installing, configuring, building, deploying, wiring tools together. " +
        "'other' = neither, including pure promotion with no technique in it. " +
        "If it is genuinely both, choose 'tech_guide' when the value is in " +
        "following the steps.",
    },
    language: str(
      "Primary spoken language, e.g. 'Arabic (Egyptian)', 'English'. " +
        "Use 'None (no speech)' if nobody speaks."
    ),
    has_speech: {
      type: "boolean",
      description: "True if anyone speaks or sings.",
    },

    // --- 2. capture the raw material before composing anything ---------------
    transcript: {
      type: "array",
      description:
        "Timestamped transcript of every spoken line and sung lyric, in order. " +
        "Verbatim — filler words included, no cleaning up, no paraphrasing. " +
        "Empty array if there is no speech.",
      items: {
        type: "object",
        properties: {
          start: str("Start time as MM:SS."),
          end: str("End time as MM:SS."),
          speaker: str(
            "Who is talking: 'Speaker 1', 'Narrator', 'Voiceover', 'Song lyrics'."
          ),
          text: str(
            "Exactly what is said, in the original spoken language. Use " +
              "'[inaudible]' for anything you cannot make out."
          ),
          text_en: str(
            "English translation. If the original is English, repeat it verbatim."
          ),
        },
        required: ["start", "end", "speaker", "text", "text_en"],
      },
    },
    on_screen_text: {
      type: "array",
      description:
        "EVERY piece of text visible in the frame: captions, overlays, " +
        "stickers, terminal output, code, config files, menu labels, dialog " +
        "boxes, browser URLs. In a tech video the real instruction is usually " +
        "here rather than in the narration, so be exhaustive. Preserve exact " +
        "casing, punctuation, flags and indentation. Use '[unreadable]' for " +
        "text that is blurred, cut off or scrolls past too fast.",
      items: {
        type: "object",
        properties: {
          time: str("When it appears, as MM:SS."),
          text: str("The text exactly as shown, character for character."),
        },
        required: ["time", "text"],
      },
    },
    scenes: {
      type: "array",
      description:
        "Chronological breakdown of what is on screen — which application, " +
        "which file, which page, what the presenter is doing. Between 3 and " +
        "12 entries.",
      items: {
        type: "object",
        properties: {
          start: str("Start time as MM:SS."),
          end: str("End time as MM:SS."),
          description: str(
            "What is visible and what is happening: the tool or screen in " +
              "view, what is being clicked, typed or changed."
          ),
        },
        required: ["start", "end", "description"],
      },
    },

    // --- 3. extract the specifics --------------------------------------------
    key_details: {
      type: "array",
      description:
        "The specifics someone rewatches a tech video to catch: model names, " +
        "CLI flags, environment variable names, file paths, URLs, package " +
        "versions, pricing, keyboard shortcuts, port numbers, exact settings. " +
        "Copy values character for character. Empty array only if the video " +
        "genuinely contains none.",
      items: {
        type: "object",
        properties: {
          label: str("What it is, e.g. 'Model', 'Config file', 'Shortcut'."),
          value: str("The exact value as shown or said."),
        },
        required: ["label", "value"],
      },
    },
    requirements: {
      type: "array",
      description:
        "Prerequisites the video states or silently assumes: tools, accounts, " +
        "API keys, versions, hardware, prior setup. Include the assumed ones — " +
        "they are the most common reason a viewer gets stuck.",
      items: { type: "string" },
    },

    // --- 4. the procedure, grounded in what you just extracted ---------------
    steps: {
      type: "array",
      description:
        "The real procedure, as discrete numbered actions. Populate this " +
        "whenever the video teaches steps, a guide, or a way to do something; " +
        "otherwise leave it empty. Do not manufacture stages for a video that " +
        "does not show a procedure. Each step must stand on its own — someone " +
        "reading only this list should be able to act.",
      items: {
        type: "object",
        properties: {
          number: {
            type: "integer",
            description: "1-based position in the sequence.",
          },
          timestamp: str("Where this step starts in the video, MM:SS."),
          title: str("Short imperative title, e.g. 'Install the CLI'."),
          detail: str(
            "What to do, in enough detail to follow without the video. Name " +
              "exact values, file paths and settings. Write UI navigation as " +
              "'Settings → Networking → Generate Domain'."
          ),
          commands: {
            type: "array",
            description:
              "Exact commands, code, config or prompt text shown for this " +
              "step, transcribed character for character — including flags, " +
              "quotes and line breaks. Never abbreviate with '...' or " +
              "substitute a placeholder when the real value is on screen. " +
              "Empty array if this step involves no typing.",
            items: { type: "string" },
          },
        },
        required: ["number", "timestamp", "title", "detail", "commands"],
      },
    },
    gaps: {
      type: "array",
      description:
        "What the video does NOT show: steps it skips, values it never " +
        "reveals, prior setup it assumes, anything cut off or unreadable, and " +
        "anything you marked '[unreadable]' above. Be honest and specific — " +
        "'never shows the contents of the config file it edits' is useful, " +
        "'some details omitted' is not. This is what stops the reader " +
        "discovering the hole halfway through. Empty array only if the video " +
        "is genuinely self-contained.",
      items: { type: "string" },
    },

    // --- 5. compose, using everything above ----------------------------------
    document: str(
      "The deliverable, in Markdown, written FROM the fields above — not from " +
        "a general memory of the video. Every command in it must already " +
        "appear in 'steps' or 'key_details'. For an AI skill, turn the " +
        "demonstrated capability into reusable instructions an agent can " +
        "execute — never merely summarize the video.\\n\\n" +
        "If content_type is 'ai_skill', follow this skeleton:\\n" +
        "# <skill name>\\n" +
        "## Purpose — one line: what carrying out this skill achieves\\n" +
        "## When to use — the situations that should trigger it\\n" +
        "## When not to use — where it does not apply or will mislead\\n" +
        "## Inputs — what the agent needs before starting\\n" +
        "## Procedure — numbered imperative instructions to the agent\\n" +
        "## Prompts and settings — verbatim, in fenced code blocks\\n" +
        "## Output — what the agent should produce, and in what format\\n" +
        "## Failure modes — what goes wrong, how to notice, how to recover\\n" +
        "Write in the imperative, addressing the agent directly ('Read the " +
        "file, then…'), so the document can be handed to an agent unedited.\\n\\n" +
        "If content_type is 'tech_guide', follow this skeleton:\\n" +
        "# <what you will end up with>\\n" +
        "## Outcome — what works once you are done\\n" +
        "## Prerequisites\\n" +
        "## Steps — numbered; commands in fenced blocks; UI paths as " +
        "'Menu → Submenu → Item'\\n" +
        "## Verify — how to confirm each stage worked\\n" +
        "## Troubleshooting — only problems the video actually mentions\\n\\n" +
        "If content_type is 'other', write brief structured notes on what the " +
        "video shows and stop.\\n\\n" +
        "THE BAR: a competent engineer who has never seen this video should " +
        "reach the same result from this document alone, without asking a " +
        "single question. Anything they would have to guess belongs in 'gaps', " +
        "not glossed over here."
    ),
    brief: str(
      "A concise Markdown orientation shown first to the user. Use exactly " +
        "these three bullets: '**About:** …', '**Tools used:** …', and " +
        "'**You will gain:** …'. State only tools visible or clearly named in " +
        "the video. Explain the practical result a viewer can achieve; do not " +
        "repeat the steps or refer to an Overview."
    ),
    title: str(
      "A short, specific title for the artefact — what it achieves, not what " +
        "the video is called. Max 10 words. 'Deploy a Next.js app to Railway' " +
        "beats 'Amazing deployment trick'."
    ),

    // --- 6. incidental --------------------------------------------------------
    audio_notes: str(
      "Non-speech audio: background music and its mood, sound effects, " +
        "silence. Brief — this rarely matters for a technical video."
    ),
    hashtags: {
      type: "array",
      description:
        "Three to eight topic tags for filing this — tools, languages, " +
        "platforms. Without the # symbol.",
      items: { type: "string" },
    },
  },
  required: [
    "content_type",
    "language",
    "has_speech",
    "transcript",
    "on_screen_text",
    "scenes",
    "key_details",
    "requirements",
    "steps",
    "gaps",
    "document",
    "brief",
    "title",
    "audio_notes",
    "hashtags",
  ],
} as const;

export const SYSTEM_INSTRUCTION = `You are a technical analyst. You are given a short-form video (Instagram Reel or TikTok) about technology, and you must READ THE SCREEN as carefully as you listen. In tech videos the commands, code, config and settings are almost always shown rather than spoken — a transcript alone captures almost none of the value.

Your output is not a description of the video. It is the artefact the video was trying to deliver, complete enough that nobody needs to watch it.

FIRST DECISION: AI SKILL OR GUIDE
Before anything else, decide whether the video demonstrates a repeatable capability that an AI agent could be instructed to perform. Choose "ai_skill" only when you can turn the demonstrated technique into a useful, bounded skill with clear inputs, procedure and output. If it instead teaches a person how to use software or complete a practical task, choose "tech_guide". A video can have steps without being an AI skill. Choose "other" when it has neither a reproducible AI capability nor a practical procedure.

WORK IN SCHEMA ORDER
The fields are ordered deliberately. Fill them in the order given. Transcribe and extract first; compose last. When you reach "document", write it from what you have already put in "transcript", "on_screen_text", "key_details" and "steps" — not from a general impression of the video. Every command in the document must already appear in one of those fields.

THE BAR
A competent engineer who has never seen this video should reach the same result from "document" alone, without asking a single question. If they would have to guess at something, that guess belongs in "gaps" — never paper over it.

NEVER DO THESE
- Never invent a command, flag, path, version, model name or setting. Fabricating one command makes the whole document untrustworthy.
- Never write "the video shows", "the creator explains", "in this tutorial", "he then clicks". The document must not refer to the video at all — it stands alone.
- Never abbreviate something visible with "..." or a placeholder like "your-key-here" when the real value is on screen.
- Never silently correct a typo you see on screen. Reproduce it exactly, then mention it in "gaps".
- Never say the same thing twice in different words. "steps" is the skeleton; "document" is the full prose. They must agree, not duplicate.
- Never pad to look thorough. Completeness is the goal; length is not.

READING THE SCREEN
Short tech videos cut fast, and the real instruction is often overlay text on screen for under a second. Capture every frame containing code, a terminal, a config file, a settings panel or a menu path. Preserve exact casing, flags, quotes, punctuation and indentation. If something is blurred, cut off, or scrolls past unread, write "[unreadable]" and add it to "gaps" — do not reconstruct it from what you assume it said.

TRANSCRIPTION
Verbatim, including filler words and slang. Original language in "text", English in "text_en". Sung lyrics get the speaker "Song lyrics". Use "[inaudible]" rather than guessing. Timestamps are MM:SS and must fall inside the video's real duration.

IF THERE IS NO SUBSTANCE
Some videos are pure promotion — a result shown with no technique. Set content_type to "other", keep "document" short and factual, and say plainly in "gaps" that the video demonstrates an outcome without showing how.`;

export const USER_PROMPT = `Work through this video in schema order.

1. First, check whether this can become a reusable AI-agent skill. If not, classify whether it is a human-facing step-by-step guide or neither.
2. Transcribe the speech, then capture EVERY piece of text on screen — code, terminals, config, menus, URLs. This is where the real content is.
3. Extract the specifics: model names, flags, paths, versions, settings, shortcuts. Then the prerequisites, stated and assumed.
4. If the video contains a guide or any steps to achieve something, list those steps as numbered actions with timestamps and exact commands. Do not create steps when none exist.
5. List what the video skips, assumes or never shows clearly.
6. Write the Markdown deliverable — an AI Skill when the capability can genuinely be delegated to an agent, otherwise a practical guide when there is a procedure.
7. Finish with the short three-bullet brief: what the video is about, which tools it uses, and what the viewer will gain. This brief appears first in the product.

Do not invent anything you cannot see or hear. If you cannot read it, say so.

Return the result using the required JSON schema.`;
