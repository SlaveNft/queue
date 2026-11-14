import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { sha256Bytes, sha256Hex } from "../src/sha256.js";

const node = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("sha256", () => {
  it("matches the FIPS 180-4 vectors", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches node:crypto around every block boundary", () => {
    for (let length = 0; length <= 200; length += 1) {
      const text = "q".repeat(length);
      assert.equal(sha256Hex(text), node(text), `length ${length}`);
    }
  });

  it("matches node:crypto on multi-byte text", () => {
    for (const text of ["§ 12 — «очередь»", "𝒬𝓊ℯ𝓊ℯ 🚦", "a\u0000b", "line\r\nline\n"]) {
      assert.equal(sha256Hex(text), node(text));
    }
  });

  it("matches node:crypto on 500 random byte strings", () => {
    for (let i = 0; i < 500; i += 1) {
      const bytes = randomBytes(Math.floor(Math.random() * 4096));
      const expected = createHash("sha256").update(bytes).digest("hex");
      assert.equal(Buffer.from(sha256Bytes(bytes)).toString("hex"), expected);
    }
  });
});
