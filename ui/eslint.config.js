import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { plugin as shadcn } from '@shadcn/lint';
// Lower these limits as existing functions shrink; new files use 30.
const complexityLimits = {
  'src/AgentConnectionSetup.tsx': 42,
  'src/App.tsx': 170,
  'src/ClaudeConnection.tsx': 73,
  'src/GuidedSetup.tsx': 98,
  'src/HarnessApplication.tsx': 85
};
export default tseslint.config(
  { ignores: ['node_modules/**', '../dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    plugins: { shadcn },
    settings: { shadcn: { ui: '@/components/ui', note: 'Use the semantic theme and component variants; show actionable blockers outside details.' } },
    rules: {
      'shadcn/no-arbitrary-values': 'error',
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-inline-styles': 'error',
      'shadcn/no-restyle': [
        'error',
        {
          allow: ['layout'],
          contracts: [
            { pattern: '^CardContent$', allow: ['layout', 'spacing'] },
            { pattern: '^TooltipContent$', allow: ['layout'] }
          ]
        }
      ],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  { rules: { complexity: ['error', 30] } },
  ...Object.entries(complexityLimits).map(([file, maximum]) => ({ files: [file], rules: { complexity: ['error', maximum] } })),
  {
    files: ['src/components/ui/**'],
    rules: {
      complexity: 'off',
      'shadcn/no-arbitrary-values': 'off',
      'shadcn/no-raw-colors': 'off',
      'shadcn/no-restyle': 'off',
      'shadcn/no-inline-styles': 'off'
    }
  }
);
