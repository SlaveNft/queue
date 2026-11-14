import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unsafeBindReason } from "../src/config.js";

describe("production bind policy", () => {
  it("refuses a public write API without an operator token", () => {
    const reason = unsafeBindReason({
      nodeEnv: "production",
      host: "0.0.0.0",
      operatorToken: "",
      readOnly: false,
    });
    assert.match(reason ?? "", /QUEUE_OPERATOR_TOKEN/);
  });

  it("allows loopback, read-only, and token-guarded binds", () => {
    assert.equal(
      unsafeBindReason({
        nodeEnv: "production",
        host: "127.0.0.1",
        operatorToken: "",
        readOnly: false,
      }),
      null,
    );
    assert.equal(
      unsafeBindReason({
        nodeEnv: "production",
        host: "0.0.0.0",
        operatorToken: "",
        readOnly: true,
      }),
      null,
    );
    assert.equal(
      unsafeBindReason({
        nodeEnv: "production",
        host: "0.0.0.0",
        operatorToken: "secret-token",
        readOnly: false,
      }),
      null,
    );
    assert.equal(
      unsafeBindReason({
        nodeEnv: "development",
        host: "0.0.0.0",
        operatorToken: "",
        readOnly: false,
      }),
      null,
    );
  });
});
