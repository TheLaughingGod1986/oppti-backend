#!/usr/bin/env node
/**
 * Setup Test License
 *
 * This script:
 * 1. Checks if the licenses table exists
 * 2. Creates a test license if needed
 * 3. Outputs the license key for use in WordPress plugin
 */

require('dotenv').config({ path: '.env.local' });
const { supabase } = require('../db/supabase-client');

const TEST_LICENSE_KEY = '24c93235-1053-4922-b337-9866aeb76dcc';
const TEST_EMAIL = 'test@example.com';

async function main() {
  console.log('🔍 Checking Supabase database...\n');

  // Check if licenses table exists
  try {
    const { data: tables, error: tableError } = await supabase
      .from('licenses')
      .select('license_key')
      .limit(1);

    if (tableError) {
      if (tableError.code === '42P01' || tableError.message.includes('does not exist')) {
        console.error('❌ ERROR: licenses table does not exist!\n');
        console.log('📋 You need to run the database migration first:');
        console.log('   1. Go to Supabase Dashboard → SQL Editor');
        console.log('   2. Run the migration from: docs/DATABASE_SCHEMA.md\n');
        console.log('   Or create a minimal licenses table:');
        console.log(`
CREATE TABLE licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  plan VARCHAR(50) NOT NULL DEFAULT 'free',
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  billing_anchor_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  billing_cycle VARCHAR(50) DEFAULT 'monthly',
  max_sites INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT chk_plan CHECK (plan IN ('free', 'pro', 'agency')),
  CONSTRAINT chk_status CHECK (status IN ('active', 'expired', 'suspended', 'cancelled'))
);

CREATE INDEX idx_licenses_license_key ON licenses(license_key);
CREATE INDEX idx_licenses_email ON licenses(email);
        `);
        process.exit(1);
      }
      throw tableError;
    }

    console.log('✅ licenses table exists\n');

    // Check if test license exists
    const { data: existingLicense, error: checkError } = await supabase
      .from('licenses')
      .select('*')
      .eq('license_key', TEST_LICENSE_KEY)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      // PGRST116 = not found, which is expected
      throw checkError;
    }

    if (existingLicense) {
      console.log('✅ Test license already exists:');
      console.log(`   License Key: ${existingLicense.license_key}`);
      console.log(`   Email: ${existingLicense.email}`);
      console.log(`   Plan: ${existingLicense.plan}`);
      console.log(`   Status: ${existingLicense.status}\n`);
    } else {
      // Create test license
      console.log('📝 Creating test license...\n');

      const { data: newLicense, error: insertError } = await supabase
        .from('licenses')
        .insert({
          license_key: TEST_LICENSE_KEY,
          email: TEST_EMAIL,
          plan: 'pro',
          status: 'active',
          max_sites: 1,
          billing_anchor_date: new Date().toISOString()
        })
        .select()
        .single();

      if (insertError) {
        throw insertError;
      }

      console.log('✅ Test license created successfully:');
      console.log(`   License Key: ${newLicense.license_key}`);
      console.log(`   Email: ${newLicense.email}`);
      console.log(`   Plan: ${newLicense.plan}`);
      console.log(`   Status: ${newLicense.status}\n`);
    }

    // Instructions for WordPress
    console.log('📋 NEXT STEPS:\n');
    console.log('1. Copy this license key:');
    console.log(`   ${TEST_LICENSE_KEY}\n`);
    console.log('2. In WordPress admin, go to plugin settings');
    console.log('3. Paste the license key and click "Activate"\n');
    console.log('4. Verify it works:');
    console.log(`   curl -H "X-License-Key: ${TEST_LICENSE_KEY}" \\`);
    console.log(`     https://alttext-ai-backend.onrender.com/health\n`);

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    if (error.details) {
      console.error('   Details:', error.details);
    }
    if (error.hint) {
      console.error('   Hint:', error.hint);
    }
    process.exit(1);
  }
}

main();
