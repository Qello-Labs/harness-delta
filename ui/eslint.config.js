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
// Keep existing functions bounded while new files use 150 normalized lines.
const functionLineLimits = {
  'src/AgentConnectionSetup.tsx': 320,
  'src/App.tsx': 1612,
  'src/ClaudeConnection.tsx': 310,
  'src/GettingStarted.tsx': 350,
  'src/GuidedSetup.tsx': 798,
  'src/HarnessApplication.tsx': 563,
  'src/MeasurementReview.tsx': 171,
  'src/OrdinaryObservationSetup.tsx': 233,
  'src/SupportGuidance.tsx': 210
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
  {
    rules: {
      complexity: ['error', 30],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true, IIFEs: true }]
    }
  },
  ...Object.entries(complexityLimits).map(([file, maximum]) => ({ files: [file], rules: { complexity: ['error', maximum] } })),
  ...Object.entries(functionLineLimits).map(([file, maximum]) => ({
    files: [file],
    rules: { 'max-lines-per-function': ['error', { max: maximum, skipBlankLines: true, skipComments: true, IIFEs: true }] }
  })),
  {
    files: ['src/components/ui/**'],
    rules: {
      complexity: 'off',
      'max-lines-per-function': 'off',
      'shadcn/no-arbitrary-values': 'off',
      'shadcn/no-raw-colors': 'off',
      'shadcn/no-restyle': 'off',
      'shadcn/no-inline-styles': 'off'
    }
  }
);
