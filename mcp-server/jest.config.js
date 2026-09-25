module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    // jose v6 (SC-1227 JWT verifier) is ESM-only: ts-jest compiles it down to
    // CJS for this suite. The transformIgnorePatterns below is what lets ONLY
    // jose through — everything else in node_modules stays untransformed.
    '^.+\\.js$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          module: 'commonjs',
          target: 'ES2022',
          esModuleInterop: true,
        },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/\\.pnpm/(?!jose@)'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60,
    },
  },
};
