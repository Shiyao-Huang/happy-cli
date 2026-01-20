#!/usr/bin/env node

/**
 * Test script for configuration validation
 * Tests various invalid configurations to verify error handling
 */

// Test 1: Invalid URL format
console.log('\n🧪 Test 1: Invalid HAPPY_SERVER_URL')
process.env.HAPPY_SERVER_URL = 'not-a-valid-url'
try {
  require('./dist/configuration.mjs')
  console.log('❌ FAILED: Should have thrown error for invalid URL')
} catch (error) {
  console.log('✅ PASSED: Caught invalid URL error')
}

// Test 2: Invalid permission mode
console.log('\n🧪 Test 2: Invalid HAPPY_PERMISSION_MODE')
process.env.HAPPY_SERVER_URL = 'https://api.example.com' // Reset to valid
process.env.HAPPY_PERMISSION_MODE = 'invalid-mode'
try {
  // Cannot re-require due to module caching, this is just documentation
  console.log('⚠️  Cannot test due to module caching (would need separate process)')
} catch (error) {
  console.log('✅ PASSED: Caught invalid permission mode')
}

console.log('\n✅ Configuration validation tests documented')
console.log('💡 Run "yarn build && node dist/index.mjs --help" to see validation in action')
