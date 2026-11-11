import { extractMentions, notifiesAnyone } from "../src/mentions";

describe("notifiesAnyone", () => {
  it("is true for a comment from someone other than the author", () => {
    expect(
      notifiesAnyone({ commenter: "bob", author: "alice", body: "looks off", isBot: false })
    ).toBe(true);
  });

  it("is false for the author's own comment that mentions nobody", () => {
    expect(
      notifiesAnyone({ commenter: "alice", author: "alice", body: "pushed a fix", isBot: false })
    ).toBe(false);
  });

  it("is true for the author's own comment that mentions someone", () => {
    expect(
      notifiesAnyone({ commenter: "alice", author: "alice", body: "@bob fixed", isBot: false })
    ).toBe(true);
  });

  it("is false for a bot, even when it mentions someone", () => {
    expect(
      notifiesAnyone({ commenter: "bugbot", author: "alice", body: "@alice", isBot: true })
    ).toBe(false);
  });

  it("is false for the author's own comment with no body", () => {
    expect(notifiesAnyone({ commenter: "alice", author: "alice", body: null, isBot: false })).toBe(
      false
    );
  });
});

describe("extractMentions", () => {
  it("returns the logins mentioned in the text, in order", () => {
    expect(extractMentions("@alice can you check this? cc @bob-smith")).toEqual([
      "alice",
      "bob-smith",
    ]);
  });

  it("returns each login once, whatever its case", () => {
    expect(extractMentions("@Alice, @alice and @ALICE")).toEqual(["Alice"]);
  });

  it("ignores a mention at the end of a sentence's punctuation", () => {
    expect(extractMentions("Thanks, @alice.")).toEqual(["alice"]);
  });

  it("returns nothing for an empty or missing body", () => {
    expect(extractMentions("")).toEqual([]);
    expect(extractMentions(undefined)).toEqual([]);
    expect(extractMentions(null)).toEqual([]);
  });

  it("ignores an email address", () => {
    expect(extractMentions("write to dev@example.com")).toEqual([]);
  });

  it("ignores a team mention", () => {
    expect(extractMentions("@datarobot/labs please look")).toEqual([]);
  });

  it("ignores mentions in inline code and fenced code blocks", () => {
    const body = "Use `@alice` here\n```\n@bob\n```\nbut ask @carol";

    expect(extractMentions(body)).toEqual(["carol"]);
  });

  it("ignores mentions in quoted lines", () => {
    expect(extractMentions("> @alice said so\n@bob agrees")).toEqual(["bob"]);
  });

  it("ignores mentions inside HTML comments", () => {
    expect(extractMentions("<!-- @alice -->\n@bob")).toEqual(["bob"]);
  });

  it("ignores an at sign with no login after it", () => {
    expect(extractMentions("look @ this, and @-bad")).toEqual([]);
  });
});
