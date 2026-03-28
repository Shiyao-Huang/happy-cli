import eslintConfigPrettier from 'eslint-config-prettier';

export default [
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
        },
        rules: {
            'no-console': 'warn',
            'no-debugger': 'error',
            'no-duplicate-imports': 'error',
            'no-template-curly-in-string': 'warn',
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    eslintConfigPrettier,
];
