import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig(() => {
  const release = process.env.VERCEL_GIT_COMMIT_SHA || process.env.SENTRY_RELEASE || '';
  const sentryBuildEnabled = Boolean(
    process.env.SENTRY_AUTH_TOKEN
    && process.env.SENTRY_ORG
    && process.env.SENTRY_PROJECT
    && release,
  );

  return {
    define: {
      __MAESTRO_RELEASE__: JSON.stringify(release ? `maestro@${release}` : ''),
    },
    build: {
      sourcemap: sentryBuildEnabled ? 'hidden' : false,
    },
    plugins: [
      react(),
      sentryBuildEnabled
        ? sentryVitePlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: { name: `maestro@${release}` },
            sourcemaps: {
              filesToDeleteAfterUpload: ['./dist/**/*.map'],
            },
            telemetry: false,
          })
        : null,
    ].filter(Boolean),
  };
});
