/** Design §2.2. Render shapes with SVG, and keep these solid color pairs. */
export const ANSWER_GEOMETRY = [
  { index: 0, label: "A", shape: "triangle", background: "#E21B3C", foreground: "#FFFFFF" },
  { index: 1, label: "B", shape: "diamond", background: "#1368CE", foreground: "#FFFFFF" },
  { index: 2, label: "C", shape: "circle", background: "#D89E00", foreground: "#18181B" },
  { index: 3, label: "D", shape: "square", background: "#26890C", foreground: "#FFFFFF" },
] as const;
export type AnswerGeometry = (typeof ANSWER_GEOMETRY)[number];
