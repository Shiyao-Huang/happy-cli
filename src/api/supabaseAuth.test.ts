import { describe, expect, it } from 'vitest';

import {
    isLikelySupabaseAnonKey,
    resolveSupabaseAnonKey,
    resolveSupabaseUrl,
    SUPABASE_ANON_KEY_ENV_NAME,
    SUPABASE_URL_ENV_NAME,
} from './supabaseAuth';

describe('supabaseAuth config', () => {
    it('requires the env URL when it is missing or blank', () => {
        expect(() => resolveSupabaseUrl()).toThrow(`Missing required ${SUPABASE_URL_ENV_NAME}`);
        expect(() => resolveSupabaseUrl('   ')).toThrow(`Missing required ${SUPABASE_URL_ENV_NAME}`);
    });

    it('uses the env URL when it is provided', () => {
        expect(resolveSupabaseUrl('https://example.supabase.co')).toBe('https://example.supabase.co');
    });

    it('recognizes JWT-like anon keys', () => {
        expect(isLikelySupabaseAnonKey('header.payload.signature')).toBe(true);
        expect(isLikelySupabaseAnonKey('header.payload...REDACTED')).toBe(false);
    });

    it('requires the env anon key when it is missing or blank', () => {
        expect(() => resolveSupabaseAnonKey()).toThrow(`Missing required ${SUPABASE_ANON_KEY_ENV_NAME}`);
        expect(() => resolveSupabaseAnonKey('   ')).toThrow(`Missing required ${SUPABASE_ANON_KEY_ENV_NAME}`);
    });

    it('rejects redacted or invalid anon keys', () => {
        expect(() => resolveSupabaseAnonKey('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmR0Z...REDACTED'))
            .toThrow(`Invalid ${SUPABASE_ANON_KEY_ENV_NAME}`);
    });

    it('uses the env anon key when it looks valid', () => {
        const envKey = 'header.payload.signature';
        expect(resolveSupabaseAnonKey(envKey)).toBe(envKey);
    });
});
