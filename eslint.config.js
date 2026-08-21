const js = require('@eslint/js')

module.exports = [
  { ignores: ['node_modules/**', 'benchmarks/results/**', 'benchmarks/locomo/locomo*.json', '.cursor/**', '.commandcode/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable'
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ['error', 'smart'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-throw-literal': 'error'
    }
  },
  {
    files: ['tests/**/*.js', 'benchmarks/**/*.js'],
    rules: {
      'no-unused-vars': 'off'
    }
  }
]
