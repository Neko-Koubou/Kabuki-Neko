import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import { builtinModules } from "node:module";

const builtinImportPattern = builtinModules.map((name) => name.replaceAll("/", "\\/")).join("|");

const serverImports = [
  "@kabuki-neko/api",
  "@kabuki-neko/api/**",
  "@kabuki-neko/database",
  "@kabuki-neko/database/**",
  "@nestjs/**",
  "@aws-sdk/**",
  "typeorm",
  "typeorm/**",
  "better-sqlite3",
  "pg",
  "mysql2",
  "mysql2/**",
  "ioredis",
  "sharp",
  "**/apps/api/**",
  "**/packages/database/**",
];

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/next-env.d.ts",
      "**/locales-built/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.strict],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-debugger": "error",
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/shared/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules,
          patterns: [
            {
              group: [...serverImports, "node:*"],
              message:
                "Browser/shared code must not depend on server implementations or Node builtins.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: "Use literal dynamic import paths so module boundaries can be checked.",
        },
        {
          selector: `ImportExpression[source.value=/^(node:|@kabuki-neko\\/(api|database)|@nestjs\\/|@aws-sdk\\/|typeorm|better-sqlite3|pg$|mysql2|ioredis|sharp|(?:${builtinImportPattern})$)/]`,
          message: "Server modules cannot be dynamically imported into browser/shared code.",
        },
      ],
    },
  },
  {
    // Server-only web modules (`*.server.ts`, imported by server components only) may use Node
    // builtins, but never the API/database implementations.
    files: ["apps/web/src/**/*.server.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: serverImports,
              message: "Web server modules must not depend on API/database implementations.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/shared/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules,
          patterns: [
            {
              group: [
                ...serverImports,
                "node:*",
                "@kabuki-neko/web",
                "@kabuki-neko/web/**",
                "**/apps/web/**",
              ],
              message:
                "Shared contracts must remain independent of application and server modules.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
