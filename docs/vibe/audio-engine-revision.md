# Audio engine revision — 2026-10-31

Status: **Approved implementation scope from user; implementation and release evidence pending.** This addendum supersedes conflicting audio requirements in 01-prd, 02-design-spec, 03-system-analysis and the original TASK-014/114/130. Other gameplay/scoring/accessibility requirements remain applicable. Execute atomic tasks in 04-tasks.md and commit each verified task.

## Source inventory and attribution

Authoritative input: `audio-assets/kabuki-neko-audio/`, with `CREDITS.md`. Inspection found **20 MP3 files**: lobby4, thinking3, leaderboard1, podium2, SFX10. The local `audio-manifest.json` is a legacy input reference, not the output contract: it has a `phases` wrapper, scalar MP3 URLs, puzzle rate1.18 and nonlooping buildup; the new generated manifest replaces those values. Preserve source files. Generate only entries backed by real files; no invented fifth lobby track or legacy four-file baseline.

Credits must be copied to public audio output, included in repository attribution and visible via the homepage footer/admin About. Existing source credits contain `hhttps://` for puzzle and `https://https://` for buildup; correct these only as documented source-link repairs. Ten SFX currently share a general library link, not individual composer/source records. Record that gap honestly and reconcile provenance before release; do not invent composers or claim verification merely because a credits file exists. An attempted read of the linked OpenTracks license on 2026-10-31 was unavailable through browsing, so source-specific permission is not independently verified yet. Development/conversion can proceed; publication must respect actual asset terms.

The official code license remains Apache 2.0 + Commons Clause. The owner's broader Non-Commercial / No-Resale intent is not automatically equivalent to the official clause. Preserve official texts and distinguish the policy intent from enforceable license terms until the outstanding legal wording decision is resolved. Audio copyrights remain separate. Do not copy an inaccurate blanket license claim into the UI as a verified fact.

## Optimization and output contract

- Root command `pnpm run audio:optimize` invokes `node scripts/optimize-audio.mjs`. Require ffmpeg with libopus/libmp3lame and ffprobe; report missing prerequisites clearly. Both binaries were absent from PATH at this inspection.
- Scan all five phase subfolders for real MP3 inputs, reject symlinks/unsafe names/collisions, sort stable output. Lobby is dynamic (3,4,N); required thinking/leaderboard/podium/SFX cues must exist. Empty lobby or missing required cue is a useful error, not successful empty output.
- Preserve subfolders under `apps/web/public/audio/`. For each input create `.webm` first source (Opus96kbps VBR), `.mp3` second source (LAME128kbps). BGM uses `loudnorm=I=-16:TP=-1.5:LRA=11`; apply consistent normalization to both encodings. SFX retains transients, without BGM loudnorm. No arbitrary shortening of supplied assets.
- Use child-process argument arrays without a shell; no network fetch. Stage all output, validate codecs/decodability/durations, then publish a complete output directory so a failed conversion cannot leave a manifest referencing missing pairs. Re-runs remove stale generated entries without touching source files. Generated media/manifests/credits remain ignored build artifacts; source inputs must be provisioned for CI and packaging.
- Copy source `CREDITS.md` byte-for-byte. Generate root keys `lobby`, `thinking`, `leaderboard`, `podium`, `sfx` (no `phases` wrapper). Each descriptor has `src:[webmUrl,mp3Url]` and volume0..1; all BGM loop=true. Lobby entries also have id and label. No random selection during build.
- Known lobby IDs/labels/volume: kabuki / Kabuki Matsuri /.7; neko8bit / Neko 8-Bit Arcade /.7; showtime / Showtime Funk /.7; matcha / Matcha Chill Lo-Fi /.65. Derive stable IDs from other actual `bgm-lobby-<id>.mp3` files and readable fallback labels; known composer track names are metadata, not translated UI strings.
- thinking sprint .8, standard .75, puzzle .7; leaderboard groove .75; podium buildup .85 and victory .9 as manifest defaults. The choreography explicitly overrides victory playback volume to .95 (resolves the user's two supplied values).
- SFX volumes: hyoshigiStart1, nekoPop.8, questionWhoosh.9, tickLast5s.95, timeupGong1, revealBar.85, answerCorrect.9, answerWrong.85, streakFire.95, podiumSpotlight1. nekoPop throttleMs150. All ten SFX are one-shot, not looping BGM.
- Measure actual byte savings and loop behavior; do not assert a universal 50–65% saving or guaranteed seamless playback on every codec/browser.

## Shared contract, persistence and selection

`quizzes.bgm_track` / QuizCreate default is **random**. Known installed lobby IDs are selectable. Retain safe unknown/legacy IDs from older quiz/import snapshots and resolve them to random at playback, as requested; never turn a stored ID into an arbitrary asset URL. Shared audio schemas validate the complete manifest and safe same-origin dual-source paths. `/system/public-config.audioTracks` becomes the generated lobby descriptor array; it no longer exposes fabricated lobby/tick/reveal/podium fields. API packaging uses the same verified generated manifest as web.

Select a random lobby entry once per host session lobby lifetime with `Math.floor(Math.random()*lobby.length)` only for random/unknown ID; re-render/reconnect does not re-roll. A specific installed ID plays directly. `cycleNextLobbyTrack()` advances stable manifest order with a deliberate500ms crossfade. Persist `currentLobbyTrackId` for display/history, but a new random session must still make a new pick. All selection after this initial random pick follows authoritative state.

QUESTION_ANSWERING selection precedence: ORDER_PUZZLE OR duration>=60 => puzzle; otherwise duration<=15 => sprint; otherwise standard. Existing supported duration enum remains5/10/20/30/60/90/120/240; do not add unsupported16–45 values just for audio. For future gap durations46–59, the explicit fallback is standard.

For total duration>=10, crossing into the final5s applies rate1.22 once; tick once per actual displayed second5,4,3,2,1. Dedup by session/question/phaseVersion/second. Recovery/hidden-tab jumps use current remaining time without replaying missed ticks. A 5s question has no hurry-up rate/ticks. Stop at input deadline0 (not grace-end), or earlier authoritative reveal, and reset rate1.0. Local clock never changes the answer acceptance deadline. Player never gets tick SFX.

## Choreography and role matrix

| Trigger | Host | Player |
| --- | --- | --- |
| Gesture unlock | One-shot pointer/click/keydown listener resumes Howler context; explicit retry if blocked | Touch/pointer gesture resumes context; no unsolicited playback |
| Avatar randomize | — | nekoPop |
| LOBBY | Selected looping lobby BGM | No BGM |
| player joined | nekoPop, at most1/150ms across burst | nekoPop once for own successful join |
| GAME_START_COUNTDOWN | Fade lobby400ms then hyoshigiStart once | No audio; optional100ms vibration |
| QUESTION_PREVIEW | Leaderboard fade-out400ms; questionWhoosh once; no BGM after fade | Silent |
| QUESTION_ANSWERING | Selected thinking BGM | PROJECTOR no BGM; STREAMER explicit opt-in toggle for thinking only; accepted local submit feedback nekoPop |
| last5s | rate1.22 and tick rules above | Visual warning only; accessible/reduced-motion treatment |
| ANSWER_REVEAL | Stop/reset thinking immediately, timeupGong; revealBar450ms later | CORRECT/PARTIAL => answerCorrect + optional[80,50,80] vibration; INCORRECT/UNANSWERED => answerWrong + optional250ms; positive result streak>=3 => streakFire350ms later |
| POLL / NOT_ELIGIBLE | Normal host reveal | No false right/wrong SFX/haptics; authoritative result controls feedback, no invented correctness |
| LEADERBOARD | groove looping, fade-in300ms | Silent |
| PODIUM | Sequence below | Existing rank1–3 gets answerCorrect exactly when its rank appears |
| Exit host/play or session replaced | Cancel timers/listeners/fades and stop BGM | Same; no dashboard audio leak |

Podium uses authoritative phase-start time:0ms buildup(.85),1200ms rank3+spotlight,3500ms rank2+spotlight,6500ms rank1+spotlight, stop buildup immediately and start victory(.95) with confetti. Skip absent ranks and never synthesize winners. Zero winners => no winner effects/victory. Reduced motion displays results immediately without flashing/confetti; audio still follows deduplicated current-state timing unless muted.

**Timing resolution:** replace old3s PODIUM duration with **8000ms** to accommodate the6500ms winner cue before FINISHED. Freeze/report finalization still starts at PODIUM entry and proceeds independently. FINISHED may retain the same final podium/victory loop until leaving the result route; it does not restart the sequence. Reconnect derives elapsed time, seeks/settles to the current stage and never replays past spotlight/reveal/streak cues. Tests cover transition at8000ms and reconnect either side of6500ms.

## Engine, preference store and UI

- Keep installed howler2.2.4/@types/howler2.2.13 unless a verified need changes them. Lazy-load Howler for live routes, preserve player bundle budget.
- Zustand persist store `apps/web/src/stores/useAudioStore.ts`, localStorage key `kabuki-neko-audio-prefs`: isMuted=false, masterVolume=.8, bgmVolume=.7, sfxVolume=.9, currentLobbyTrackId=null. Actions toggleMute/setMasterVolume/setBgmVolume/setSfxVolume and controlled lobby ID setter; validate/clamp values, SSR-safe hydration, storage denied fallback. Streamer BGM opt-in defaults off; no global room mute.
- Singleton `apps/web/src/lib/audio-manager.ts` owns active Howls outside React. Effective gain = descriptor(or cue override) × master × channel volume; mute does not reset preferences. Dedup SFX/event IDs and monotonic lastPlayedTimestamp map; strict lifecycle ownership so stale StrictMode cleanup cannot stop a new route's session.
- At most one steady BGM. The only permitted overlap is the requested bounded500ms crossfade with an outgoing handle that is stopped/unloaded on completion or interruption. Never overwrite active handles while leaving old loops alive. Preview shares manager ownership and stops on dialog close/navigation/live playback.
- `apps/web/src/hooks/useAudioEngine.ts` maps authoritative role/session/phase/timing/results to manager actions; typed event signals for joins/avatar/submit, optional vibration feature detection. Cancel delayed callbacks by generation, not only clearTimeout; hidden tab/reconnect/fast skip cannot play stale effects. Keep explicit Enable Audio/retry when autoplay/decode fails; gameplay continues visually.
- `apps/web/src/components/host/AudioController.tsx`: top-right mute (M shortcut ignored in inputs/editors/modifier combinations), BGM/SFX sliders in accessible popover, lobby title and Next BGM button only in LOBBY. Streamer opt-in control on player with understandable local-only copy.
- `apps/web/src/components/studio/QuizSettingsModal.tsx`: Lobby BGM default Random + real manifest lobby choices with exclusive Preview controls. Save ID to quiz draft; no preview autoplay. Use this component in place of old planned quiz-metadata-dialog filename.
- `apps/web/src/components/common/CreditsModal.tsx`: homepage/footer and admin sidebar access, safe markdown/text rendering from packaged credits (no raw HTML/script), external links safe, visible code license/audio license separation; loading/empty/ideal/partial/error and keyboard focus states. Attribution also appears in repo notices. Do not label Commons Clause as blanket noncommercial legal coverage without resolving the documented gap.
- Add all user-facing controls, statuses/errors/aria labels to message-contracts and all six catalogs; credits/official license text preserve original attribution language.

## Verification and task ownership

| Scope | Tasks | Required evidence |
| --- | --- | --- |
| Shared descriptor/default/timing corrections |016B,016C,019,023,028,031–033| strict schemas; random default; no legacy URLs;8s podium |
| Source conversion and credits |114,114A,115|20 inputs→40 decodable outputs;3/4/N lobby fixtures; missing/invalid source/failure rollback; SHA256/provenance; credits byte copy |
| API/build distribution |073,074,174|same manifest; missing pair/hash/cue rejected; no raw pack publication inferred |
| Manager/store/hook |130,130A|fake Howler and clock: deterministic state, throttle, no overlap except crossfade, unlock denial/retry, StrictMode, reconnect, timer cancellation |
| UI/localization |130B,130C,132,137,149,150,155–160|selectors, safe credits,10 SFX role matrix, sparse winners, muted/volume storage and shortcut tests |
| Browser audio evidence |160A,174,181|chromium/firefox/webkit + MP3 fallback simulation; real gesture/playback/seek/rate; no phantom decode/loop claims; actual iOS manual evidence unverified until run |

## Inspected input checksums (SHA-256)

| File | SHA-256 |
| --- | --- |
| `01-lobby/bgm-lobby-kabuki.mp3` | `84e242467b76ab0dc5af06aec3feb313c6ab6e474d4892bbbda37346c3e205cd` |
| `01-lobby/bgm-lobby-matcha.mp3` | `20646812638e795c609a2574c745418be512f5189d46f5f5d2e7896bff3f3842` |
| `01-lobby/bgm-lobby-neko8bit.mp3` | `a13fb4cde21bce4fe3c32ecbb388742e5ef416da612b6f1e6b529e0a4c4874c3` |
| `01-lobby/bgm-lobby-showtime.mp3` | `3fbf55e57777abd7801912ea9938e53c03befd55dd0f2720b021a7270874be22` |
| `02-thinking/bgm-think-puzzle.mp3` | `59083d3365281346e20fad655157000f5e745eca8bff23b01c11d12c4eae3a26` |
| `02-thinking/bgm-think-sprint.mp3` | `e3df71f3295ad801c6177e75dd4e328a8820790888b590277f526e12786b76a8` |
| `02-thinking/bgm-think-standard.mp3` | `bb47a7c1943a6ebc10abf425c844ad94c0c667a5cc18f122294f4b8dca50da01` |
| `03-leaderboard/bgm-leaderboard-groove.mp3` | `154e6a8eb8fb3a58d57bbfaac8ae5deddfb361781f2b1ca3e7dc5bd86aaacf2c` |
| `04-podium/bgm-podium-buildup.mp3` | `0d76cb6cecd0652a38e347ecf2a4a915837a31a04267766ba773b3fc980390ef` |
| `04-podium/bgm-podium-victory.mp3` | `4764255bde27feaa547749631daac5e2d4d72a1615ae4e58a07530546b058672` |
| `05-sfx/sfx-answer-correct.mp3` | `e94301a555dfce24900d7abaaa893334097ec9655aa621124b04fd9c33e4d6db` |
| `05-sfx/sfx-answer-wrong.mp3` | `4c02589a6a598ec1e4b665abac52a67cf5b49fb874cf72f1728d8aea2b79b1e9` |
| `05-sfx/sfx-hyoshigi-start.mp3` | `daf1e106dc295082358b689101533655b76779fd9a24f2be8b5edf684eb9d884` |
| `05-sfx/sfx-neko-pop.mp3` | `a4fae393fad93cd24c6902ca9d5914986353139e4751585caea62bad290f2472` |
| `05-sfx/sfx-podium-spotlight.mp3` | `ee48934885f0ca34c69b4bc4284b3c214d15585e86cf489c262c5220bc0f36bc` |
| `05-sfx/sfx-question-whoosh.mp3` | `c7655219637304c269eca65e880b6bf41ce5b0419c4125b53e691be9f3d93bc3` |
| `05-sfx/sfx-reveal-bar.mp3` | `beb816685abf3cb658c1a0999576cf9ae8ab95c961b400e8546d8d49ace8f24f` |
| `05-sfx/sfx-streak-fire.mp3` | `03d23f5ad2ffc8c09d511c22c84fbae8dac62ca2db225ba9e58a0e60ee1567b0` |
| `05-sfx/sfx-tick-last5s.mp3` | `452508dde277a3f3ec6511773d2c2f363b4152b6d0480be5b010456acb37da90` |
| `05-sfx/sfx-timeup-gong.mp3` | `cad65f5ab04826ecd7ddddd8f70d65704780b8f219ee0ed4f692e2baf5c00fcf` |
