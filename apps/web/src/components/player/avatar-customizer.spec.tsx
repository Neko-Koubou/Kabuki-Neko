/**
 * TASK-150 coverage for the guest identity customizer (M01 / F12), driven by a scripted socket.
 * - The six DiceBear styles.
 * - Nicknames with leading emoji, accents and CJK within 15 characters; too long or empty is
 *   rejected locally.
 * - Dice: a new seed every press, with the nekoPop cue throttled and the audio unlocked once.
 * - Friendly rooms: a server name plus its ticket, no free text.
 * - All five states: empty hint, loading, ideal join (room credentials stored), partial (taken or
 *   forbidden nickname) and error (room full with Back; lost ACK retried with the same request id).
 * - Recovery: the stored session token is sent and nickname edits are ignored.
 * - Lobby edit: avatar only, a revert on failure, unavailable outside the lobby.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EmitResult } from "@/lib/socket-client";
import { renderWithLocale } from "@/test/locale";
import {
  AvatarCustomizer,
  nicknameProblem,
  styleName,
  type DiceAudio,
  type PlayerEmitter,
} from "./avatar-customizer";

const NAMESPACES = ["common", "accessibility", "player", "validation"] as const;
const PIN = "000123";
const SESSION = "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b";
const PLAYER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const TOKEN = "A".repeat(43);
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";

/** Scripted emitter: one handler for all events, every call recorded. */
function fakeSocket(handler: (event: string, payload: Record<string, unknown>) => unknown) {
  const calls: { event: string; payload: Record<string, unknown> }[] = [];
  const emit = vi.fn(async (event: string, payload: Record<string, unknown>) => {
    calls.push({ event, payload });
    return handler(event, payload);
  });
  return {
    socket: { emit } as unknown as PlayerEmitter,
    calls,
    joins: () => calls.filter((call) => call.event === "player:join_room"),
  };
}

/** ACK helpers. */
const ok = (data: unknown) =>
  ({
    status: "ok",
    requestId: "r",
    serverTime: 1,
    data,
  }) as unknown as EmitResult<"player:join_room">;
const fail = (errorCode: string) => ({
  status: "error",
  requestId: "r",
  error: {
    statusCode: 409,
    errorCode,
    message: "x",
    params: {},
    details: [],
    correlationId: CORRELATION,
  },
});
const joined = (nickname: string) =>
  ok({
    playerId: PLAYER,
    sessionId: SESSION,
    sessionToken: TOKEN,
    recovered: false,
    snapshot: { self: { nickname } },
  });

/** Fake audio manager surface. */
function fakeAudio(): DiceAudio & {
  playSfx: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
} {
  return { playSfx: vi.fn(async () => true), unlock: vi.fn(async () => true) };
}

/** Map-backed storage. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("AvatarCustomizer — join", () => {
  it("offers six styles and joins with a Unicode nickname (empty → loading → ideal)", async () => {
    const user = userEvent.setup();
    let answer: (value: unknown) => void = () => {};
    const { socket, joins } = fakeSocket(() => new Promise((resolve) => (answer = resolve)));
    const onJoined = vi.fn();
    const storage = memoryStorage();
    renderWithLocale(
      <AvatarCustomizer
        mode="join"
        pinCode={PIN}
        friendlyNicknames={false}
        socket={socket}
        onJoined={onJoined}
        audio={fakeAudio()}
        storage={storage}
      />,
      { namespaces: [...NAMESPACES] },
    );
    expect(screen.getByRole("heading", { level: 1, name: "Choose your look" })).toBeInTheDocument();
    expect(
      screen.getByText("Choose a nickname (up to 15 characters) or get a random one."),
    ).toBeInTheDocument();
    const styles = within(screen.getByRole("group", { name: "Avatar style" })).getAllByRole(
      "radio",
    );
    expect(styles.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Bottts",
      "Adventurer",
      "Fun Emoji",
      "Pixel Art",
      "Lorelei",
      "Avataaars",
    ]);
    expect(screen.getByRole("radio", { name: "Bottts" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Lorelei" }));
    expect(screen.getByRole("radio", { name: "Lorelei" })).toBeChecked();

    const nickname = screen.getByLabelText(/^Nickname/u);
    expect(nickname).toHaveAttribute("autocomplete", "nickname");
    await user.type(nickname, "😺Ñeko 小猫");
    expect(screen.getByText("Pick an avatar and nickname, then join.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Join game" }));
    expect(screen.getByText("Getting things ready…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Join game/u }));
    expect(joins()).toHaveLength(1);
    expect(joins()[0]?.payload).toMatchObject({
      pinCode: PIN,
      nickname: "😺Ñeko 小猫",
      avatar: { style: "lorelei" },
    });
    expect(joins()[0]?.payload.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(joins()[0]?.payload).not.toHaveProperty("friendlyNameTicket");
    await act(async () => answer(joined("😺Ñeko 小猫")));
    expect(onJoined).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, playerId: PLAYER }),
    );
    expect(JSON.parse(storage.map.get(`kabuki:player:${SESSION}`) ?? "{}")).toEqual({
      sessionId: SESSION,
      playerId: PLAYER,
      sessionToken: TOKEN,
      pinCode: PIN,
    });
    expect(storage.map.get(`kabuki:player-pin:${PIN}`)).toBe(SESSION);
  });

  it("rejects empty and too-long nicknames locally", async () => {
    const user = userEvent.setup();
    const { socket, joins } = fakeSocket(() => joined("x"));
    renderWithLocale(
      <AvatarCustomizer
        mode="join"
        pinCode={PIN}
        friendlyNicknames={false}
        socket={socket}
        onJoined={vi.fn()}
        audio={fakeAudio()}
        storage={null}
      />,
      { namespaces: [...NAMESPACES] },
    );
    await user.click(screen.getByRole("button", { name: "Join game" }));
    expect(screen.getByText("This field is required.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Nickname/u), "abcdefghijklmnop");
    await user.click(screen.getByRole("button", { name: "Join game" }));
    expect(
      screen.getByText("That nickname can't be used. Use 1 to 15 characters."),
    ).toBeInTheDocument();
    expect(joins()).toHaveLength(0);
    expect(nicknameProblem("👩‍👩‍👧‍👦".repeat(15))).toBeNull();
    expect(nicknameProblem("   ")).toBe("validation.errors.required");
    expect(styleName("fun-emoji")).toBe("Fun Emoji");
  });

  it("re-rolls the seed on every dice press and throttles the nekoPop cue", async () => {
    const user = userEvent.setup();
    const audio = fakeAudio();
    const { socket, joins } = fakeSocket(() => joined("Neko"));
    renderWithLocale(
      <AvatarCustomizer
        mode="join"
        pinCode={PIN}
        friendlyNicknames={false}
        socket={socket}
        onJoined={vi.fn()}
        audio={audio}
        storage={null}
      />,
      { namespaces: [...NAMESPACES] },
    );
    await user.type(screen.getByLabelText(/^Nickname/u), "Neko");
    const dice = screen.getByRole("button", { name: "Randomize avatar" });
    await user.click(dice);
    await user.click(dice);
    await user.click(dice);
    await waitFor(() => expect(audio.playSfx).toHaveBeenCalledTimes(1));
    expect(audio.playSfx).toHaveBeenCalledWith("nekoPop");
    expect(audio.unlock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Join game" }));
    const seed = (joins()[0]?.payload.avatar as { seed: string }).seed;
    expect(seed).toMatch(/^[A-Za-z0-9_-]{1,100}$/u);
  });

  it("uses a server-picked friendly nickname with its ticket (no free text)", async () => {
    const user = userEvent.setup();
    let taken = true;
    const { socket, joins } = fakeSocket((event) => {
      if (event === "player:request_friendly_name")
        return ok({
          nickname: taken ? "Kucing Ceria" : "Rubah Lincah",
          friendlyNameTicket: "T".repeat(43),
          expiresAt: 9_999_999_999_999,
        });
      if (taken) {
        taken = false;
        return fail("NICKNAME_TAKEN");
      }
      return joined("Rubah Lincah");
    });
    const onJoined = vi.fn();
    renderWithLocale(
      <AvatarCustomizer
        mode="join"
        pinCode={PIN}
        friendlyNicknames
        socket={socket}
        onJoined={onJoined}
        audio={fakeAudio()}
        storage={null}
      />,
      { namespaces: [...NAMESPACES] },
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Join game" }));
    expect(screen.getByRole("alert")).toHaveTextContent("This field is required.");
    await user.click(screen.getByRole("button", { name: "Give me a random nickname" }));
    expect(await screen.findByText("Kucing Ceria")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Join game" }));
    // Partial: taken nickname, ticket cleared, everything else kept.
    expect(
      await screen.findByText("Someone in this room already uses that nickname."),
    ).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(
      "Some characters may not display everywhere, or the nickname is already taken.",
    );
    expect(joins()[0]?.payload).toMatchObject({
      nickname: "Kucing Ceria",
      friendlyNameTicket: "T".repeat(43),
    });
    await user.click(screen.getByRole("button", { name: "Give me a random nickname" }));
    await screen.findByText("Rubah Lincah");
    await user.click(screen.getByRole("button", { name: "Join game" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
  });

  it("keeps fields on forbidden names and full rooms, and retries a lost ACK with the same request id", async () => {
    const user = userEvent.setup();
    const answers: unknown[] = [
      fail("NICKNAME_FORBIDDEN"),
      fail("ROOM_FULL"),
      { status: "unknown", requestId: "r" },
      joined("Neko"),
    ];
    const { socket, joins } = fakeSocket(() => answers.shift());
    const onBack = vi.fn();
    const onJoined = vi.fn();
    renderWithLocale(
      <AvatarCustomizer
        mode="join"
        pinCode={PIN}
        friendlyNicknames={false}
        socket={socket}
        onJoined={onJoined}
        onBack={onBack}
        audio={fakeAudio()}
        storage={null}
      />,
      { namespaces: [...NAMESPACES] },
    );
    const field = screen.getByLabelText(/^Nickname/u);
    await user.type(field, "Neko");
    await user.click(screen.getByRole("button", { name: "Join game" }));
    expect(
      await screen.findByText("That nickname isn't allowed. Please choose another one."),
    ).toBeInTheDocument();
    expect(field).toHaveValue("Neko");

    await user.click(screen.getByRole("button", { name: "Join game" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't join, but your details have been kept.");
    expect(alert).toHaveTextContent("This game is full.");
    await user.click(within(alert).getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(field).toHaveValue("Neko");

    await user.click(screen.getByRole("button", { name: "Join game" }));
    await waitFor(() => expect(joins()).toHaveLength(3));
    await user.click(screen.getByRole("button", { name: "Join game" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
    expect(joins()[3]?.payload.requestId).toBe(joins()[2]?.payload.requestId);
    expect(joins()[2]?.payload.requestId).not.toBe(joins()[1]?.payload.requestId);
  });

  it("recovers a stored player without sending a changed nickname", async () => {
    const user = userEvent.setup();
    const { socket, joins } = fakeSocket(() => joined("Nama Asli"));
    const onJoined = vi.fn();
    renderWithLocale(
      <AvatarCustomizer
        mode="join"
        pinCode={PIN}
        friendlyNicknames={false}
        socket={socket}
        recovery={{ sessionId: SESSION, playerId: PLAYER, sessionToken: TOKEN, pinCode: PIN }}
        onJoined={onJoined}
        audio={fakeAudio()}
        storage={null}
      />,
      { namespaces: [...NAMESPACES] },
    );
    expect(screen.queryByLabelText(/^Nickname/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Join game" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
    const payload = joins()[0]?.payload ?? {};
    expect(payload).toMatchObject({ sessionId: SESSION, sessionToken: TOKEN, pinCode: PIN });
    expect(payload).not.toHaveProperty("nickname");
    expect(onJoined.mock.calls[0]?.[0].snapshot.self.nickname).toBe("Nama Asli");
  });
});

describe("AvatarCustomizer — lobby edit", () => {
  it("saves the avatar only, reverts a failed change and is unavailable outside the lobby", async () => {
    const user = userEvent.setup();
    const answers: unknown[] = [
      fail("INVALID_PHASE"),
      ok({ avatar: { style: "pixel-art", seed: "abc" } }),
    ];
    const { socket, calls } = fakeSocket(() => answers.shift());
    const onSaved = vi.fn();
    const saved = { style: "bottts" as const, seed: "abc" };
    const { rerender } = renderWithLocale(
      <AvatarCustomizer
        mode="edit"
        phase="LOBBY"
        sessionId={SESSION}
        pinCode={PIN}
        nickname="Neko"
        avatar={saved}
        socket={socket}
        onSaved={onSaved}
        audio={fakeAudio()}
      />,
      { namespaces: [...NAMESPACES] },
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Neko")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Pixel Art" }));
    await user.click(screen.getByRole("button", { name: "Save avatar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That didn't work, but your nickname and avatar have been kept.",
    );
    expect(screen.getByRole("radio", { name: "Bottts" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Pixel Art" }));
    await user.click(screen.getByRole("button", { name: "Save avatar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ style: "pixel-art", seed: "abc" }));
    expect(calls[1]?.payload).toMatchObject({
      sessionId: SESSION,
      pinCode: PIN,
      avatar: { style: "pixel-art", seed: "abc" },
    });
    expect(calls[1]?.payload).not.toHaveProperty("nickname");

    rerender(
      <AvatarCustomizer
        mode="edit"
        phase="QUESTION_ANSWERING"
        sessionId={SESSION}
        pinCode={PIN}
        nickname="Neko"
        avatar={saved}
        socket={socket}
        onSaved={onSaved}
        audio={fakeAudio()}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "This can't be done at this point in the game.",
    );
    expect(screen.getByRole("radio", { name: "Lorelei" })).toBeDisabled();
    const save = screen.getByRole("button", { name: "Save avatar" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await user.click(save);
    expect(calls).toHaveLength(2);
  });
});
