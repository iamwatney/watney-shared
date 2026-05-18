/**
 * Vendor adapter registry. Each adapter declares its capabilities and
 * implements the VendorAdapter contract from ../types.
 *
 * Look up an adapter by uppercase canonical vendor name (the second
 * segment of <SCOPE>_<VENDOR>_<PURPOSE>).
 */
import type { Vendor, VendorAdapter } from '../types';
import { anthropicAdapter } from './anthropic';
import { githubAdapter } from './github';
import { supabaseAdapter } from './supabase';
import { gcpAdapter } from './gcp';
import { vercelAdapter } from './vercel';
import { stripeAdapter } from './stripe';
import { cloudflareAdapter } from './cloudflare';
import { tavilyAdapter } from './tavily';
import { openaiAdapter } from './openai';

const ADAPTERS: Record<string, VendorAdapter> = {
  ANTHROPIC: anthropicAdapter,
  GITHUB: githubAdapter,
  SUPABASE: supabaseAdapter,
  GCP: gcpAdapter,
  VERCEL: vercelAdapter,
  STRIPE: stripeAdapter,
  CLOUDFLARE: cloudflareAdapter,
  TAVILY: tavilyAdapter,
  OPENAI: openaiAdapter,
};

export function getVendorAdapter(vendor: Vendor): VendorAdapter | null {
  return ADAPTERS[vendor.toUpperCase()] ?? null;
}

export function listSupportedVendors(): Vendor[] {
  return Object.keys(ADAPTERS) as Vendor[];
}

export {
  anthropicAdapter,
  githubAdapter,
  supabaseAdapter,
  gcpAdapter,
  vercelAdapter,
  stripeAdapter,
  cloudflareAdapter,
  tavilyAdapter,
  openaiAdapter,
};
