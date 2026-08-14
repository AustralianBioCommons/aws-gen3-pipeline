module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // TypeScript FIRST. This is a TS-only repo, but `tsc` emits next to source
  // (no outDir), and both `npm run build` and scripts/integration_test.sh
  // produce those .js files. Jest's default order resolves .js before .ts, so
  // a stale build artifact would shadow the source it came from and the suite
  // would quietly grade a previous version of the code.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
