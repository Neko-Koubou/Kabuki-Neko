# Accessibility verification

This page records what has been verified for accessibility and responsive layout, how, and what
is still unverified (Design §7, §9; SA §8.3; US-09, US-18, US-21).

**This is not a WCAG conformance claim or certification.** Automated tools find only part of the
issues. Items marked _not verified_ have not been checked by a person with the relevant assistive
technology and must not be reported as passing.

## Automated evidence

Recorded on 2026-11-11. Production web build (`next build` + `next start`) and API, Chromium
(Playwright), axe-core 4.14.0.

| Check                                                                                                                                                              | How                                                              | Result             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------ |
| axe WCAG 2.0/2.1/2.2 A + AA on every route group                                                                                                                   | `tests/e2e/accessibility.spec.ts`                                | Pass, 0 violations |
| Light and dark theme, rejected sign-in state                                                                                                                       | same                                                             | Pass               |
| Open dialog (M09), host M09 Remove, player M01                                                                                                                     | same                                                             | Pass               |
| Host lobby, question, reveal, finished; player lobby, every answer type, reveal, finished; report detail                                                           | same                                                             | Pass               |
| Keyboard only (no pointer events): guest join, all six answer types (Enter/Space, typed Enter, puzzle move buttons), host Start/Next/Podium and Remove through M09 | same                                                             | Pass               |
| Destructive dialog starts on Cancel, Tab/Shift+Tab stay inside, Escape closes and returns focus                                                                    | same                                                             | Pass               |
| Studio slide reorder by keyboard, focus kept on the moved slide                                                                                                    | same                                                             | Pass               |
| No horizontal scroll at 320, 390, 768, 1280 px (public, auth, dashboard, studio)                                                                                   | `tests/e2e/responsive.spec.ts`                                   | Pass               |
| 200% zoom (640×450 CSS px at scale 2), same routes                                                                                                                 | same                                                             | Pass               |
| Japanese and Simplified Chinese at 320 px                                                                                                                          | same                                                             | Pass               |
| German (long text) and Arabic (RTL) at 320 px                                                                                                                      | `tests/e2e/localization.spec.ts`                                 | Pass               |
| Projector stage at 1280×720 and 1920×1080: question and all four answers on screen without scrolling                                                               | `tests/e2e/responsive.spec.ts`                                   | Pass               |
| `prefers-reduced-motion: reduce`: no running animation or transition (landing, join, About)                                                                        | same                                                             | Pass               |
| Reduced motion in podium/results (no confetti, everything at once)                                                                                                 | `podium.spec.tsx`, `result-chart.spec.tsx`                       | Pass               |
| Answer colors identical in both themes, solid, with shape + letter + text                                                                                          | `theme-provider.spec.tsx`, `choice-answer-pad.spec.tsx`          | Pass               |
| Live regions (status/alert) and focus management of components                                                                                                     | component tests listed in `tests/e2e/fixtures/ui-state-cases.ts` | Pass               |

### Fixed during this verification

- **Contrast of primary-colored text.** The CTA crimson `#D9381E` was also used as link and
  active-navigation text. It measures 4.43:1 on the canvas and 4.21:1 on `subtle`, below AA
  (4.5:1). Text now uses a separate `--primary-text` token:
  - light `#C2311A`: 5.36:1 on canvas, 5.10:1 on subtle, 5.60:1 on panel;
  - dark `#FF8A75`: at least 4.55:1 on every dark surface.

  Buttons keep the brand crimson with white text (4.63:1). Guarded by `theme-provider.spec.tsx`.

- **Language control on the game stages.** Design §3 asks for a language control on the host and
  player stages. It is now there, outside the reconnect overlay, so it also works while offline
  (TASK-172).

## Manual checks (people and real assistive technology)

| Item                                                                                                                                                                                    | Status       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Screen reader announcements (NVDA + Firefox, JAWS + Chrome, VoiceOver iOS/macOS, TalkBack): join, every answer type, results, timer announcements, host moderation, report tables       | Not verified |
| Screen reader reading order and labels of the studio editor                                                                                                                             | Not verified |
| IME composition on real devices (Japanese, Chinese, Korean keyboards) for typed answers and studio fields. Automated: Enter during composition does not submit (`text-puzzle.spec.tsx`) | Not verified |
| Mobile virtual keyboard: inputs stay visible, safe areas (notch, home indicator) do not cover controls                                                                                  | Not verified |
| Switch access and voice control                                                                                                                                                         | Not verified |
| Windows High Contrast / forced colors                                                                                                                                                   | Not verified |
| Projector readability from the back of a real room (size, glare)                                                                                                                        | Not verified |

When an item is checked, record the date, browser or device, assistive technology and version,
the person, and the result here.

## Content alternatives and known exceptions

- **Media alternatives are the creator's responsibility.** The studio flags a missing alt text,
  transcript or caption on an attachment (`media-preview.spec.tsx`, `question-properties.spec.tsx`),
  but it cannot write them. A quiz can be hosted without them, so games may contain images or
  videos without alternatives. This is a known gap that depends on the content, not a defect the
  app can fix.
- **Essential timing.** Timed questions are the core of a live competition, and the timer is
  shared by everyone in the room, so there is no per-person extension (WCAG 2.2.1 essential
  exception). The host chooses 5, 10, 20 or 30 seconds per question before playing, can skip
  time, and the reveal never depends on audio or animation alone.
- **Projector mode** shows shapes and letters on players' devices. The question text is on the
  shared screen, and "Show question text on this device" puts it on the player's own screen as
  well (`player.spec.ts`).
- **Audio** is optional: every cue has a visual equivalent, and nothing starts before a user
  gesture. Mute and volume work by keyboard (`AudioController.spec.tsx`).

## How to re-run

```bash
pnpm test:e2e tests/e2e/accessibility.spec.ts tests/e2e/responsive.spec.ts
```
