import { describe, expect, it } from "bun:test";
import {
  DamageTag,
  HealTag,
  IncreaseStatTag,
  JutsuValidatorRawSchema,
  questStartingEffectsSchema,
  VisualTag,
} from "@/validators/combat";

describe("effect area variation", () => {
  it("leaves existing effects identical on every tile", () => {
    for (const schema of [DamageTag, HealTag, VisualTag]) {
      expect(schema.parse({})).toMatchObject({
        animationMirror: false,
        animationStagger: 0,
        animationRipple: 0,
        animationAlternate: "",
      });
    }
  });
  it("accepts mirroring, whole-millisecond stagger up to a second and an alternate clip", () => {
    const tag = DamageTag.parse({
      animationMirror: true,
      animationStagger: "250",
      animationAlternate: "alternate-clip",
    });
    expect(tag).toMatchObject({
      animationMirror: true,
      animationStagger: 250,
      animationAlternate: "alternate-clip",
    });
    expect(DamageTag.parse({ animationStagger: 1000 }).animationStagger).toBe(1000);
  });
  it("accepts a whole-millisecond ripple of up to 300 ms per hex", () => {
    expect(DamageTag.parse({ animationRipple: "120" }).animationRipple).toBe(120);
    expect(DamageTag.parse({ animationRipple: 300 }).animationRipple).toBe(300);
    for (const animationRipple of [-1, 301, 2.5, "invalid"])
      expect(DamageTag.safeParse({ animationRipple }).success).toBe(false);
  });
  it.each([-1, 1001, 12.5, Number.NaN, "invalid"])(
    "rejects stagger %s",
    (animationStagger) => {
      expect(DamageTag.safeParse({ animationStagger }).success).toBe(false);
    },
  );
  it("requires an appear animation for the alternate to stand in for", () => {
    const effects = JutsuValidatorRawSchema.shape.effects;
    const chosen = DamageTag.parse({
      appearAnimation: "base",
      animationAlternate: "alternate",
    });
    expect(effects.safeParse([chosen]).success).toBe(true);
    const cleared = effects.safeParse([{ ...chosen, appearAnimation: "" }]);
    expect(cleared.success).toBe(false);
    expect(cleared.error?.issues.map((issue) => issue.path)).toContainEqual([
      0,
      "animationAlternate",
    ]);
  });
  it("requires an appear animation for an alternate on quest starting effects", () => {
    const schema = questStartingEffectsSchema(["increasestat"]);
    const orphan = IncreaseStatTag.parse({
      rounds: 2,
      animationAlternate: "alternate",
    });
    const result = schema.safeParse([orphan]);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([
      0,
      "animationAlternate",
    ]);
    expect(schema.safeParse([{ ...orphan, appearAnimation: "base" }]).success).toBe(
      true,
    );
  });
});
