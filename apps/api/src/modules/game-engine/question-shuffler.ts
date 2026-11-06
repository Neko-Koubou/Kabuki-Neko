import { randomInt, randomUUID } from "node:crypto";
import type { Question } from "@kabuki-neko/shared/schemas/question.schema";
import type { z } from "zod";
import type { publicOptionSchema } from "@kabuki-neko/shared/schemas/game.schema";

/** Server-private mapping; only publicOptions may be projected before reveal. */
export function shuffleQuestion(question: Question, draw: (max: number) => number = randomInt) {
  const options = question.type === "TYPE_ANSWER" ? [] : [...question.options];
  if (question.type === "ORDER_PUZZLE") {
    for (let i = options.length - 1; i > 0; i--) {
      const j = draw(i + 1);
      if (!Number.isInteger(j) || j < 0 || j > i) throw new Error("Invalid shuffle draw");
      const left = options[i],
        right = options[j];
      if (!left || !right) throw new Error("Invalid shuffle index");
      options[i] = right;
      options[j] = left;
    }
  }
  const publicOptions: z.infer<typeof publicOptionSchema>[] = options.map((option, index) => ({
    id: randomUUID(),
    index,
    colorIndex: index,
    text: option.optionText,
  }));
  return { publicOptions, publicToPrivateOptionIds: options.map((option) => option.id) };
}
