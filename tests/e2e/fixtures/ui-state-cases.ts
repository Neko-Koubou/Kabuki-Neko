/**
 * TASK-171 five-state UI inventory (Design §6; SA §11.2) and deterministic failure fixtures.
 *
 * `UI_STATE_CASES` accounts for every inventory item in all five states (L loading, E empty, I
 * ideal, P partial/edge, X error/offline). The items are:
 * - screens S01–S17;
 * - dialogs M01–M12;
 * - base components B01–B12;
 * - feature components F01–F20.
 *
 * Each cell restates the state the design requires and names the automated verification that
 * proves it, as a file and the exact test title. That can be:
 * - a browser test (`tests/e2e`), including the new `ui-states.spec.ts` and `journeys.spec.ts`;
 * - a component, hook, store or provider test (`apps/web/src`).
 * `ui-states.spec.ts` checks that the inventory is complete and that every referenced title exists
 * in its file, so a renamed or deleted test fails the inventory instead of leaving a silent gap.
 *
 * Where the design says a state renders nothing, the evidence is the test that asserts this exact
 * behaviour: an empty notice or menu that is not rendered, a dialog that is not needed, an untimed
 * phase with no timer. A skeleton or placeholder is never faked to fill such a cell.
 *
 * The fixtures at the end (`holdRequests`, `failRequests`, `serviceUnavailable`) make API states
 * deterministic in the browser: a held response for Loading, an aborted request for an offline
 * fetch, or a 503 answer.
 */
import type { Page, Route } from "@playwright/test";

/** The five mandatory UI states. */
export const UI_STATES = ["L", "E", "I", "P", "X"] as const;
/** One state letter. */
export type UiState = (typeof UI_STATES)[number];

/** One automated verification: a spec file (repository-relative) and an exact test title. */
export interface Evidence {
  file: string;
  title: string;
}

/** One inventory cell: what the design requires and what proves it. */
export interface StateCase {
  expectation: string;
  evidence: Evidence[];
}

/** One inventory item with all five states. */
export interface InventoryItem {
  id: string;
  name: string;
  states: Record<UiState, StateCase>;
}

const WEB = "apps/web/src";
/** Spec files (repository-relative). */
const F = {
  fallback: `${WEB}/components/ui/session-fallback.spec.tsx`,
  shells: `${WEB}/components/ui/shells.spec.tsx`,
  auth: `${WEB}/components/auth/public-auth-forms.spec.tsx`,
  form: `${WEB}/components/ui/form-primitives.spec.tsx`,
  library: `${WEB}/components/studio/quiz-library-detail.spec.tsx`,
  detail: `${WEB}/components/studio/quiz-detail.spec.tsx`,
  collection: `${WEB}/components/ui/collection-primitives.spec.tsx`,
  slides: `${WEB}/components/studio/slide-navigator.spec.tsx`,
  properties: `${WEB}/components/studio/question-properties.spec.tsx`,
  fields: `${WEB}/components/studio/question-fields.spec.tsx`,
  studioStore: `${WEB}/stores/studio.store.spec.ts`,
  assets: `${WEB}/components/media/asset-library-picker-upload.spec.tsx`,
  mediaPicker: `${WEB}/components/studio/media-picker.spec.tsx`,
  importExport: `${WEB}/components/studio/import-export.spec.tsx`,
  reportList: `${WEB}/components/reports/report-list.spec.tsx`,
  answers: `${WEB}/components/reports/answer-detail-dialog.spec.tsx`,
  admin: `${WEB}/components/admin/admin-settings-health.spec.tsx`,
  users: `${WEB}/components/admin/user-invites.spec.tsx`,
  document: `${WEB}/components/ui/document-view.spec.tsx`,
  pin: `${WEB}/components/player/pin-join-scanner.spec.tsx`,
  qr: `${WEB}/lib/qr.spec.ts`,
  avatarCustomizer: `${WEB}/components/player/avatar-customizer.spec.tsx`,
  recovery: `${WEB}/components/player/connection-recovery.spec.tsx`,
  sessionRecovery: `${WEB}/hooks/use-session-recovery.spec.tsx`,
  choice: `${WEB}/components/player/choice-answer-pad.spec.tsx`,
  text: `${WEB}/components/player/text-puzzle.spec.tsx`,
  clock: `${WEB}/hooks/use-game-clock.spec.tsx`,
  lobby: `${WEB}/components/host/host-stage-lobby.spec.tsx`,
  projector: `${WEB}/components/host/question-projector.spec.tsx`,
  results: `${WEB}/components/host/result-chart.spec.tsx`,
  podium: `${WEB}/components/host/podium.spec.tsx`,
  hostConfig: `${WEB}/components/host/host-config-dialog.spec.tsx`,
  audio: `${WEB}/components/host/AudioController.spec.tsx`,
  audioEngine: `${WEB}/hooks/useAudioEngine.spec.tsx`,
  confirm: `${WEB}/components/ui/confirm-dialog.spec.tsx`,
  dialogs: `${WEB}/components/ui/dialog-primitives.spec.tsx`,
  status: `${WEB}/components/ui/status-primitives.spec.tsx`,
  media: `${WEB}/components/ui/media-preview.spec.tsx`,
  avatar: `${WEB}/components/ui/avatar-illustration.spec.tsx`,
  locale: `${WEB}/providers/locale-provider.spec.tsx`,
  e2eAuth: "tests/e2e/auth.spec.ts",
  e2eStudio: "tests/e2e/studio.spec.ts",
  e2eJoin: "tests/e2e/join.spec.ts",
  e2ePlayer: "tests/e2e/player.spec.ts",
  e2eHost: "tests/e2e/host.spec.ts",
  e2eReports: "tests/e2e/reports.spec.ts",
  e2eAudio: "tests/e2e/audio.spec.ts",
  states: "tests/e2e/ui-states.spec.ts",
  journeys: "tests/e2e/journeys.spec.ts",
} as const;

/** Titles of the browser tests in `ui-states.spec.ts` (shared with that spec). */
export const UI_STATE_TESTS = {
  inventory: "accounts for every screen, dialog and component in all five states",
  workspace:
    "S05, S08 and S09 show loading, the real empty state, a failed fetch with retry and the ideal list",
  fallback: "S06, S10 and S17 fall back safely for unknown, forbidden and signed-out access",
  admin: "S11 and S12 keep the page usable when a request fails and recover on retry",
  public: "S01 and S13 keep static content and recover when public services fail",
} as const;

/** Titles of the journey tests in `journeys.spec.ts` (shared with that spec). */
export const JOURNEY_TESTS = {
  account:
    "AC-01/02: an initialized instance sends setup to sign in and a creator registers in the UI",
  content:
    "AC-03/05/06: the creator reuses a PUBLIC quiz, imports a quiz and uploads media as WebP",
  game: "AC-04/07–13: a six-type quiz is hosted, joined, recovered after a refresh and finished",
  report: "AC-14: the report and its CSV show the game that was played",
  admin:
    "AC-15/17/19: the administrator removes only orphaned media and the About page shows the license",
  trace: "traces every user story and the five PRD §9 scenarios to verifications",
} as const;

/**
 * True when `source` declares a test titled `title`: as a string literal, or as
 * `test(UI_STATE_TESTS.<key>,` / `test(JOURNEY_TESTS.<key>,` for the shared title constants.
 */
export function declaresTest(source: string, title: string): boolean {
  if (source.includes(`"${title}"`)) return true;
  const shared = [
    ["UI_STATE_TESTS", UI_STATE_TESTS],
    ["JOURNEY_TESTS", JOURNEY_TESTS],
  ] as const;
  return shared.some(([name, titles]) =>
    Object.entries(titles).some(
      ([key, value]) => value === title && source.includes(`test(${name}.${key},`),
    ),
  );
}

/** Evidence shorthand. */
const e = (file: string, title: string): Evidence => ({ file, title });
const ws = e(F.states, UI_STATE_TESTS.workspace);
const fb = e(F.states, UI_STATE_TESTS.fallback);
const adm = e(F.states, UI_STATE_TESTS.admin);
const pub = e(F.states, UI_STATE_TESTS.public);
const jAccount = e(F.journeys, JOURNEY_TESTS.account);
const jContent = e(F.journeys, JOURNEY_TESTS.content);
const jGame = e(F.journeys, JOURNEY_TESTS.game);
const jReport = e(F.journeys, JOURNEY_TESTS.report);
const jAdmin = e(F.journeys, JOURNEY_TESTS.admin);

/** One cell. */
const c = (expectation: string, ...evidence: Evidence[]): StateCase => ({ expectation, evidence });
/** One item. */
const item = (
  id: string,
  name: string,
  L: StateCase,
  E: StateCase,
  I: StateCase,
  P: StateCase,
  X: StateCase,
): InventoryItem => ({ id, name, states: { L, E, I, P, X } });

// Frequently cited titles.
const T = {
  fallbackShell: e(
    F.fallback,
    "shows the shell at once, then the instance name, CTAs and registration by mode",
  ),
  fallbackBanner: e(
    F.fallback,
    "keeps static content with the service banner and replaces a missing mascot",
  ),
  fallbackVariants: e(F.fallback, "renders each variant with fixed text and its next step only"),
  fallbackRetry: e(
    F.fallback,
    "retries a service failure once at a time, keeps the reason and shows a safe reference",
  ),
  shellsNames: e(F.shells, "covers empty names, a missing logo (monogram) and long wrapping names"),
  authLoading: e(
    F.auth,
    "shows the loading state, then the closed state for single-admin instances",
  ),
  authRace: e(
    F.auth,
    "turns a lost race into Sign in and reconciles uncertain outcomes through setup-status",
  ),
  authErrors: e(
    F.auth,
    "shows a focused summary for invalid fields, clears only the password on rejected credentials and keeps entries on network errors",
  ),
  libSkeleton: e(
    F.library,
    "shows a skeleton, then cards with the owner's controls and the 12-per-page query",
  ),
  libEmpty: e(F.library, "separates an empty library, an empty search and a failed load"),
  libPublic: e(
    F.library,
    "keeps public quizzes of other creators read-only and sends invalid drafts to their problems",
  ),
  detailLoads: e(F.detail, "loads, then shows metadata, ordered questions and the owner's actions"),
  detailEmpty: e(
    F.detail,
    "invites the owner to add questions to an empty quiz and lists draft issues",
  ),
  detailHidden: e(
    F.detail,
    "shows one fixed message for hidden (404) and forbidden (403) quizzes, without the title",
  ),
  slidesLoading: e(F.slides, "shows loading, then the empty canvas with Add slide"),
  assetsSkeleton: e(
    F.assets,
    "shows a skeleton, then cards with the 24-per-page query, in-use badge and missing alternatives",
  ),
  assetsEmpty: e(F.assets, "covers empty, no matches and a failed load with retry"),
  assetsUpload: e(
    F.assets,
    "refuses wrong types and sizes before sending, shows progress and keeps per-file failures",
  ),
  assetsInUse: e(F.assets, "deletes through M09 and reports an in-use answer from the server"),
  reportListLoads: e(
    F.reportList,
    "loads, then shows snapshot titles, time zone, players and end reasons",
  ),
  reportListEmpty: e(
    F.reportList,
    "tells no finished games apart from no matches, and clears filters",
  ),
  reportListError: e(
    F.reportList,
    "shows a fetch failure with Retry (never as no reports), then keeps older data",
  ),
  e2eReportsList: e(
    F.e2eReports,
    "lists only ready reports, newest first, with the early-end badge",
  ),
  e2eReportFull: e(
    F.e2eReports,
    "shows the complete report, M12 answers, questions, hardest and an identical CSV",
  ),
  e2eReportEarly: e(
    F.e2eReports,
    "shows the early-ended report with zero answers and unplayed questions",
  ),
  e2eReportGate: e(
    F.e2eReports,
    "gates a report still being saved and keeps other hosts and players out",
  ),
  adminStorage: e(
    F.admin,
    "keeps unavailable storage distinct from zero and retries a failed settings panel",
  ),
  adminHealth: e(
    F.admin,
    "shows 200 and 503 health as results, other failures as errors with retry",
  ),
  adminCleanup: e(F.admin, "shows storage states and runs cleanup batches with new keys"),
  adminSave: e(F.admin, "sends only changed fields with If-Match and nothing without changes"),
  adminStale: e(F.admin, "keeps entries on a stale revision and reloads only on request"),
  usersList: e(F.users, "lists, searches and filters users, and shows empty and error states"),
  usersLastAdmin: e(
    F.users,
    "blocks demoting the last administrator and reloads the principal after a 403",
  ),
  usersInvites: e(F.users, "lists invitation statuses, filters them and revokes only active codes"),
  usersCode: e(
    F.users,
    "shows the one-time code with copy, manual copy when the clipboard fails, and forgets it on close",
  ),
  usersLost: e(F.users, "reports an unknown outcome after a lost create and without a clipboard"),
  docReal: e(
    F.document,
    "shows the real version, the official links and license text, and the audio credits",
  ),
  docUnknown: e(
    F.document,
    "says the version is unknown and keeps the official link when the sources fail",
  ),
  docGuide: e(
    F.document,
    "lists the steps, the real template and installed languages with coverage",
  ),
  docRegistry: e(F.document, "reports an unavailable registry instead of inventing languages"),
  e2eJoinLoading: e(
    F.e2eJoin,
    "shows loading, then the error state with Try again when the check gets no answer",
  ),
  e2eJoinEmpty: e(
    F.e2eJoin,
    "keeps a leading-zero PIN, shows the empty hint and never polls an unknown PIN",
  ),
  e2eJoinIdeal: e(
    F.e2eJoin,
    "checks a deep-linked PIN once, joins as a guest and rejects a duplicate nickname",
  ),
  e2eJoinLocked: e(F.e2eJoin, "explains a locked room (partial)"),
  e2eJoinCamera: e(
    F.e2eJoin,
    "falls back to manual entry when the camera is denied and refuses foreign QR codes",
  ),
  e2ePlayerEmpty: e(
    F.e2ePlayer,
    "shows the empty state without credentials and loading while the socket never answers",
  ),
  e2ePlayerGame: e(
    F.e2ePlayer,
    "plays all six input types in a Streamer room with refresh, reconnect, grace and podium",
  ),
  e2ePlayerKicked: e(
    F.e2ePlayer,
    "shows shapes first in a Projector room, text on request, and ends cleanly when kicked",
  ),
  e2eHostRoutes: e(
    F.e2eHost,
    "routes: invalid id 404, anonymous sign-in redirect, unknown session fallback",
  ),
  e2eHostGame: e(
    F.e2eHost,
    "runs a full game with duplicate-safe Next, reconnect and the ready report",
  ),
  e2eHostEarly: e(F.e2eHost, "ends early from an empty lobby and retries a failed report save"),
  e2eStudioSix: e(
    F.e2eStudio,
    "builds all six types, reorders, duplicates, deletes, saves and keeps them after a refresh",
  ),
  e2eStudioConflict: e(
    F.e2eStudio,
    "keeps the draft on a conflict from another tab and reloads the saved version on request",
  ),
  e2eStudioZero: e(
    F.e2eStudio,
    "saves a zero-slide draft, guards unsaved navigation and adapts to 320, 768 and 1280 px",
  ),
  e2eAuthSetup: e(
    F.e2eAuth,
    "first run: two tabs race the setup and exactly one SUPERADMIN exists",
  ),
  e2eAuthLogin: e(
    F.e2eAuth,
    "sign in returns to the intended page, a live session skips the form, logout ends it",
  ),
  e2eAuthRegister: e(
    F.e2eAuth,
    "registration follows the SINGLE_ADMIN, INVITE_ONLY and PUBLIC policies",
  ),
  lobbyEmpty: e(F.lobby, "shows loading, then an empty roster with Start disabled and the reason"),
  lobbyLarge: e(
    F.lobby,
    "renders 200 players in join order and announces a join without moving focus",
  ),
  lobbyOffline: e(
    F.lobby,
    "keeps the server lock state after a refused lock and pauses controls without a connection",
  ),
  podiumWinners: e(F.podium, "shows zero, one or two real winners and skips absent ranks"),
  recoveryViews: e(F.recovery, "covers empty, first sync and the live screen"),
  recoveryStale: e(
    F.recovery,
    "locks stale content while reconnecting, catching up or during a state-store outage",
  ),
  recoveryPending: e(
    F.recovery,
    "reports a pending answer as unconfirmed while syncing, never as accepted",
  ),
  recoveryTerminal: e(
    F.recovery,
    "clears credentials once on terminal outcomes (kicked, invalid/replaced token, lost) and never retries",
  ),
  importWalk: e(
    F.importExport,
    "walks the empty, loading and ideal states and opens the created quiz",
  ),
  importRows: e(
    F.importExport,
    "lists row and column problems with the total count (partial) and focuses the summary",
  ),
  importLost: e(F.importExport, "reconciles a lost response before any retry (error state)"),
  avatarSix: e(
    F.avatarCustomizer,
    "offers six styles and joins with a Unicode nickname (empty → loading → ideal)",
  ),
  avatarKeeps: e(
    F.avatarCustomizer,
    "keeps fields on forbidden names and full rooms, and retries a lost ACK with the same request id",
  ),
  avatarFriendly: e(
    F.avatarCustomizer,
    "uses a server-picked friendly nickname with its ticket (no free text)",
  ),
  formLoading: e(
    F.form,
    "Loading: pending keeps the label, stays focusable and blocks presses and submits",
  ),
  formUnavailable: e(
    F.form,
    "Empty/Error: unavailable actions are disabled, with a described reason when given",
  ),
  choiceGroup: e(
    F.form,
    "Loading/Empty/Error: pending is non-interactive, empty offers the parent action, error is described",
  ),
  dialogStates: e(
    F.dialogs,
    "renders the loading, empty, partial and error states with the close action available",
  ),
  menuEmpty: e(F.dialogs, "hides the trigger when empty and keeps it with a loading menu"),
  menuKeyboard: e(
    F.dialogs,
    "opens from the keyboard, skips disabled items, runs one action and returns focus",
  ),
  confirmGone: e(F.confirm, "shows the empty state when the target is already gone"),
  confirmNever: e(
    F.confirm,
    "never closes as success for missing, blocked, failed or ambiguous outcomes",
  ),
  skeleton: e(
    F.status,
    "is decorative with one loading label, then waits visibly, then fails with a retry",
  ),
  neverEmpty: e(
    F.status,
    "never reports a failed fetch as empty and never loads forever when idle",
  ),
  collectionStates: e(F.collection, "shows loading, stale, error and empty states honestly"),
  cardStates: e(F.collection, "renders loading, missing and error states"),
  mediaRetry: e(
    F.media,
    "renders images with their alt, reserved ratio and a retry after a load failure",
  ),
  avatarFallback: e(
    F.avatar,
    "falls back to the nickname's default for invalid or missing avatars",
  ),
  avatarLoading: e(
    F.avatar,
    "shows a stable silhouette while loading and initials when generation fails",
  ),
  hostConfigEmpty: e(
    F.hostConfig,
    "refuses quizzes without playable questions (empty) and unsaved drafts (partial)",
  ),
  hostCreate: e(
    F.hostConfig,
    "creates a quiz with the chosen track, previewing one track at a time",
  ),
  hostCreateLost: e(
    F.hostConfig,
    "reconciles a lost create response to the created quiz and keeps entries on errors",
  ),
  resultsNone: e(F.results, "covers no eligible players, nobody answering and stale results"),
  resultsExplanation: e(
    F.results,
    "shows the prompt and full explanation, with a scroll hint for long text, and closes",
  ),
  audioStates: e(F.audio, "covers loading, empty, blocked and failed states"),
  localeSwitch: e(
    F.locale,
    "hydrates with the server catalog and switches atomically after a deferred load",
  ),
  localeList: e(
    F.locale,
    "lists registry locales with native, localized and tag search and the guide link",
  ),
};

/** The complete inventory (Design §6.1–6.4). */
export const UI_STATE_CASES: InventoryItem[] = [
  // §6.1 Screens.
  item(
    "S01",
    "Landing",
    c("Shell and logo at once, instance metadata placeholder", T.fallbackShell, pub),
    c("No instance name yet → Kabuki Neko", T.shellsNames, T.fallbackShell),
    c("Join and Sign in are clear", T.fallbackShell, pub),
    c("Long name wraps; missing mascot → monogram", T.fallbackBanner, T.shellsNames),
    c(
      "Service unavailable banner + Try again; static content stays",
      pub,
      T.fallbackBanner,
      e(F.shells, "shows the error banner with retry while static content stays, then recovers"),
    ),
  ),
  item(
    "S02",
    "Setup",
    c("Setup status is checked before the form", T.authRace, T.e2eAuthSetup),
    c(
      "Not initialized → set up the instance",
      e(F.auth, "points to setup when the instance is not initialized"),
    ),
    c(
      "Two steps, then setup succeeds",
      T.e2eAuthSetup,
      e(F.auth, "collects two local steps and sends one request at the end"),
    ),
    c(
      "Finished in another tab → Sign in",
      T.e2eAuthSetup,
      T.authRace,
      e(F.auth, "turns SETUP_COMPLETE into Sign in"),
      jAccount,
    ),
    c(
      "Entries kept; field/summary errors; ambiguous result checks status first",
      T.authRace,
      e(F.auth, "shows already-initialized and status-failure states"),
    ),
  ),
  item(
    "S03",
    "Login",
    c("Submit spinner, the Sign in label stays", T.formLoading, T.authErrors),
    c("Empty form + Sign in", T.e2eAuthLogin),
    c(
      "Signed in and sent to a safe destination",
      T.e2eAuthLogin,
      e(F.auth, "signs in with password-manager hints and paste, then returns to a safe path"),
    ),
    c("Inactive account / wrong credentials → safe message", T.authErrors, T.e2eAuthLogin),
    c("Cannot sign in, try again; the password is not kept", T.authErrors),
  ),
  item(
    "S04",
    "Register",
    c("Policy loading; submit pending", T.authLoading),
    c("SINGLE_ADMIN → registration closed + Sign in", T.authLoading, T.e2eAuthRegister),
    c("CREATOR account created", T.e2eAuthRegister, jAccount),
    c(
      "Invalid/used invite or email conflict inline",
      e(
        F.auth,
        "requires an invite code on INVITE_ONLY, keeps entries when the code is used and succeeds with a new key",
      ),
      T.e2eAuthRegister,
    ),
    c(
      "Name/email kept; failure shown without promising an account",
      e(
        F.auth,
        "never sends an invite code on PUBLIC and reuses the key after an uncertain outcome",
      ),
      e(F.auth, "applies the shared password policy and maps server field details"),
    ),
  ),
  item(
    "S05",
    "Quizzes",
    c("Six skeleton cards, query aria-busy", ws, T.libSkeleton),
    c("No quizzes + Create/Import; empty search + clear", ws, T.libEmpty),
    c("Cards + pagination + scope", ws, T.libSkeleton, jContent),
    c(
      "Missing cover placeholder; long titles",
      T.libPublic,
      e(F.collection, "has one heading link, separate actions, metadata and the full long title"),
      e(F.collection, "falls back when the cover fails and supports a button heading"),
    ),
    c("Retry the list; a failed fetch is never shown as empty", ws, T.libEmpty),
  ),
  item(
    "S06",
    "Quiz detail",
    c("Heading/cover/list skeleton", T.detailLoads),
    c("Zero questions → Add questions for the owner", T.detailEmpty),
    c("Metadata + allowed actions", T.detailLoads, jContent),
    c(
      "PUBLIC quiz read-only; invalid draft warning",
      e(F.detail, "keeps public quizzes of other creators read-only"),
      T.detailEmpty,
    ),
    c(
      "Unavailable/forbidden → back, without leaking the title",
      fb,
      T.detailHidden,
      e(F.detail, "retries a failed load (error state with reference)"),
    ),
  ),
  item(
    "S07",
    "Studio",
    c(
      "Three-panel skeleton per breakpoint",
      T.slidesLoading,
      e(F.properties, "shows loading, then an empty media state with exact time values and points"),
    ),
    c("No questions yet + Add", T.slidesLoading, T.e2eStudioZero),
    c("Draft/edit/save + valid status", T.e2eStudioSix, jGame),
    c(
      "Long prompts, partial metadata, revision conflict, incomplete draft",
      T.e2eStudioConflict,
      e(F.slides, "keeps long prompts whole, labels empty prompts and jumps to a slide's problems"),
      e(F.fields, "guides an incomplete single choice, then accepts one key and flags duplicates"),
    ),
    c(
      "Save failed: draft kept, retry/resolve; Host disabled until valid and saved",
      T.e2eStudioConflict,
      e(F.studioStore, "keeps the draft and the error when a save fails"),
      e(
        F.confirm,
        "blocks navigation when the save fails, keeps the draft, and continues after a successful save",
      ),
    ),
  ),
  item(
    "S08",
    "Media",
    c("Grid skeleton / upload progress", ws, T.assetsSkeleton, T.assetsUpload),
    c("No media + Upload", ws, T.assetsEmpty),
    c("Grid, preview, select/delete by permission", T.assetsSkeleton, jContent),
    c(
      "Thumbnail failure, file in use, processing upload",
      T.assetsSkeleton,
      T.assetsInUse,
      T.assetsUpload,
    ),
    c(
      "Per-file error + retry; list failure apart from upload failure",
      ws,
      T.assetsEmpty,
      T.assetsUpload,
    ),
  ),
  item(
    "S09",
    "Reports",
    c("Table/card skeleton", ws, T.reportListLoads),
    c("No finished sessions + back to quizzes", ws, T.reportListEmpty),
    c("Host's own sessions", T.e2eReportsList, jReport),
    c("Early-ended sessions labelled; long snapshot titles", T.e2eReportsList, T.reportListLoads),
    c("Retry; a failed fetch is never 0 reports", ws, T.reportListError),
  ),
  item(
    "S10",
    "Report",
    c("KPI/table skeleton; pending finalization separate", T.e2eReportGate),
    c("No answers in this session; 0 valid players", T.e2eReportEarly),
    c("Snapshot + details + CSV", T.e2eReportFull, jReport),
    c(
      "Missing metric “—”; no-points/POLL excluded; partial labelled",
      T.e2eReportFull,
      T.e2eReportEarly,
    ),
    c(
      "Retry fetch/finalization/export separately; never an empty success",
      fb,
      T.e2eReportGate,
      T.e2eHostEarly,
    ),
  ),
  item(
    "S11",
    "Settings",
    c("Field/metric skeletons without fake defaults", adm, T.adminStorage),
    c("0 files → no files yet; health unknown → not checked", T.adminStorage, T.adminHealth),
    c("Saved settings, metrics and health", adm, T.adminSave, jAdmin),
    c(
      "One driver failing, stale values, partial cleanup",
      T.adminCleanup,
      T.adminStale,
      T.adminHealth,
    ),
    c("Form kept; retry per panel; no silent driver fallback", adm, T.adminStorage),
  ),
  item(
    "S12",
    "Users",
    c("Row skeletons; invite generation pending", T.usersList, T.usersLost),
    c("Zero invites → create; empty search → clear filter", T.usersList, T.usersInvites, adm),
    c("Users, roles, status, invites", adm, T.usersList, T.e2eAuthRegister),
    c("Long names, expired/used invites, last-admin protection", T.usersLastAdmin, T.usersInvites),
    c("Refused action keeps old data + reason; reload permissions on 403", adm, T.usersLastAdmin),
  ),
  item(
    "S13",
    "About / guide",
    c("Static text first; version placeholder", T.docReal),
    c("Version unavailable → version unknown; guides stay", T.docUnknown, pub),
    c("Attribution, official terms, package guide", pub, T.docReal, T.docGuide, jAdmin),
    c("Original text in another language is labelled", T.docReal, T.docGuide),
    c("Failed source shows retry; no invented legal text", pub, T.docUnknown, T.docRegistry),
  ),
  item(
    "S14",
    "Join",
    c(
      "Checking PIN/recovery, input disabled meanwhile",
      T.e2eJoinLoading,
      e(F.pin, "checks a deep-linked PIN exactly once, even under StrictMode"),
    ),
    c(
      "Empty PIN → enter 6 digits",
      T.e2eJoinEmpty,
      e(F.pin, "guides an empty PIN, then checks once and joins as a guest"),
    ),
    c("Valid room → M01", T.e2eJoinIdeal, jGame),
    c(
      "Leading-zero PIN; locked/full/in progress; retryAfter",
      T.e2eJoinLocked,
      T.e2eJoinEmpty,
      e(F.pin, "explains locked, full and started rooms and waits for rate limits without polling"),
    ),
    c(
      "Offline → Try again; no polling of a wrong PIN; invalid token → join again",
      T.e2eJoinLoading,
      e(F.pin, "offers Try again after an unknown result"),
      e(F.pin, "clears dead credentials and continues with a new identity"),
    ),
  ),
  item(
    "S15",
    "Player",
    c(
      "Initial sync skeleton; known phase stays while reconnecting",
      T.e2ePlayerEmpty,
      T.recoveryViews,
    ),
    c(
      "Lobby waits for the host; nothing selected → hint, Submit disabled",
      T.e2ePlayerEmpty,
      e(
        F.choice,
        "requires a selection for multiple select and sends the chosen set without hinting the key count",
      ),
    ),
    c("Phase/answer pad/results", T.e2ePlayerGame, jGame),
    c(
      "Long prompt, partial result, <3 podium, media failure, unknown ACK",
      T.e2ePlayerGame,
      T.recoveryPending,
      T.podiumWinners,
      e(
        F.media,
        "shows the clock-derived step under irregular ticks, keeps going when the image fails, and completes",
      ),
    ),
    c(
      "Reconnect banner + locked input; sync; expired/kicked → S17; never duplicate answers",
      T.e2ePlayerKicked,
      T.recoveryStale,
      e(
        F.sessionRecovery,
        "resolves a lost submit ACK by sync: accepted answers are locked and never re-sent",
      ),
      jGame,
    ),
  ),
  item(
    "S16",
    "Host",
    c("Initial sync skeleton; action pending", T.lobbyEmpty),
    c("Empty lobby → share the PIN; Start disabled", T.lobbyEmpty, T.e2eHostEarly),
    c("Stage + phase controls", T.e2eHostGame, jGame),
    c(
      "200 players, <5 leaderboard, <3 podium, some disconnected",
      T.lobbyLarge,
      T.podiumWinners,
      T.e2eHostGame,
    ),
    c(
      "Controls locked offline; host reconnect needs auth; finalization retry separate",
      T.e2eHostGame,
      T.e2eHostEarly,
      T.lobbyOffline,
    ),
  ),
  item(
    "S17",
    "Fallback",
    c("Retry busy keeps the previous reason", T.fallbackRetry),
    c(
      "No error code → general explanation + Home",
      e(F.fallback, "maps error codes and marks terminal variants"),
      fb,
    ),
    c("Safe reason + CTA for the context", T.fallbackVariants, fb, T.e2eHostRoutes),
    c(
      "Long reference copyable; signed-out variant",
      e(F.fallback, "hides unsafe references and shows shell text before route namespaces load"),
      e(F.fallback, "goes back from a forbidden page and shows the logo + language header"),
      T.fallbackRetry,
      fb,
    ),
    c(
      "Failed retry stays actionable; offline never loops redirects",
      T.fallbackRetry,
      e(F.fallback, "stays inline for temporary states and offers Retry only once lost"),
      T.e2eHostRoutes,
    ),
  ),

  // §6.2 Dialogs.
  item(
    "M01",
    "Identity",
    c("Avatar preview / safe name request pending", T.avatarFriendly, T.avatarSix),
    c(
      "Empty nickname → 15-character hint + fill/random",
      T.avatarSix,
      e(F.avatarCustomizer, "rejects empty and too-long nicknames locally"),
    ),
    c("Valid avatar + name → Join", T.avatarSix, T.e2eJoinIdeal, jGame),
    c(
      "Duplicate/forbidden name; CJK/emoji; lobby edits avatar only",
      T.avatarKeeps,
      e(
        F.avatarCustomizer,
        "saves the avatar only, reverts a failed change and is unavailable outside the lobby",
      ),
      T.e2eJoinIdeal,
    ),
    c(
      "Failed join keeps entries; a changed room goes back to join",
      T.avatarKeeps,
      e(F.avatarCustomizer, "recovers a stored player without sending a changed nickname"),
    ),
  ),
  item(
    "M02",
    "QR scanner",
    c(
      "Opening the camera",
      e(
        F.qr,
        "opens the camera only after a gesture, ignores foreign QR codes and reports the PIN once",
      ),
    ),
    c(
      "No camera → enter the PIN",
      e(
        F.qr,
        "falls back to manual PIN entry when denied, without a camera or in an insecure context",
      ),
      T.e2eJoinCamera,
    ),
    c(
      "Recognized QR → check the PIN once",
      e(
        F.qr,
        "opens the camera only after a gesture, ignores foreign QR codes and reports the PIN once",
      ),
      e(F.pin, "opens the QR scanner and returns to manual entry"),
    ),
    c(
      "Poor light / another instance's QR → guidance without navigation",
      e(F.qr, "shows wrong-origin and invalid-QR guidance while scanning continues"),
      T.e2eJoinCamera,
    ),
    c(
      "Permission denied/unavailable → manual PIN; stream stopped",
      T.e2eJoinCamera,
      e(F.qr, "stops the tracks when the dialog closes or unmounts"),
      e(F.qr, "releases a stream that arrives after the dialog was closed"),
    ),
  ),
  item(
    "M03",
    "Quiz metadata",
    c("Create pending", T.hostCreateLost),
    c(
      "Title required; cover optional → choose cover",
      T.hostCreate,
      e(
        F.mediaPicker,
        "chooses a cover image from the library after a preview, with no YouTube tab",
      ),
    ),
    c("Create/apply metadata", T.hostCreate),
    c(
      "150-character title, failed cover, long description",
      e(
        F.hostConfig,
        "keeps a legacy track id, cannot preview it, and applies it to the draft unchanged",
      ),
      e(F.mediaPicker, "shows the empty and error states of the source"),
    ),
    c("Inline error; dialog stays open with entries", T.hostCreateLost),
  ),
  item(
    "M04",
    "Import",
    c("Upload/validate/commit with real labels", T.importWalk),
    c("No file yet → choose file", T.importWalk),
    c("Import succeeded → studio", T.importWalk, jContent),
    c(
      "Wrong format/version; errors per location, paginated when long",
      T.importRows,
      e(F.importExport, "reports malformed CSV and unsupported versions"),
      e(F.importExport, "rejects unsupported and oversized files before uploading"),
    ),
    c(
      "No partial quiz; retry only after the commit status is known",
      T.importLost,
      e(F.importExport, "opens a quiz whose import response was lost without re-sending"),
    ),
  ),
  item(
    "M05",
    "Media picker",
    c(
      "Grid/progress/processing",
      T.assetsUpload,
      e(F.mediaPicker, "keeps a pending upload unusable until it is READY"),
    ),
    c(
      "No media of this kind + Upload",
      e(F.mediaPicker, "shows the empty and error states of the source"),
    ),
    c(
      "Selected preview + Use",
      e(
        F.mediaPicker,
        "chooses a cover image from the library after a preview, with no YouTube tab",
      ),
      e(F.assets, "locks the picker to one kind and selects READY items"),
    ),
    c(
      "Wrong type/too large; invalid video range; missing media",
      e(
        F.mediaPicker,
        "checks the clip range of a library video and copies its accessibility independently",
      ),
      e(F.mediaPicker, "refuses a malformed external URL and normalizes a YouTube link"),
      e(F.properties, "keeps an unresolvable media ID and clears everything on Remove media"),
    ),
    c(
      "Error per source; never selects an unavailable record",
      e(F.mediaPicker, "shows the empty and error states of the source"),
      e(F.mediaPicker, "keeps a pending upload unusable until it is READY"),
    ),
  ),
  item(
    "M06",
    "Host setup",
    c(
      "Snapshot validation / create pending",
      e(
        F.hostConfig,
        "defaults to Projector without friendly nicknames and creates one room despite a double submit",
      ),
    ),
    c("Zero questions → fix the quiz", T.hostConfigEmpty),
    c(
      "Mode/friendly names → lobby",
      e(F.hostConfig, "sends the chosen mode and friendly nicknames"),
      T.e2eHostGame,
      jGame,
    ),
    c(
      "Dirty draft → save first",
      T.hostConfigEmpty,
      e(
        F.hostConfig,
        "asks to save after a stale revision and uses a new request id for the next attempt",
      ),
    ),
    c(
      "Room create failed → retry after reconciliation, never a second room",
      e(F.hostConfig, "reconciles a lost ACK before retrying with the same request id (one room)"),
      e(
        F.hostConfig,
        "opens the reconciled room without re-sending, and reports definitive failures",
      ),
    ),
  ),
  item(
    "M07",
    "Enlarged QR",
    c(
      "Placeholder with fixed dimensions",
      e(F.qr, "keeps the link and PIN when the QR fails, and waits for a room PIN"),
    ),
    c(
      "No URL yet → wait for the room",
      e(F.qr, "keeps the link and PIN when the QR fails, and waits for a room PIN"),
    ),
    c("QR + URL + PIN", e(F.qr, "shows the QR, link and PIN and copies the link")),
    c(
      "Clipboard unavailable → select the link manually",
      e(F.qr, "selects the link for manual copy when copying fails or is unavailable"),
      e(F.lobby, "copies the link, or asks for a manual copy when the clipboard is unavailable"),
    ),
    c(
      "QR failed → URL/PIN still usable",
      e(F.qr, "keeps the link and PIN when the QR fails, and waits for a room PIN"),
    ),
  ),
  item(
    "M08",
    "Explanation",
    c("No fetch when the reveal already carries it (opens at once)", T.resultsExplanation),
    c("Button not shown when empty", e(F.results, "explains an empty or unavailable explanation")),
    c("Full explanation", T.resultsExplanation, T.e2eHostGame),
    c("1000 characters scroll, CJK wraps", T.resultsExplanation),
    c(
      "Snapshot unavailable → close + retry sync, no early key",
      e(F.results, "explains an empty or unavailable explanation"),
    ),
  ),
  item(
    "M09",
    "Confirm",
    c(
      "Action pending, target visible",
      e(
        F.confirm,
        "keeps a pending action through close and reopen and reports success to the parent once",
      ),
    ),
    c("Target already gone → info + Close", T.confirmGone),
    c(
      "Specific target/impact/CTA",
      e(F.confirm, "names the target and impact, focuses Cancel and traps the keyboard"),
    ),
    c("Reference conflict / role rule → safe reason", T.confirmNever, T.assetsInUse),
    c(
      "Never closes as success; reconcile a lost response",
      T.confirmNever,
      e(F.confirm, "treats an ambiguous outcome as done only when reconciliation confirms it"),
    ),
  ),
  item(
    "M10",
    "Unsaved changes",
    c(
      "Save and continue pending",
      e(
        F.confirm,
        "blocks navigation when the save fails, keeps the draft, and continues after a successful save",
      ),
    ),
    c(
      "Not dirty → no dialog needed",
      e(F.confirm, "navigates directly when clean and offers Stay first when dirty"),
      e(F.studioStore, "navigates directly when clean and guards when dirty"),
    ),
    c("Three clear choices", e(F.confirm, "stays on Escape or Stay and leaves on Discard")),
    c("Incomplete draft can still be saved", T.e2eStudioZero),
    c(
      "Save failed keeps the draft and does not navigate",
      e(
        F.confirm,
        "blocks navigation when the save fails, keeps the draft, and continues after a successful save",
      ),
    ),
  ),
  item(
    "M11",
    "Invite",
    c("Generation pending", T.usersLost),
    c("No code yet → create", T.usersInvites, T.usersCode),
    c("Code + copy + status", T.usersCode, T.e2eAuthRegister),
    c("Expired/used/revoked; copy failed → manual copy", T.usersInvites, T.usersCode),
    c("No duplicate invite while the result is unknown", T.usersLost),
  ),
  item(
    "M12",
    "Answer detail",
    c(
      "Detail skeleton",
      e(F.answers, "loads, then shows readable answers, outcomes and points per question"),
    ),
    c(
      "No answer / not played per snapshot",
      e(F.answers, "keeps not eligible, unanswered and not played apart, with unavailable media"),
      e(F.answers, "shows a load failure with Retry instead of an empty list, and the empty state"),
    ),
    c(
      "Readable payload + result/points/time",
      e(F.answers, "loads, then shows readable answers, outcomes and points per question"),
      T.e2eReportFull,
    ),
    c(
      "Partial multiple; missing historical media; many questions paginated",
      e(F.answers, "keeps not eligible, unanswered and not played apart, with unavailable media"),
      e(F.answers, "pages with the keyboard and moves focus to the list heading"),
      T.e2eReportFull,
    ),
    c(
      "Retry detail; a failed fetch is never an empty answer",
      e(F.answers, "shows a load failure with Retry instead of an empty list, and the empty state"),
    ),
  ),

  // §6.3 Base components.
  item(
    "B01",
    "ActionButton",
    c("Spinner + label; prevents double submit", T.formLoading),
    c("Unavailable action → hidden or disabled + reason", T.formUnavailable),
    c(
      "Clear label + focus",
      e(F.form, "Ideal: native button, press by click and keyboard, 44 px target, wrapping label"),
    ),
    c(
      "Long label wraps; icon-only accessible name",
      e(F.form, "Partial: icon-only buttons expose their accessible name and hide the icon"),
    ),
    c("Parent notice/inline error; re-enabled only when safe", T.formUnavailable, T.formLoading),
  ),
  item(
    "B02",
    "FormField",
    c(
      "Async options pending; existing value stays",
      e(
        F.form,
        "Loading/Empty/Partial select: keeps the value while loading, labels unknown values",
      ),
    ),
    c(
      "Helpful placeholder, label stays",
      e(F.form, "Ideal: labelled control with stable id, help description and change events"),
    ),
    c(
      "Value/help/counter",
      e(F.form, "Ideal: labelled control with stable id, help description and change events"),
    ),
    c(
      "Max length/Unicode wrap; missing option labelled",
      e(
        F.form,
        "Partial: counts graphemes, flags but never truncates over-limit input, passes IME text",
      ),
      e(
        F.form,
        "Loading/Empty/Partial select: keeps the value while loading, labels unknown values",
      ),
    ),
    c(
      "aria-invalid + described error; value kept",
      e(F.form, "Error: aria-invalid with the described error, value kept"),
    ),
  ),
  item(
    "B03",
    "ChoiceGroup",
    c("Pending items non-interactive", T.choiceGroup),
    c("No options + parent action", T.choiceGroup),
    c(
      "Selected and focus clearly different",
      e(
        F.form,
        "Ideal radio: labelled group, selects by domain id, check mark distinct from focus",
      ),
    ),
    c(
      "Disabled option/reason, controlled tab overflow",
      e(F.form, "Partial checkbox: toggles ids in and out of the selection"),
      e(
        F.form,
        "tabs: roving focus with arrows/Home/End, manual activation, disabled tabs skipped",
      ),
    ),
    c("Parent error; last selection kept", T.choiceGroup),
  ),
  item(
    "B04",
    "ModalSheet",
    c("Body skeleton; title/close available", T.dialogStates),
    c("Empty content → empty notice + Close", T.dialogStates),
    c(
      "Focus trapped + returned",
      e(F.dialogs, "traps Tab/Shift+Tab, hides the background and returns focus on Escape"),
    ),
    c(
      "Long body scrolls; one modal",
      T.dialogStates,
      e(
        F.dialogs,
        "keeps a single active modal: a second dialog takes over and gives control back",
      ),
    ),
    c(
      "Inline error, close stays; parent keeps request state",
      T.dialogStates,
      e(F.dialogs, "closing during a pending request keeps the parent's request state"),
    ),
  ),
  item(
    "B05",
    "MenuPopover",
    c("Dynamic items loading, trigger stays", T.menuEmpty),
    c("Empty menu → trigger removed", T.menuEmpty),
    c("Keyboard menu + labels", T.menuKeyboard),
    c(
      "Long labels wrap/reposition",
      e(
        F.shells,
        "toggles the small-screen menu, closes it on Escape and on navigation, and wraps long names",
      ),
    ),
    c("Closes safely; never triggers a false action", T.menuKeyboard),
  ),
  item(
    "B06",
    "StatusNotice",
    c("Processing status", T.neverEmpty, T.skeleton),
    c(
      "No message → nothing rendered",
      e(F.status, "hides unsafe reference IDs and renders nothing without a message"),
    ),
    c(
      "Message + relevant CTA",
      e(F.status, "auto-dismisses polite toasts, pausing while hovered or focused"),
    ),
    c(
      "Long message wraps; repeated events de-duplicated",
      e(F.status, "de-duplicates repeated events by key in an always-present region"),
    ),
    c(
      "Important errors never auto-dismiss; retry focusable",
      e(
        F.status,
        "keeps important errors as alerts with a focusable retry and a safe reference ID",
      ),
    ),
  ),
  item(
    "B07",
    "SkeletonBlock",
    c("Stable dimensions, one loading label", T.skeleton),
    c("Nothing loading → no skeleton", T.neverEmpty),
    c(
      "Replaced by ready content",
      e(
        F.status,
        "drives a data region: failure shows error + retry, success with no rows shows empty",
      ),
    ),
    c("Slow → waiting message; reduced motion static", T.skeleton),
    c("Replaced by error + Retry, never an endless skeleton", T.skeleton, T.neverEmpty),
  ),
  item(
    "B08",
    "StatusBadge",
    c(
      "Checking… only when really pending",
      e(F.status, "pairs icon and text, formats values and never shows unknown as zero"),
      T.adminHealth,
    ),
    c(
      "Unknown value → not known yet",
      e(F.status, "pairs icon and text, formats values and never shows unknown as zero"),
    ),
    c(
      "Icon + text",
      e(F.status, "pairs icon and text, formats values and never shows unknown as zero"),
    ),
    c(
      "Large numbers/long labels wrap",
      e(F.status, "pairs icon and text, formats values and never shows unknown as zero"),
    ),
    c(
      "Danger tone + text, never icon only",
      e(F.status, "pairs icon and text, formats values and never shows unknown as zero"),
      T.adminHealth,
    ),
  ),
  item(
    "B09",
    "ContentCard",
    c("Media/text skeleton", T.cardStates),
    c("Missing resource → parent empty state", T.cardStates),
    c(
      "Title + metadata + actions",
      e(F.collection, "has one heading link, separate actions, metadata and the full long title"),
    ),
    c(
      "Cover failure fallback; full title on detail",
      e(F.collection, "falls back when the cover fails and supports a button heading"),
    ),
    c("Local error card or parent retry", T.cardStates),
  ),
  item(
    "B10",
    "DataCollection",
    c("Skeleton rows; stale page labelled", T.collectionStates),
    c("No rows + CTA/reset filter", T.collectionStates),
    c(
      "Table/list + pagination",
      e(
        F.collection,
        "renders a captioned table and mobile cards, sorts by keyboard and keys rows by id",
      ),
    ),
    c(
      "Server pagination, unknown total, long cells",
      e(F.collection, "paginates with a known total and with an unknown total (never 0 results)"),
    ),
    c("Old page kept, labelled stale + Retry", T.collectionStates, T.reportListError),
  ),
  item(
    "B11",
    "MediaPreview",
    c("Poster/progress, reserved ratio", T.mediaRetry),
    c(
      "No attachment → slot removed or studio picker",
      e(F.properties, "shows loading, then an empty media state with exact time values and points"),
    ),
    c(
      "Media + controls/alt",
      T.mediaRetry,
      e(F.media, "embeds YouTube from the privacy-enhanced host in a sandbox with clip bounds"),
    ),
    c(
      "Autoplay blocked → Play; missing captions/transcript flagged",
      e(F.media, "falls back to a user play action when autoplay is blocked"),
      e(F.media, "shows transcripts and visual descriptions, and says when they are missing"),
    ),
    c(
      "Placeholder + Retry; never silently stops the timer",
      T.mediaRetry,
      e(
        F.media,
        "shows the clock-derived step under irregular ticks, keeps going when the image fails, and completes",
      ),
    ),
  ),
  item(
    "B12",
    "AvatarIllustration",
    c("Fixed-size silhouette", T.avatarLoading),
    c("No avatar yet → deterministic default", T.avatarFallback),
    c(
      "Official avatar/mascot",
      e(F.avatar, "generates the six styles deterministically as local SVG data URIs"),
      e(F.avatar, "renders the bundled mascot with an expression, decorative or labelled"),
    ),
    c(
      "Invalid seed/style → fallback, name kept",
      T.avatarFallback,
      e(F.avatar, "validates style and seed with the shared schema and rerolls locally"),
    ),
    c("Render failure → monogram; never blocks joining", T.avatarLoading),
  ),

  // §6.4 Feature components.
  item(
    "F01",
    "PublicAuthForms",
    c("Policy/submit busy", T.authLoading),
    c("Empty form / registration closed", T.authLoading, T.e2eAuthRegister),
    c("Auth flow", T.e2eAuthLogin, jAccount),
    c(
      "Setup race / invite mode",
      T.authRace,
      e(
        F.auth,
        "requires an invite code on INVITE_ONLY, keeps entries when the code is used and succeeds with a new key",
      ),
    ),
    c(
      "Field + form error",
      T.authErrors,
      e(F.auth, "maps client and server issue codes to messages"),
    ),
  ),
  item(
    "F02",
    "QuizLibraryDetail",
    c("Query skeleton", T.libSkeleton),
    c("Create/import/reset filter", T.libEmpty),
    c(
      "Allowed actions",
      e(F.library, "duplicates into a new studio and hosts a playable quiz through M06"),
      jContent,
    ),
    c("PUBLIC read-only / invalid draft", T.libPublic),
    c("Safe forbidden + retry", T.libEmpty, T.detailHidden),
  ),
  item(
    "F03",
    "StudioEditor",
    c(
      "Load/save pending",
      e(F.studioStore, "saves explicitly only and keeps edits made during the save"),
    ),
    c("Add question", T.slidesLoading),
    c(
      "Draft/saved",
      e(F.studioStore, "keeps the saved snapshot apart from the working draft"),
      T.e2eStudioSix,
    ),
    c(
      "Revision conflict, incomplete",
      e(F.studioStore, "preserves the draft on a 409 conflict and supports manual reconciliation"),
      T.e2eStudioZero,
    ),
    c(
      "Preserve draft; no false saved",
      e(F.studioStore, "keeps the draft and the error when a save fails"),
      T.e2eStudioConflict,
    ),
  ),
  item(
    "F04",
    "SlideNavigator",
    c("Thumbnail skeleton", T.slidesLoading),
    c("Add slide", T.slidesLoading),
    c(
      "Select/move by ID",
      e(
        F.slides,
        "moves with the keyboard alternative, keeps focus on the moved slide and announces it",
      ),
    ),
    c(
      "100+ slides scroll, stable focus",
      e(F.slides, "handles 150 slides with a scroll hint and stable focus"),
    ),
    c(
      "Invalid reorder restores the last draft order",
      e(F.slides, "explains a rejected move and keeps the previous order"),
    ),
  ),
  item(
    "F05",
    "QuestionFields",
    c(
      "Schema/content loading",
      e(F.properties, "shows loading, then an empty media state with exact time values and points"),
    ),
    c(
      "Required hints per type",
      e(F.fields, "guides an incomplete single choice, then accepts one key and flags duplicates"),
    ),
    c(
      "Six-type fields",
      e(F.fields, "edits multiple select, true/false and poll keys per type"),
      e(F.fields, "manages accepted answers up to 20 and keeps them all correct"),
      e(F.fields, "orders puzzle items by moving them while keeping their identity"),
    ),
    c(
      "Limits, lossy type change",
      e(
        F.fields,
        "counts graphemes for emoji and CJK, survives IME composition and blocks text over the limit",
      ),
      e(
        F.fields,
        "asks before a lossy type change, keeps everything on Cancel and keeps IDs when nothing is lost",
      ),
    ),
    c(
      "Inline issues + summary to the field",
      e(F.fields, "focuses a field from the problem list and from focusPath"),
    ),
  ),
  item(
    "F06",
    "AssetLibraryPickerUpload",
    c("Upload/processing", T.assetsUpload),
    c("Upload", T.assetsEmpty),
    c(
      "Select ready media",
      e(F.assets, "locks the picker to one kind and selects READY items"),
      jContent,
    ),
    c("In-use/delete conflict", T.assetsInUse),
    c(
      "Per-file error retry",
      T.assetsUpload,
      e(F.assets, "reconciles a lost upload response through its idempotency key"),
    ),
  ),
  item(
    "F07",
    "ImportExport",
    c("Import/export pending", T.importWalk),
    c(
      "Choose a file / no resource",
      T.importWalk,
      e(F.detail, "exports JSON under the server filename and reports failed or empty downloads"),
    ),
    c("Commit/download confirmed", T.importWalk, T.e2eReportFull, jContent),
    c(
      "Format/version/row errors",
      T.importRows,
      e(F.importExport, "reports malformed CSV and unsupported versions"),
    ),
    c(
      "Atomic failure; no empty success",
      T.importLost,
      e(F.detail, "exports JSON under the server filename and reports failed or empty downloads"),
    ),
  ),
  item(
    "F08",
    "AdminSettingsHealth",
    c("Per-panel load", T.adminStorage, adm),
    c("0 files / unknown health", T.adminStorage, T.adminHealth),
    c("Valid settings/metrics", T.adminSave, jAdmin),
    c("Partial cleanup / stale metrics", T.adminCleanup),
    c("Save draft retained; per-panel retry", T.adminStale, T.adminStorage, adm),
  ),
  item(
    "F09",
    "UserInvites",
    c("List/generation busy", T.usersList, T.usersLost),
    c("Create invite", T.usersInvites),
    c("User/invite management", T.usersCode, T.usersList),
    c("Used/expired/last-admin rule", T.usersLastAdmin, T.usersInvites),
    c("Mutation rejected, refetch", T.usersLastAdmin, T.usersLost),
  ),
  item(
    "F10",
    "ReportAnalytics",
    c("Fetch/finalization", T.reportListLoads, T.e2eReportGate),
    c("No completed sessions/answers", T.reportListEmpty, T.e2eReportEarly),
    c("Snapshot analytics", T.e2eReportFull, jReport),
    c("Partial/no-point metrics", T.e2eReportFull),
    c("No report link before ready", T.e2eReportGate, T.e2eHostEarly, T.reportListError),
  ),
  item(
    "F11",
    "PinJoinScanner",
    c(
      "Check/camera pending",
      e(F.pin, "checks a deep-linked PIN exactly once, even under StrictMode"),
      T.e2eJoinLoading,
    ),
    c("Enter the PIN", e(F.pin, "guides an empty PIN, then checks once and joins as a guest")),
    c("Valid PIN", T.e2eJoinIdeal),
    c(
      "Full/locked/rate-limited",
      e(F.pin, "explains locked, full and started rooms and waits for rate limits without polling"),
      T.e2eJoinLocked,
    ),
    c(
      "Manual entry/retry metadata",
      e(F.pin, "offers Try again after an unknown result"),
      T.e2eJoinCamera,
    ),
  ),
  item(
    "F12",
    "AvatarCustomizer",
    c("Friendly name roll pending", T.avatarFriendly),
    c(
      "Enter a name / random",
      e(F.avatarCustomizer, "rejects empty and too-long nicknames locally"),
    ),
    c("Preview + join", T.avatarSix),
    c("Six styles / missing font / nickname conflict", T.avatarSix, T.avatarKeeps),
    c(
      "Seed/name preserved on rejection",
      T.avatarKeeps,
      e(F.avatarCustomizer, "re-rolls the seed on every dice press and throttles the nekoPop cue"),
    ),
  ),
  item(
    "F13",
    "HostStageLobby",
    c(
      "Sync/command busy",
      T.lobbyEmpty,
      e(F.projector, "sends one command for a double click and labels Next from the server state"),
    ),
    c("0 players + share PIN", T.lobbyEmpty),
    c(
      "Role-safe host stage",
      e(
        F.projector,
        "shows the full prompt and options while answering, with no key and the answer count",
      ),
      T.e2eHostGame,
    ),
    c("Disconnect grid / duplicate Next ACK", T.lobbyLarge, T.e2eHostGame),
    c(
      "Commands frozen until sync",
      e(F.projector, "explains a refusal, confirms End and pauses without a connection"),
      T.lobbyOffline,
    ),
  ),
  item(
    "F14",
    "PlayerStageAnswerPad",
    c(
      "Sync/submitting",
      e(
        F.text,
        "sends a frozen order once and locks moves while submitting, accepted, in grace or offline",
      ),
    ),
    c(
      "No selection hint",
      e(
        F.choice,
        "requires a selection for multiple select and sends the chosen set without hinting the key count",
      ),
    ),
    c(
      "Correct control per type",
      e(
        F.choice,
        "renders fixed letters, shapes and colors and sends a single choice once from the keyboard",
      ),
      e(F.choice, "lays out two true/false cards and keeps polls neutral"),
      T.e2ePlayerGame,
    ),
    c(
      "Partial feedback / unknown ACK / IME",
      e(F.text, "never submits on Enter while an IME composition is active"),
      T.recoveryPending,
    ),
    c(
      "Locked offline; sync before retry",
      e(F.choice, "locks input during grace, after closing and while offline"),
      e(F.text, "locks after sending, during grace and while offline, and never sends twice"),
    ),
  ),
  item(
    "F15",
    "GameTimer",
    c(
      "Awaits the authoritative timestamp",
      e(
        F.clock,
        "ignores device wall-clock jumps and uses a provisional offset before the first sample",
      ),
    ),
    c(
      "Untimed phase → no timer",
      e(F.clock, "ticks without re-rendering its parent and renders nothing when untimed"),
    ),
    c(
      "Numeric/ring deadline",
      e(
        F.clock,
        "announces opening, five seconds and closing once each, and starts fresh for a new deadline",
      ),
    ),
    c(
      "0 during grace; stale clock offset",
      e(F.clock, "never grows on a rebase, stops at zero with the grace message, then closes"),
      e(F.clock, "uses the median of the latest five RTT-midpoint samples"),
    ),
    c(
      "Sync warning; never extends server time",
      e(
        F.clock,
        "samples on connect, every 30 s and again after a reconnect, without touching the snapshot",
      ),
      e(F.clock, "never grows on a rebase, stops at zero with the grace message, then closes"),
    ),
  ),
  item(
    "F16",
    "ResultChartLeaderboardPodium",
    c(
      "Results not sent yet → waiting",
      e(
        F.results,
        "waits for results, then shows single-choice counts with the correct answer in text",
      ),
      e(F.podium, "covers loading, empty, stale and settled motion"),
    ),
    c("No answers/eligible ranks → text", T.resultsNone),
    c(
      "Counts/ranks/podium",
      e(F.podium, "renders the server order, rank changes, the biggest climber and the own row"),
      e(F.podium, "reveals 3rd, 2nd and 1st at the audio cues, with at most 2 s of confetti"),
    ),
    c(
      "<3 winners, ties, long names",
      T.podiumWinners,
      e(F.podium, "keeps ties in server order with their shared rank"),
      e(F.results, "shows a partial 475 as 375 + 100 without adding the bonus twice"),
    ),
    c(
      "Last confirmed result + stale label",
      e(F.results, "settles motion on late renders and shows stale results"),
      T.resultsNone,
    ),
  ),
  item(
    "F17",
    "ConnectionRecovery",
    c("Initial sync/reconnect", T.recoveryViews),
    c("No token → join/auth path", T.recoveryViews, T.e2ePlayerEmpty),
    c("Connected, unobtrusive notice", T.recoveryViews),
    c(
      "One active connection / missed phases",
      T.recoveryStale,
      e(
        F.sessionRecovery,
        "never adds duplicate socket listeners on re-renders or locale switches",
      ),
    ),
    c(
      "Backoff then manual retry; revoked/expired terminal",
      T.recoveryTerminal,
      e(
        F.sessionRecovery,
        "reconnects with backoff over consecutive failures and honours retry-after",
      ),
      e(
        F.recovery,
        "shows the error state when the connection is lost before or after the first sync",
      ),
    ),
  ),
  item(
    "F18",
    "AudioControls",
    c("Audio loading", T.audioStates),
    c(
      "No track selected → choose a track",
      T.audioStates,
      e(F.audio, "shows the track title and Next track only in the lobby"),
    ),
    c(
      "Mute/volume/play",
      e(F.audio, "toggles mute by button and M, but not while typing or with modifiers"),
      e(
        F.audio,
        "opens the settings popover by keyboard with labelled sliders and clamped volumes",
      ),
      e(F.e2eAudio, "plays the full role matrix, bounded loops and a silent teardown"),
    ),
    c(
      "Autoplay blocked → enable sound",
      T.audioStates,
      e(F.audioEngine, "unlocks on the first gesture and keeps retrying while blocked"),
    ),
    c("Audio failed + retry; the visual game continues", T.audioStates),
  ),
  item(
    "F19",
    "LocalePicker",
    c("Catalog pending; old locale stays", T.localeSwitch),
    c("No search result → clear search / guide", T.localeList),
    c("Native name + active check", T.localeList, T.localeSwitch),
    c(
      "Missing key falls back to en; newly installed locale",
      e(F.locale, "loads route namespaces on demand and renders safely without a bundle"),
      T.localeList,
    ),
    c(
      "Failed switch keeps the old locale + Try again",
      e(F.locale, "keeps the old language on a failed fetch, then retries into an RTL locale"),
    ),
  ),
  item(
    "F20",
    "DocumentView",
    c("Source metadata pending", T.docReal),
    c("Missing version uses a label", T.docUnknown),
    c("Readable document + anchors", T.docReal, pub),
    c("Long official text / language mismatch", T.docGuide, T.docReal),
    c("Missing source actionable, no invented content", T.docUnknown, T.docRegistry, pub),
  ),
];

/** Inventory IDs required by the design. */
export const REQUIRED_IDS = [
  ...Array.from({ length: 17 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `M${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `B${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 20 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
];

/**
 * Holds every request matching `pattern` until `release()` (Loading). Requests that arrive after
 * the release pass straight through.
 */
export async function holdRequests(page: Page, pattern: RegExp) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  const handler = async (route: Route) => {
    held += 1;
    await gate;
    // Hand the request on to the context's own routes (client address). The app may already have
    // aborted a superseded request meanwhile, which is not an error here.
    await route.fallback().catch(() => undefined);
  };
  await page.route(pattern, handler);
  return {
    /** Number of requests held so far. */
    held: () => held,
    /** Lets the held requests through and stops holding new ones. */
    async release() {
      release();
      await page.unroute(pattern, handler);
    },
  };
}

/** Aborts every request matching `pattern` (offline fetch) until `stop()`. */
export async function failRequests(page: Page, pattern: RegExp) {
  let failed = 0;
  const handler = async (route: Route) => {
    failed += 1;
    await route.abort("internetdisconnected");
  };
  await page.route(pattern, handler);
  return {
    /** Number of requests failed so far. */
    failed: () => failed,
    /** Stops failing. */
    stop: () => page.unroute(pattern, handler),
  };
}

/** Answers every request matching `pattern` with 503 and an empty body until `stop()`. */
export async function serviceUnavailable(page: Page, pattern: RegExp) {
  const handler = (route: Route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  await page.route(pattern, handler);
  return { stop: () => page.unroute(pattern, handler) };
}
