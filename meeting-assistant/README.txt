Meeting Cue — a companion for partial participation in meetings

English is the default interface language. Use English / 中文 in the header
to switch languages. Your choice is remembered in this browser. Switching
language keeps the meeting and user-entered content; it does not translate
existing transcript text or previously generated suggestions.

Start
Requires Node.js 22 or newer; no npm install is needed.
Double-click start.cmd. The launcher starts a local background service and
opens http://127.0.0.1:8765/ after it is ready. Reopening reuses the service.
record.cmd opens the recording page. stop.cmd exits the background service.
Use Stop session in the webpage for an ordinary pause. Export the meeting
log before stopping the background service: meeting state is held in memory.
Feedback is saved separately in data/feedback and survives a restart.
If configuration or backend code changed, restart the service to load it.
The assistant only accepts connections from the same computer.

DeepSeek configuration
Put your key after DEEPSEEK_API_KEY= in the local .env file.
Keep DEEPSEEK_BASE_URL=https://api.deepseek.com unless intentionally changed.
The model defaults to deepseek-flash. Save, export any needed meeting log,
then use stop.cmd and start.cmd. Reopening an already-running service does
not reload configuration. Never share .env or include it in a recording.
The webpage shows whether a key is configured, never the key itself.

English presentation setup
Open a fresh session after exporting any needed existing records.
Use English in the header and select English speech recognition.
Use the English rehearsal profile and the team script supplied in
../output/2026-10-23_english/. The demonstration participant is Alex.
The speaking roles are fictional demonstration roles, not team contribution claims.

Actual meeting workflow
1. Start session. Enter the participant name, responsibilities and constraints.
2. Turn on automatic analysis. New finalized transcript is submitted after
   a 4-second pause, or at most 12 seconds of continuous arrivals. Calls are
   serial. On failure the automatic mode pauses and shows a retry action.
3. Select the tested meeting-audio input. Browser microphone recognition alone
   does not capture remote teammates automatically. Wait for listening status.
4. Have a remote teammate speak. Confirm actual words appear in the transcript.
5. Inspect DeepSeek's source excerpts, edit the draft, and confirm/copy it.
6. Paste and send the message in Tencent Meeting yourself. The host must
   actually receive it and acknowledge it. Copied is not the same as sent.
7. You may then record that you sent it. That status is self-reported, not
   independently verified through a Tencent API.

Audio scope and reliability
Compatibility mode captures system audio, which may include other applications.
Application-window mode requests application audio. Select the Tencent window
and application audio in the browser picker, then confirm that choice in the
assistant. A window picture alone does not establish audio isolation. The
browser may ignore windowAudio preferences. The assistant stops if it cannot
obtain the required track and does not silently expand to system audio.
Optional microphone capture adds the local participant. Use headphones to
reduce duplicate capture. Changing audio source requires stopping capture.
Speech recognition uses the browser's service and can depend on network access.
DeepSeek receives text; its key does not activate browser speech recognition.
No automatic speaker identification is provided. Keep the assistant visible.

Record a real operation video
Open recorder.html or record.cmd. Select shared audio, and microphone if the
presenter must be audible. Start recording and choose the screen or window
in the browser prompt. A screen can show both Tencent Meeting and the assistant.
The screen recorded for presentation and the assistant's audio source are
separate choices. Make a 10-second test and play it back before the full run.
Keep the recording tab open, perform the meeting workflow, then stop and save
the WebM. Closing or refreshing the tab loses unsaved recording data.
The recorder saves locally and does not upload a recording.
The English team script specifies the speech, editing and receipt confirmation.
No completed live-meeting video is supplied until that actual run is recorded.

Feedback
Use Feedback after trying the prototype. State a specific moment, what
happened and what you expected. Experience type distinguishes operation from
watching a demonstration or reading a description. Optional context contains
counts/input type, not meeting text, private background or credentials.
Feedback stays on the submitting computer; export it to share with the team.
Feedback records are not automatically independent participants.

Data and AI
Analysis sends the configured role/background, already received utterances,
and relevant recent reminder state to DeepSeek. Future rehearsal lines and
other roles' private facts are not included. Source text is data, not commands.
Original quotes and IDs stay intact when the output language changes.
There is no official embedded Tencent extension or automatic chat-send API.
This is a local web companion. Functional tests do not establish user benefit.

Checks
npm test uses test providers and does not spend model API credit.
node scripts/check-deepseek.mjs makes one actual request with fictional data.
It does not change the active webpage meeting or print the API key.

Files
public/       Interface, speech input, recorder and localization
server.mjs    Local session service
deepseek.mjs  Model request, prompt and output validation
rehearsal/    English and Chinese rehearsal fixtures
test/         Automated checks
data/feedback Local submitted feedback, excluded from version control
README.zh.txt Historical Chinese operating notes

When sharing the code, exclude .env, logs, test-output, private exports and
data/feedback. The presentation pack contains neither credentials nor research
participants' raw responses.
