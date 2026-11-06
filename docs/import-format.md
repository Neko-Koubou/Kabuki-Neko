# Quiz import and export

JSON exports use UTF-8 and the filename `<quiz UUID>.kabukineko.json`. Import accepts JSON or RFC4180 CSV, with an optional UTF-8 BOM. Files must be at most 5 MiB, with at most 200 questions, JSON depth 12 and 100,000 JSON nodes. An import creates a new PRIVATE quiz with new question and option IDs. Incomplete drafts are supported; they must be completed before hosting.

JSON preserves all six question types, correct answer flags, puzzle order, explanations and accessibility metadata. Exported media URLs are informational: the server never downloads them. Export contains no account identifiers, credentials or source question/option IDs. The example below is a valid empty draft:

```json
{
  "format": "kabukineko.quiz",
  "schemaVersion": 1,
  "quiz": {
    "title": "My imported quiz",
    "description": null,
    "visibility": "PRIVATE",
    "bgmTrack": "random",
    "coverMediaRef": null
  },
  "media": [],
  "questions": []
}
```

Each question has these required fields (nullable fields remain present):

```json
{
  "type": "SINGLE_CHOICE",
  "promptText": "Which number is even?",
  "mediaRef": null,
  "externalVideoUrl": null,
  "videoStartSec": 0,
  "videoEndSec": null,
  "mediaRevealMode": "NONE",
  "timeLimitSec": 20,
  "pointsMultiplier": 1,
  "explanationText": null,
  "accessibility": {
    "altText": null,
    "transcript": null,
    "captions": [],
    "visualDescription": null
  },
  "options": [
    { "optionText": "2", "isCorrect": true, "sortOrder": 0 },
    { "optionText": "3", "isCorrect": false, "sortOrder": 0 }
  ]
}
```

CSV requires these exact 17 headers in this order. LF and CRLF are accepted; use double quotes around cells containing commas, newlines or quotes, and double any quotes inside those cells.

```csv
schema_version,quiz_title,quiz_description,bgm_track,question_index,type,prompt_text,time_limit_sec,points_multiplier,media_ref,external_video_url,video_start_sec,video_end_sec,media_reveal_mode,explanation_text,options_json,accessibility_json
1,My quiz,,random,0,SINGLE_CHOICE,Which number is even?,20,1,,,0,,NONE,,"[{""optionText"":""2"",""isCorrect"":true,""sortOrder"":0},{""optionText"":""3"",""isCorrect"":false,""sortOrder"":0}]",
```

`question_index` starts at zero and increases by one. Repeat the same title, description and BGM on every row. Empty nullable fields become null; empty `video_start_sec` becomes zero. Empty `accessibility_json` uses the null/empty-array defaults. CSV has no cover field and imports as PRIVATE. `options_json` and nonempty `accessibility_json` must be valid JSON; expressions are never evaluated.

| Type            | Complete playable options                                 |
| --------------- | --------------------------------------------------------- |
| SINGLE_CHOICE   | 2–4 options, exactly one `isCorrect: true`                |
| TRUE_FALSE      | Two options, exactly one correct                          |
| MULTIPLE_SELECT | 2–4 options, at least one correct                         |
| TYPE_ANSWER     | 1–20 accepted texts, all correct; `sortOrder: 0`          |
| ORDER_PUZZLE    | Four options with `sortOrder` a permutation of 0, 1, 2, 3 |
| POLL            | 2–4 options, none correct, `pointsMultiplier: 0`          |

Incomplete prompts/options/key counts are draft warnings. Invalid types, ranges, duplicate normalized option texts and unauthorized media reject the import. Question-specific accessibility is independent of library metadata.

For JSON media, add a descriptor to `media` for every referenced asset, using `ref`, `mimeType`, `originalName`, `publicUrl` and `accessibility`. Use that UUID in `coverMediaRef` or question `mediaRef`; CSV uses `media_ref`. A same-instance asset may be reused only when owned by the importing account and READY. Otherwise upload a copy first and provide a `mediaMap` object mapping exported UUIDs to your local READY UUIDs:

```json
{
  "11111111-1111-4111-8111-111111111111": "22222222-2222-4222-8222-222222222222"
}
```

At most 201 mappings are allowed. A PUBLIC quiz export does not grant access to another creator's media library. Use explicit mapping for import, or the authorized Duplicate action to preserve existing references. External video URLs must match the supported canonical YouTube formats.

Malformed syntax produces a 400 response; unsupported versions and validation/reference errors produce 422; exceeded resource limits produce 413. Import diagnostics include up to 200 issues and `params.actual` for the total. CSV paths use physical record numbers including the header, for example `rows.3.options_json.1.isCorrect`, with row and column parameters. Validation completes before persistence; import does not create a partial quiz.
