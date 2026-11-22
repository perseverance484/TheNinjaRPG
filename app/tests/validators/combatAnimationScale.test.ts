import { describe, expect, it } from "bun:test";
import {
  DamageTag,
  HealTag,
  JutsuValidatorRawSchema,
  MAX_SELF_VISUAL_SCALE,
  questStartingEffectsSchema,
  VisualTag,
} from "@/validators/combat";

describe("effect animation scale", () => {
  it("defaults existing effects to normal size and accepts fractional sizing", () => {
    for (const schema of [DamageTag, HealTag, VisualTag]) {
      expect(schema.parse({}).animationScale).toBe(1);
      for (const animationScale of [1, 1.01, 1.375, 2.5, 2.999, 3]) {
        expect(schema.parse({ animationScale }).animationScale).toBe(animationScale);
        expect(
          schema.parse({ animationScale: String(animationScale) }).animationScale,
        ).toBe(animationScale);
      }
    }
  });
  it.each([0, -1, 0.99, 3.01, 5.1, Number.NaN, Number.POSITIVE_INFINITY, "invalid"])(
    "rejects invalid sizing %s",
    (animationScale) => {
      expect(DamageTag.safeParse({ animationScale }).success).toBe(false);
    },
  );
  it("lets only a visual on the user grow past tile size, up to the whole area", () => {
    const effects = JutsuValidatorRawSchema.shape.effects;
    const onUser = VisualTag.parse({ target: "SELF", animationScale: 13 });
    expect(onUser.animationScale).toBe(13);
    expect(effects.safeParse([onUser]).success).toBe(true);
    const everyTile = effects.safeParse([{ ...onUser, target: "INHERIT" }]);
    expect(everyTile.success).toBe(false);
    expect(everyTile.error?.issues.map((issue) => issue.path)).toContainEqual([
      0,
      "animationScale",
    ]);
    expect(effects.safeParse([{ ...onUser, animationScale: 3 }]).success).toBe(true);
    expect(VisualTag.safeParse({ animationScale: MAX_SELF_VISUAL_SCALE }).success).toBe(
      true,
    );
    expect(
      VisualTag.safeParse({ animationScale: MAX_SELF_VISUAL_SCALE + 0.01 }).success,
    ).toBe(false);
    expect(DamageTag.safeParse({ target: "SELF", animationScale: 13 }).success).toBe(
      false,
    );
  });
  it("applies the same rule to quest starting effects", () => {
    const schema = questStartingEffectsSchema(["visual"]);
    const big = VisualTag.parse({ rounds: 1, target: "SELF", animationScale: 10 });
    expect(schema.safeParse([big]).success).toBe(true);
    expect(schema.safeParse([{ ...big, target: "INHERIT" }]).success).toBe(false);
  });
});
