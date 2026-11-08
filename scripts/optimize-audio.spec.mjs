/**
 * TASK-114 tests for scripts/optimize-audio.mjs (`node --test scripts/optimize-audio.spec.mjs`).
 *
 * Synthetic MP3 fixtures (sine tones generated with ffmpeg) exercise: 3, 4 and N lobby tracks with
 * known and fallback labels/volumes; strict source scanning (missing cue, empty lobby, unsafe and
 * colliding names, symlinks, unexpected files) before any encoding; a corrupt source and an
 * encoder failure that both leave the previously published output untouched with no staging
 * leftovers; stale-entry cleanup on re-run; clear missing-prerequisite errors; untouched sources;
 * loudnorm only on BGM; and shared-schema validation of the generated manifest.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { audioManifestSchema } from "../packages/shared/dist/schemas/audio.schema.js";
import { encoderArgs, LOUDNORM, optimizeAudio, scanSources } from "./optimize-audio.mjs";

const run = promisify(execFile);
const BGM = {
  "02-thinking": ["bgm-think-sprint", "bgm-think-standard", "bgm-think-puzzle"],
  "03-leaderboard": ["bgm-leaderboard-groove"],
  "04-podium": ["bgm-podium-buildup", "bgm-podium-victory"],
};
const SFX = [
  "sfx-hyoshigi-start",
  "sfx-neko-pop",
  "sfx-question-whoosh",
  "sfx-tick-last5s",
  "sfx-timeup-gong",
  "sfx-reveal-bar",
  "sfx-answer-correct",
  "sfx-answer-wrong",
  "sfx-streak-fire",
  "sfx-podium-spotlight",
];
let root;
let tone;
let blip;

/** Generates a short MP3 sine tone with ffmpeg. */
async function makeTone(file, seconds, frequency) {
  await run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${seconds}`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    file,
  ]);
}
/** Builds a complete source tree with the given lobby IDs (copies of the generated tones). */
async function sourceTree(name, lobbyIds) {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, "01-lobby"), { recursive: true });
  for (const id of lobbyIds) await cp(tone, path.join(dir, "01-lobby", `bgm-lobby-${id}.mp3`));
  for (const [folder, files] of Object.entries(BGM)) {
    await mkdir(path.join(dir, folder), { recursive: true });
    for (const file of files) await cp(tone, path.join(dir, folder, `${file}.mp3`));
  }
  await mkdir(path.join(dir, "05-sfx"), { recursive: true });
  for (const file of SFX) await cp(blip, path.join(dir, "05-sfx", `${file}.mp3`));
  await writeFile(
    path.join(dir, "CREDITS.md"),
    `# Credits for ${name}\n\nSynthetic test tones — no rights reserved.\n`,
  );
  return dir;
}
/** SHA-256 of every file under a directory, keyed by relative path. */
async function hashes(dir) {
  const result = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(dir, file)] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  }
  return result;
}
/** Names left next to the output (staging/previous directories must not linger). */
async function siblings(out) {
  return (await readdir(path.dirname(out))).filter((name) =>
    name.startsWith(`.${path.basename(out)}.`),
  );
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kabuki-audio-"));
  tone = path.join(root, "tone.mp3");
  blip = path.join(root, "blip.mp3");
  await makeTone(tone, 1.5, 440);
  await makeTone(blip, 0.4, 880);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("optimizeAudio", () => {
  for (const [label, lobby] of [
    ["3", ["kabuki", "matcha", "neko8bit"]],
    ["4", ["kabuki", "matcha", "neko8bit", "showtime"]],
    ["N (6)", ["kabuki", "matcha", "neko8bit", "showtime", "neo-tokyo", "retro"]],
  ]) {
    it(`publishes a valid dual-format set for ${label} lobby tracks`, async () => {
      const source = await sourceTree(`lobby-${lobby.length}`, lobby);
      const before = await hashes(source);
      const out = path.join(root, `out-${lobby.length}`, "audio");
      const summary = await optimizeAudio({ source, out, concurrency: 4 });
      assert.equal(summary.files, lobby.length + 16);
      assert.equal(summary.outputs, (lobby.length + 16) * 2);
      const manifest = JSON.parse(await readFile(path.join(out, "audio-manifest.json"), "utf8"));
      assert.equal(audioManifestSchema.safeParse(manifest).success, true);
      assert.equal("phases" in manifest, false);
      assert.deepEqual(
        manifest.lobby.map((track) => track.id),
        [...lobby].sort(),
      );
      for (const track of manifest.lobby) {
        assert.equal(track.loop, true);
        assert.deepEqual(track.src, [
          `/audio/01-lobby/bgm-lobby-${track.id}.webm`,
          `/audio/01-lobby/bgm-lobby-${track.id}.mp3`,
        ]);
      }
      const byId = Object.fromEntries(manifest.lobby.map((track) => [track.id, track]));
      assert.deepEqual([byId.kabuki.label, byId.kabuki.volume], ["Kabuki Matsuri", 0.7]);
      assert.deepEqual([byId.matcha.label, byId.matcha.volume], ["Matcha Chill Lo-Fi", 0.65]);
      if (byId["neo-tokyo"])
        assert.deepEqual([byId["neo-tokyo"].label, byId["neo-tokyo"].volume], ["Neo Tokyo", 0.7]);
      assert.equal(manifest.podium.victory.volume, 0.9);
      assert.equal(manifest.sfx.nekoPop.throttleMs, 150);
      assert.equal("loop" in manifest.sfx.timeupGong, false);
      // Every manifest source exists and decodes with the expected codec.
      for (const descriptor of [
        ...manifest.lobby,
        ...Object.values(manifest.thinking),
        ...Object.values(manifest.leaderboard),
        ...Object.values(manifest.podium),
        ...Object.values(manifest.sfx),
      ])
        for (const [index, url] of descriptor.src.entries()) {
          const file = path.join(out, url.replace(/^\/audio\//u, ""));
          const { stdout } = await run("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
            file,
          ]);
          assert.equal(stdout.trim(), index === 0 ? "opus" : "mp3");
        }
      assert.deepEqual(
        await readFile(path.join(out, "CREDITS.md")),
        await readFile(path.join(source, "CREDITS.md")),
      );
      assert.deepEqual(await hashes(source), before);
      assert.deepEqual(await siblings(out), []);
    });
  }

  it("removes stale outputs on a re-run", async () => {
    const out = path.join(root, "stale", "audio");
    await optimizeAudio({ source: await sourceTree("stale-a", ["kabuki", "retro"]), out });
    assert.ok((await readdir(path.join(out, "01-lobby"))).includes("bgm-lobby-retro.webm"));
    await optimizeAudio({ source: await sourceTree("stale-b", ["kabuki"]), out });
    assert.deepEqual((await readdir(path.join(out, "01-lobby"))).sort(), [
      "bgm-lobby-kabuki.mp3",
      "bgm-lobby-kabuki.webm",
    ]);
    const manifest = JSON.parse(await readFile(path.join(out, "audio-manifest.json"), "utf8"));
    assert.deepEqual(
      manifest.lobby.map((track) => track.id),
      ["kabuki"],
    );
  });

  it("keeps the previous output when a source is corrupt", async () => {
    const out = path.join(root, "corrupt", "audio");
    await optimizeAudio({ source: await sourceTree("corrupt-good", ["kabuki"]), out });
    const published = await hashes(out);
    const broken = await sourceTree("corrupt-bad", ["kabuki", "matcha"]);
    await writeFile(path.join(broken, "05-sfx", "sfx-neko-pop.mp3"), "not audio at all");
    await assert.rejects(
      optimizeAudio({ source: broken, out }),
      /sfx-neko-pop\.mp3 is not a readable audio file/u,
    );
    assert.deepEqual(await hashes(out), published);
    assert.deepEqual(await siblings(out), []);
  });

  it("rolls back when the encoder fails midway", async () => {
    const out = path.join(root, "encoder", "audio");
    const source = await sourceTree("encoder", ["kabuki"]);
    await optimizeAudio({ source, out });
    const published = await hashes(out);
    // A fake ffmpeg that delegates to the real one but fails the MP3 encode of one cue.
    const fake = path.join(root, "fake-ffmpeg.mjs");
    await writeFile(
      fake,
      [
        "#!/usr/bin/env node",
        'import { spawnSync } from "node:child_process";',
        "const args = process.argv.slice(2);",
        'if (args.some((arg) => arg.endsWith("sfx-streak-fire.mp3")) && args.includes("libmp3lame")) {',
        '  process.stderr.write("simulated encoder crash\\n");',
        "  process.exit(1);",
        "}",
        'const result = spawnSync("ffmpeg", args, { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    await assert.rejects(
      optimizeAudio({ source, out, ffmpeg: fake }),
      /Conversion failed for 05-sfx\/sfx-streak-fire\.mp3 → mp3/u,
    );
    assert.deepEqual(await hashes(out), published);
    assert.deepEqual(await siblings(out), []);
  });

  it("reports missing ffmpeg/ffprobe clearly", async () => {
    const source = await sourceTree("tools", ["kabuki"]);
    await assert.rejects(
      optimizeAudio({
        source,
        out: path.join(root, "tools", "audio"),
        ffmpeg: path.join(root, "no-ffmpeg"),
      }),
      /ffmpeg and ffprobe are required/u,
    );
    await assert.rejects(
      optimizeAudio({
        source,
        out: path.join(root, "tools", "audio"),
        ffprobe: path.join(root, "no-ffprobe"),
      }),
      /ffmpeg and ffprobe are required/u,
    );
  });
});

describe("scanSources", () => {
  it("rejects missing cues and an empty lobby before encoding", async () => {
    const source = await sourceTree("scan-missing", []);
    await rm(path.join(source, "05-sfx", "sfx-timeup-gong.mp3"));
    await assert.rejects(scanSources(source), (error) => {
      assert.match(error.message, /01-lobby\/ needs at least one bgm-lobby-<id>\.mp3 track/u);
      assert.match(error.message, /missing required cue 05-sfx\/sfx-timeup-gong\.mp3/u);
      return true;
    });
  });

  it("rejects unsafe names, collisions, symlinks and unexpected files", async () => {
    const source = await sourceTree("scan-unsafe", ["kabuki"]);
    await cp(tone, path.join(source, "01-lobby", "Bgm-Lobby-Kabuki.mp3"));
    await cp(tone, path.join(source, "01-lobby", "bgm lobby space.mp3"));
    await cp(tone, path.join(source, "01-lobby", "theme.mp3"));
    await cp(tone, path.join(source, "02-thinking", "bgm-think-extra.mp3"));
    await writeFile(path.join(source, "03-leaderboard", "notes.txt"), "x");
    await symlink(tone, path.join(source, "05-sfx", "sfx-extra-link.mp3"));
    await assert.rejects(scanSources(source), (error) => {
      for (const expected of [
        /01-lobby\/Bgm-Lobby-Kabuki\.mp3 has an unsafe name/u,
        /01-lobby\/bgm lobby space\.mp3 has an unsafe name/u,
        /01-lobby\/theme\.mp3 must be named bgm-lobby-<id>\.mp3/u,
        /02-thinking\/bgm-think-extra\.mp3 is not a known cue/u,
        /03-leaderboard\/notes\.txt is not an MP3 source/u,
        /05-sfx\/sfx-extra-link\.mp3 is a symlink/u,
      ])
        assert.match(error.message, expected);
      return true;
    });
  });

  it("rejects a symlinked phase folder", async () => {
    const source = await sourceTree("scan-link", ["kabuki"]);
    const real = path.join(root, "real-sfx");
    await rm(real, { recursive: true, force: true });
    await cp(path.join(source, "05-sfx"), real, { recursive: true });
    await rm(path.join(source, "05-sfx"), { recursive: true });
    await symlink(real, path.join(source, "05-sfx"));
    await assert.rejects(scanSources(source), /05-sfx\/ must be a real directory/u);
  });
});

describe("encoderArgs", () => {
  it("normalizes BGM loudness in both formats and leaves SFX transients alone", () => {
    for (const format of ["webm", "mp3"]) {
      const args = encoderArgs("in.mp3", "out", format, "bgm");
      assert.equal(args[args.indexOf("-af") + 1], LOUDNORM);
      assert.equal(encoderArgs("in.mp3", "out", format, "sfx").includes(LOUDNORM), false);
    }
    assert.ok(
      encoderArgs("in.mp3", "out.webm", "webm", "bgm")
        .join(" ")
        .includes("-c:a libopus -b:a 96k -vbr on"),
    );
    assert.ok(
      encoderArgs("in.mp3", "out.mp3", "mp3", "sfx")
        .join(" ")
        .includes("-c:a libmp3lame -b:a 128k"),
    );
  });
});
