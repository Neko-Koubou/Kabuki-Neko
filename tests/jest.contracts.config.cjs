const path = require("node:path");

/** @type {import('jest').Config} */
module.exports = {
  rootDir: path.resolve(__dirname, ".."),
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/contracts/**/*.spec.ts"],
  modulePathIgnorePatterns: ["/\\.next/", "/dist/", "/coverage/"],
  // First MinIO fixture compiles pinned upstream source; subsequent runs use Docker cache.
  testTimeout: 600000,
  maxWorkers: 2,
  clearMocks: true,
  restoreMocks: true,
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          target: "ES2023",
          module: "CommonJS",
          moduleResolution: "Node",
          paths: {
            "@kabuki-neko/shared/*": [path.resolve(__dirname, "../packages/shared/dist/*")],
          },
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          types: ["node", "jest"],
          lib: ["ES2023"],
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@kabuki-neko/shared$": "<rootDir>/packages/shared/dist/index.js",
    "^@kabuki-neko/shared/(.*)$": "<rootDir>/packages/shared/dist/$1.js",
    "^@kabuki-neko/database$": "<rootDir>/packages/database/dist/index.js",
    "^@kabuki-neko/database/(.*)$": "<rootDir>/packages/database/dist/$1.js",
  },
};
