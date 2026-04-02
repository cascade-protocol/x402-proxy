import { describe, expect, it } from "vitest";
import { parseMnemonicImport } from "./commands.js";

const VALID_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VALID_24 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("parseMnemonicImport", () => {
  it("accepts valid 12-word mnemonic as bare words", () => {
    const result = parseMnemonicImport(VALID_12.split(" "));
    expect(result).toEqual({ mnemonic: VALID_12 });
  });

  it("accepts valid 24-word mnemonic as bare words", () => {
    const result = parseMnemonicImport(VALID_24.split(" "));
    expect(result).toEqual({ mnemonic: VALID_24 });
  });

  it("strips surrounding double quotes (Telegram copy-paste)", () => {
    const result = parseMnemonicImport([`"${VALID_12}"`]);
    expect(result).toEqual({ mnemonic: VALID_12 });
  });

  it("strips surrounding single quotes", () => {
    const result = parseMnemonicImport([`'${VALID_12}'`]);
    expect(result).toEqual({ mnemonic: VALID_12 });
  });

  it("strips surrounding smart quotes", () => {
    const result = parseMnemonicImport([`\u201C${VALID_12}\u201D`]);
    expect(result).toEqual({ mnemonic: VALID_12 });
  });

  it("handles quoted mnemonic split across args by Telegram", () => {
    // Telegram may split: ['"abandon', 'abandon', ..., 'about"']
    const words = VALID_12.split(" ");
    words[0] = `"${words[0]}`;
    words[words.length - 1] = `${words[words.length - 1]}"`;
    const result = parseMnemonicImport(words);
    expect(result).toEqual({ mnemonic: VALID_12 });
  });

  it("rejects wrong word count with count in error", () => {
    const result = parseMnemonicImport("one two three four five six seven eight".split(" "));
    expect("error" in result && result.error).toContain("got 8");
  });

  it("rejects 16-word input", () => {
    const sixteenWords = VALID_24.split(" ").slice(0, 16);
    const result = parseMnemonicImport(sixteenWords);
    expect("error" in result && result.error).toContain("got 16");
  });

  it("rejects invalid BIP-39 words with correct count", () => {
    const invalid =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzz";
    const result = parseMnemonicImport(invalid.split(" "));
    expect("error" in result && result.error).toContain("Invalid BIP-39");
  });

  it("rejects empty input", () => {
    const result = parseMnemonicImport([]);
    expect("error" in result && result.error).toContain("got 0");
  });
});
