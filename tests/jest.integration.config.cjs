/** @type {import('jest').Config} */
module.exports = {
  ...require("./jest.contracts.config.cjs"),
  testMatch: ["<rootDir>/tests/integration/**/*.spec.ts"],
};
