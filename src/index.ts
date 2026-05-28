/**
 * @watney/shared — top-level barrel.
 *
 * Prefer sub-path imports for tree-shaking and explicit dependency hygiene:
 *
 *   import { logLlmUsage } from '@watney/shared/llm-usage';
 *   import { createLogger } from '@watney/shared/logger';
 *
 * This barrel re-exports the most commonly used items so a single import
 * surface is also available.
 */
export * from './supabase';
export * from './llm-usage';
export * from './outcomes';
export * from './logger';
export * from './zod-helpers';
export * from './prompts';
export * from './errors';
export * from './credentials';
export * from './smoke-test';
