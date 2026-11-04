/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  assetsInclude: ['**/*.glsl'],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
