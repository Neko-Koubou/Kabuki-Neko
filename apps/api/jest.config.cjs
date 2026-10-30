/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.spec.ts"],
  clearMocks: true,
  restoreMocks: true,
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  moduleNameMapper: {
    "^@kabuki-neko/shared$": "<rootDir>/../../packages/shared/dist/index.js",
    "^@kabuki-neko/shared/(.*)$": "<rootDir>/../../packages/shared/dist/$1.js",
    "^@kabuki-neko/database$": "<rootDir>/../../packages/database/dist/index.js",
    "^@kabuki-neko/database/(.*)$": "<rootDir>/../../packages/database/dist/$1.js",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.spec.ts", "!src/main.ts"],
};
