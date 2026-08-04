/**
 * The contract between the model and the UI.
 *
 * `ANALYSIS_SCHEMA` is handed to Gemini as a JSON schema so the response is
 * guaranteed to parse into `VideoAnalysis` instead of arriving as prose we
 * have to regex our way through.
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

export type VideoAnalysis = {
  title: string;
  language: string;
  has_speech: boolean;
  summary: string;
  explanation: string;
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
    title: str("A short punchy title for this video. Max 8 words."),
    language: str(
      "Primary spoken language, e.g. 'Arabic (Egyptian)', 'English'. " +
        "Use 'None (no speech)' if nobody speaks."
    ),
    has_speech: {
      type: "boolean",
      description: "True if anyone speaks or sings.",
    },
    summary: str("One or two sentences: what this video is, at a glance."),
    explanation: str(
      "Two to four paragraphs explaining what actually happens, combining what " +
        "is seen with what is heard. Cover the point of the video, any joke, " +
        "hook or message, the tone, and anything a viewer would need context " +
        "for. Write it so someone who cannot watch the video understands it."
    ),
    transcript: {
      type: "array",
      description:
        "Timestamped transcript of every spoken line and sung lyric, in order. " +
        "Empty array if there is no speech.",
      items: {
        type: "object",
        properties: {
          start: str("Start time as MM:SS."),
          end: str("End time as MM:SS."),
          speaker: str(
            "Who is talking: 'Speaker 1', 'Narrator', 'Voiceover', 'Song lyrics'."
          ),
          text: str("Exactly what is said, in the original spoken language."),
          text_en: str(
            "English translation. If the original is English, repeat it verbatim."
          ),
        },
        required: ["start", "end", "speaker", "text", "text_en"],
      },
    },
    scenes: {
      type: "array",
      description: "Chronological visual breakdown. Between 3 and 12 entries.",
      items: {
        type: "object",
        properties: {
          start: str("Start time as MM:SS."),
          end: str("End time as MM:SS."),
          description: str(
            "What is visually happening: people, actions, setting, camera work, " +
              "notable objects, edits and transitions."
          ),
        },
        required: ["start", "end", "description"],
      },
    },
    on_screen_text: {
      type: "array",
      description:
        "Captions, overlays, stickers, subtitles or any text burned into the " +
        "frame. Empty array if there is none.",
      items: {
        type: "object",
        properties: {
          time: str("When it appears, as MM:SS."),
          text: str("The text exactly as shown on screen."),
        },
        required: ["time", "text"],
      },
    },
    audio_notes: str(
      "Non-speech audio: background music and its mood, sound effects, silence. " +
        "Name the track or artist if you recognise it."
    ),
    hashtags: {
      type: "array",
      description: "Three to eight relevant hashtags, without the # symbol.",
      items: { type: "string" },
    },
  },
  required: [
    "title",
    "language",
    "has_speech",
    "summary",
    "explanation",
    "transcript",
    "scenes",
    "on_screen_text",
    "audio_notes",
    "hashtags",
  ],
} as const;

export const SYSTEM_INSTRUCTION = `You are a video analyst. You are given a short-form social video (Instagram Reel or TikTok) and you must understand BOTH its visuals and its audio.

Rules:
- Transcribe speech verbatim, including filler words and slang. Do not clean it up, do not paraphrase, do not summarise it into the transcript field.
- Keep the original language in "text". Put the English translation in "text_en".
- If the audio is music with lyrics, transcribe the lyrics and mark the speaker as "Song lyrics".
- Timestamps are MM:SS and must be within the video's real duration.
- Read text that appears on screen, including hard-coded captions and stickers.
- In "explanation", say what actually happens and why it is interesting, funny, or persuasive. Describe visual gags, reactions, and edits that the transcript alone would miss.
- Never invent dialogue you cannot hear. If audio is unintelligible, write "[inaudible]".
- If nobody speaks, set has_speech to false and leave transcript empty, but still fill in scenes and explanation.`;

export const USER_PROMPT = `Analyse this video completely.

1. Transcribe all speech and lyrics with timestamps, in the original language, plus an English translation.
2. Break the video down scene by scene, describing what is visually happening.
3. Capture any text shown on screen.
4. Describe the background audio and music.
5. Explain what happens in the video and what its point is.

Return the result using the required JSON schema.`;
