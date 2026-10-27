import { describe, expect, it } from "vitest";
import { getLandingRewards } from "./rewardPresentation";

describe("landing reward presentation", () => {
  it("hides Shorts from the landing presentation without removing catalog records", () => {
    const catalog = [{ id: "reward-one" }, { id: "youtube-shorts", contentType: "youtube_short" }];
    expect(getLandingRewards(catalog)).toEqual([{ id: "reward-one" }]);
    expect(catalog).toHaveLength(2);
  });
});
