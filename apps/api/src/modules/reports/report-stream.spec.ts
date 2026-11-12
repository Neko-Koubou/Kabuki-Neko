/**
 * CSV download streaming (code review MJ-14): a client that disconnects mid-download must not
 * leave the export handler waiting forever for `drain`; a normal download writes every chunk
 * and ends the response.
 */
import { Writable } from "node:stream";
import { streamChunks } from "./reports.controller";

/** Writable that accepts `limit` bytes per tick and records what it received. */
function sink(highWaterMark = 16) {
  const received: string[] = [];
  const stream = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, callback) {
      received.push(chunk.toString());
      setImmediate(callback);
    },
  });
  return { stream, received };
}

it("writes every chunk with backpressure and ends the response", async () => {
  const chunks = Array.from({ length: 50 }, (_, index) => `row-${index},value\r\n`);
  const { stream, received } = sink(8);
  await streamChunks(chunks, stream);
  expect(received.join("")).toBe(chunks.join(""));
  expect(stream.writableFinished).toBe(true);
});

it("settles instead of hanging when the client disconnects mid-download", async () => {
  // A response that stops reading after the first chunk and then closes (client abort).
  const stalled = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      // never acknowledges: the buffer stays full, so `drain` never fires
    },
  });
  const chunks = Array.from({ length: 1000 }, () => "x".repeat(1024));
  const done = streamChunks(chunks, stalled);
  setTimeout(() => stalled.destroy(), 10);
  await expect(
    Promise.race([
      done.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]),
  ).resolves.toBe("settled");
  expect(stalled.destroyed).toBe(true);
});
