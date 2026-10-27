# Meeting Cue

[English](README.md) | [简体中文](README.zh-CN.md)

AIAA4435 Interactive AI Systems Design & Implementation course project.
Meeting Cue supports partial participation in remote meetings: it highlights
requests that need the participant, shows relevant context, and keeps the
participant in control of the final reply.

## Run the current companion

Requires **Node.js 22 or newer**. The server uses Node's built-in modules;
no `npm install` is required.

1. Clone this repository and open `meeting-assistant/`.
2. Copy `.env.example` to `.env`.
3. Put your own DeepSeek API key after `DEEPSEEK_API_KEY=` in `.env`.
   The example contains no key. Never commit this local file.
4. On Windows, double-click **Open Meeting Cue.cmd** in the repository root
   (or `meeting-assistant/start.cmd`).
5. In the browser, start a session and enter the participant's role and constraints.

For a foreground server:

```sh
cd meeting-assistant
node --env-file=.env server.mjs
```

Open <http://127.0.0.1:8765/>. English is the default; the header switches to Chinese.
Use **Close Meeting Cue.cmd** to stop the Windows background service. Export any
meeting record you need first: active meeting state is held in memory.
Restart the service after changing `.env` or backend code.

See [English instructions](meeting-assistant/README.txt) or
[中文使用说明](meeting-assistant/README.zh.txt) for audio selection, automatic
analysis, recording and feedback details.

## What is implemented

- A local browser companion alongside Tencent Meeting.
- Text input and browser-dependent speech transcription / audio capture.
- DeepSeek text analysis using participant role, responsibilities and constraints.
- Respond-now, later and awareness categories with source excerpts and editable drafts.
- Explicit confirmation/copy states, self-reported sending, session controls and feedback.

This is not an officially embedded Tencent Meeting plugin. Replies require manual
paste/send in Tencent Meeting. Browser speech recognition is separate from the
DeepSeek API. Window-audio support depends on the browser and the selected capture
source; system-audio mode may include other applications. The UI explains capture
scope. Meeting text and supplied participant context are sent to DeepSeek when
analysis runs. Local feedback and meeting exports should not be published without review.

## Repository contents

- `meeting-assistant/`: current AI companion, launchers, rehearsal material and tests.
- `prototype/`: earlier offline scripted interaction prototype; open `index.html`.
- `research/`: questionnaires, public-source evidence, model simulations and review analysis.
- `output/2026-10-23_legacy_demo/`: current presentation, three English reading copies,
  and the English-captioned earlier demo.
- `output/2026-10-23_workflow_review/`: preceding presentation focused on current workflow reviews.
- `output/proposal/` and `remote meeting.md`: proposal material.
- `CURRENT_PROJECT_STATUS.txt`: project history and current working master.

Older export folders, temporary tooling, logs, local feedback, credential files
and unrelated course assignments stay outside version control. Some historical
notes refer to these local-only files. Raw CLI stdout/stderr and connectivity
probes are also excluded; review answers and provenance records remain available.

## Presentation and evidence

The current presentation uses a **64.36-second early scripted prototype video**.
It illustrates role judgment, context recovery and local reply confirmation. It
does not demonstrate live DeepSeek analysis, speech transcription or Tencent chat
delivery. The captioned MP4 is separate from the PPT; insertion instructions are
included in the presentation folder. Slides distinguish this early recording
from the later implemented AI companion.

Research stages have different units: an initial questionnaire, 43 exploratory
records from multiple source types, 29 earlier description reviews, and 32 valid
simulated reviews of a recorded current workflow across 11 model configurations.
Model review runs are not recruited human participants or measurements of user
productivity. Provenance and limitations are retained in the research records.
See [current workflow findings](research/current_use_review_2026-10-23/findings_zh.txt)
and [analysis](research/current_use_review_2026-10-23/analysis.json).

A review-driven repair separates unsent local reply text from meeting facts in
later analysis. Actual impact on interruptions, timely replies and parallel-task
performance remains to be evaluated.

## Tests

```sh
cd meeting-assistant
node --test test/*.test.mjs
```

The full suite includes Windows launcher checks. Browser/audio behavior additionally
requires a real-device check. The earlier prototype has its own tests:

```sh
node --test prototype/core.test.cjs
```

## Team

Chi Kit WONG, Haodong XU, Sida ZHANG — Group 3.
